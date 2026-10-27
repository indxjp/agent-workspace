/**
 * `POST /api/sessions/:id/attachments` (ADR-0146 D5-D6; issue #1308): a surface visitor's browser
 * token hands one file to its own session, and (issue #1680) the console's signed-in member hands
 * one to a session they may write to. The body is the file's raw bytes and its name is the
 * `name` query parameter; the file lands under `.attachments/<sessionId>/<uploadId>/<name>` and the
 * `201` names the catalogue row to send as `attachments: [{ fileId }]` on `runs.start`. It is saved
 * through the catalog service (the storage design, §04 "Saving a file", "Size limits"): the body
 * streams, and a refusal leaves no row and no object.
 *
 * Every refusal that would reveal how the session is configured is the same concealed `404
 * file_not_found`: a token of another kind, a session the member may not write to, a path id that is
 * not the token's own session (refused earlier, by `decide()`), a surface that does not offer the
 * `attachments` part, and an archived project.
 */
import {
  SURFACE_ATTACHMENT_MAX_BYTES,
  SURFACE_ATTACHMENT_NAME_MAX_BYTES,
  SURFACE_ATTACHMENT_PROBLEM_CODES,
  SURFACE_ATTACHMENTS_MAX_FILES,
  SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES,
  type SurfaceAttachmentResponse,
} from '@indx-workspace/contracts/surfaces';

import { problem, uploadInProgress, type FileResult } from '../../files/handlers';
import {
  boundedBodyStream,
  storageContextOf,
  toResponse,
  tooLarge,
  withCatalogService,
} from '../../files/http';
import { applicationContext } from '../../application-context';
import { mayAccessSession } from '../../rbac/owner-principal';
import type { Principal } from '../../rbac/principal';
import { createProjectRunGate } from '../../projects/archive-gate';
import { requireResourceAccess } from '../../resources/authorise';
import type { StorageContext, StorageService } from '../../storage/service';
import { admitSurfaceVisitorWrite } from './limits';

const notFound = (): FileResult => problem(404, 'file_not_found', 'No file has that id.');

/** A valid attachment name is one path segment: no separator, no control character, no leading dot. */
function validName(name: string | null): name is string {
  if (name === null || name === '' || name.startsWith('.')) return false;
  if (new TextEncoder().encode(name).byteLength > SURFACE_ATTACHMENT_NAME_MAX_BYTES) return false;
  return ![...name].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return char === '/' || char === '\\' || code < 0x20 || code === 0x7f;
  });
}

const quotaExceeded = (limit: string): FileResult =>
  problem(
    SURFACE_ATTACHMENT_PROBLEM_CODES.attachments_quota_exceeded,
    'attachments_quota_exceeded',
    `A session stores at most ${limit}.`,
  );

/** How many attachments a session holds and their bytes: the ready rows under its own prefix. */
async function sessionUsage(
  storage: StorageService,
  ctx: StorageContext,
  sessionId: string,
): Promise<{ count: number; bytes: number }> {
  const usage = { count: 0, bytes: 0 };
  let cursor: string | undefined;
  do {
    const page = await storage.list(
      ctx,
      'files',
      `.attachments/${sessionId}`,
      cursor === undefined ? undefined : { cursor },
    );
    for (const row of page.rows) {
      usage.count += 1;
      usage.bytes += row.sizeBytes;
    }
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return usage;
}

// @story US-STO-11
// ponytail: the count and the bytes are read, then the file is saved, with no lock between, so
// concurrent uploads to one session can overshoot a limit by at most the requests in flight (ten a
// minute per session, `limits.ts`); a per-session lock if that ever matters.
async function saveAttachment(
  request: Request,
  principal: Principal,
  storage: StorageService,
  sessionId: string,
  name: string,
): Promise<FileResult> {
  const ctx = storageContextOf(principal);
  const used = await sessionUsage(storage, ctx, sessionId);
  if (used.count >= SURFACE_ATTACHMENTS_MAX_FILES) {
    return quotaExceeded(`${String(SURFACE_ATTACHMENTS_MAX_FILES)} attachments`);
  }
  const bounded = boundedBodyStream(request, SURFACE_ATTACHMENT_MAX_BYTES);
  if (!bounded.ok) return bounded.result;
  const remaining = Math.max(0, SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES - used.bytes);
  const saved = await storage.save(ctx, {
    area: 'files',
    path: `.attachments/${sessionId}/${crypto.randomUUID()}/${name}`,
    body: bounded.body,
    maxBytes: Math.min(SURFACE_ATTACHMENT_MAX_BYTES, remaining),
    replace: false,
  });
  if (saved.ok) {
    const body: SurfaceAttachmentResponse = {
      fileId: saved.row.id,
      path: saved.row.path,
      size: saved.row.sizeBytes,
    };
    return { status: 201, kind: 'json', body };
  }
  switch (saved.code) {
    case 'too_large':
      return remaining < SURFACE_ATTACHMENT_MAX_BYTES
        ? quotaExceeded(`${String(SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES)} bytes of attachments`)
        : tooLarge('sent more than that and was not read to the end', SURFACE_ATTACHMENT_MAX_BYTES);
    case 'invalid_path':
      return problem(400, 'invalid_attachment_name', 'That file name cannot be stored.');
    // The path carries a fresh UUID, so these mean a collision, not a competing upload.
    case 'path_taken':
    case 'upload_in_progress':
    case 'path_changed':
      return uploadInProgress();
  }
}

/**
 * `POST /api/sessions/:id/attachments`. A session token reaches its own session, which `decide()`
 * has already required `:id` to be; a console member (no token scope) reaches a session they own,
 * or any session as an owner or admin (`mayAccessSession`). Both save through the same service and
 * the same gates.
 */
export async function uploadSessionAttachment(
  request: Request,
  pathSessionId: string,
): Promise<Response> {
  const access = await requireResourceAccess(request, 'own');
  if (!access.ok) return access.response;
  const { principal } = access;
  const scope = principal.scope;
  if (scope != null && scope.kind !== 'session') return toResponse(notFound());

  const sessionId = scope?.id ?? pathSessionId;
  const project = await applicationContext()?.projects.forWorkspace(principal.workspaceId);
  const session = await project?.sessions.get(sessionId);

  if (scope == null) {
    if (session == null || !mayAccessSession(principal, session)) return toResponse(notFound());
  } else {
    const surfaces = applicationContext()?.surfaces;
    const visitor =
      surfaces?.kind === 'serving'
        ? await surfaces.runtime.visitorSurface(principal.workspaceId, scope.id)
        : undefined;
    if (visitor?.surface?.parts?.attachments !== true) return toResponse(notFound());
  }

  // An archived project takes no new writes (issue #183): the same concealed 404, before any
  // reservation or byte, whichever store the file would go to.
  if (
    project !== undefined &&
    session != null &&
    !(await createProjectRunGate(project.projects).isUsableForNewWork(session.projectId))
  ) {
    return toResponse(notFound());
  }

  const name = new URL(request.url).searchParams.get('name');
  if (!validName(name)) {
    return toResponse(
      problem(
        400,
        'invalid_attachment_name',
        'The "name" query parameter must be one file name of at most 255 bytes that does not start with a dot.',
      ),
    );
  }

  const refusal = await admitSurfaceVisitorWrite(
    principal.workspaceId,
    sessionId,
    'attachment',
    request.headers,
  );
  if (refusal !== null) {
    const response = toResponse(
      problem(SURFACE_ATTACHMENT_PROBLEM_CODES.surface_rate_limited, refusal.code, refusal.message),
    );
    if (refusal.retryAfterSeconds !== null) {
      response.headers.set('retry-after', String(refusal.retryAfterSeconds));
    }
    return response;
  }

  const result = await withCatalogService(
    request,
    (storage) => saveAttachment(request, principal, storage, sessionId, name),
    principal.workspaceId,
  );
  return toResponse(result);
}

/**
 * ADR-0146 D6 retention: remove each purged session's `.attachments/<sessionId>/` through the
 * catalog service, which marks the rows, deletes their objects (a legacy row's too) and drops the
 * rows; a session with nothing left counts 0, so a second pass is a no-op. Answers how many
 * catalogued files went. Without the catalog service there is nothing stored to remove.
 */
export async function purgeSessionAttachments(
  workspaceId: string,
  sessionIds: readonly string[],
): Promise<number> {
  const files = applicationContext()?.files;
  if (files?.kind !== 'serving') return 0;
  const storage = files.runtime.storage;
  if (storage === undefined) return 0;
  // The retention job has no principal; `remove` reads only the workspace.
  const ctx: StorageContext = { workspaceId, principalId: 'session-retention', userId: null };
  let purged = 0;
  for (const sessionId of sessionIds) {
    const removed = await storage.remove(ctx, 'files', `.attachments/${sessionId}`, {
      recursive: true,
    });
    if (removed.ok) purged += removed.removed;
  }
  return purged;
}
