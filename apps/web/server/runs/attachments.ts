/**
 * Run attachments (ADR-0146, issue #1307): the workspace files a caller names on `POST
 * /api/agents/:id/runs`, which the run receives as read-only file grants.
 *
 * An id is authorised exactly as `GET /api/files/:id` would authorise the file it names: `decide()`
 * against the catalogue row's owner. A session-scoped token is the one exception (ADR-0146 D5): it
 * may attach only a row under its own `.attachments/<sessionId>/` prefix, which is a row fact and
 * not a `decide()` cell, and so may a console member's run on a session they own, from that
 * session's prefix (issue #1680). Every refusal (no such row, another workspace's row, a role that may not
 * read it, a session token outside its prefix, a reserved path for any other principal) is the same
 * `404 file_not_found`, so a caller cannot tell a file that is not theirs from one that is not there.
 */
import { FILES_PROBLEM_CODES } from '@indx-workspace/contracts/files';
import { RUN_START_PROBLEM_CODES } from '@indx-workspace/contracts/runs';
import {
  SURFACE_ATTACHMENT_MAX_BYTES,
  SURFACE_ATTACHMENTS_MAX_FILES,
  SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES,
} from '@indx-workspace/contracts/surfaces';

import { isUnderSessionPrefix } from '../files/handlers';
import { applicationContext } from '../application-context';
import { encodeFileId } from '../files/file-id';
import { decide } from '../rbac/decide';
import { ownerPrincipalIdOf } from '../rbac/owner-principal';
import { parseRole } from '../rbac/roles';
import type { RunPrincipal } from './environment';
import { apiError } from './http';
import { listCatalogFiles } from '../storage/store';

/** An attachment after authorisation: the catalogue row id the grant path resolves, and its path. */
export interface ResolvedAttachment {
  readonly fileId: string;
  readonly path: string;
  readonly kind: 'file' | 'directory';
}

export type AttachmentsVerdict =
  | { readonly kind: 'ok'; readonly files: readonly ResolvedAttachment[] }
  | { readonly kind: 'refused'; readonly response: Response };

/** The prefix a session's uploads live under; only that session's token or owner may attach from it. */
const RESERVED_PREFIX = '.attachments';

const concealedNotFound = (): Response =>
  apiError(FILES_PROBLEM_CODES.file_not_found, 'file_not_found', 'no file has that id.');

const MIB = 1024 * 1024;

const tooLarge = (reason: string): Response =>
  apiError(
    RUN_START_PROBLEM_CODES.run_attachments_too_large,
    'run_attachments_too_large',
    `${reason}. Attachments are limited to ${String(SURFACE_ATTACHMENTS_MAX_FILES)} files, ${String(
      SURFACE_ATTACHMENT_MAX_BYTES / MIB,
    )} MiB each and ${String(SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES / MIB)} MiB in total (a session's earlier uploads count); attach smaller files, or fewer.`,
  );

/**
 * The session whose `.attachments/<sessionId>/` prefix `principal` may attach from: a session
 * token's own session, or (issue #1680) the console session the run resumes, when the caller owns
 * it — the owner `openSession` requires before it runs there.
 */
async function attachableSession(
  principal: RunPrincipal,
  runSessionId: string | null,
): Promise<string | null> {
  if (principal.scope?.kind === 'session') return principal.scope.id;
  if (principal.scope !== null || runSessionId === null) return null;
  const project = await applicationContext()?.projects.forWorkspace(principal.workspaceId);
  const session = await project?.sessions.get(runSessionId);
  return session?.ownerPrincipalId === ownerPrincipalIdOf(principal) ? runSessionId : null;
}

/** Resolve and authorise `requested` for `principal`, or the response that refuses the start. */
export async function resolveRunAttachments(
  principal: RunPrincipal,
  requested: readonly { readonly fileId: string }[],
  runSessionId: string | null = null,
): Promise<AttachmentsVerdict> {
  const wired = applicationContext()?.files;
  const catalogs = wired?.kind === 'serving' ? wired.runtime.catalog : undefined;
  if (catalogs === undefined) {
    return {
      kind: 'refused',
      response: apiError(
        FILES_PROBLEM_CODES.files_runtime_not_configured,
        'files_runtime_not_configured',
        'the file catalogue is not configured, so run attachments cannot be resolved.',
      ),
    };
  }
  const rows = await listCatalogFiles(await catalogs.forWorkspace(principal.workspaceId));
  const role = parseRole(principal.role);
  const attachable = await attachableSession(principal, runSessionId);
  const files: ResolvedAttachment[] = [];
  /** Every file the run receives, by row id: a folder's files, plus the session's stored uploads. */
  const counted = new Map<string, number>();
  /** The attachments the caller names (a folder is one) plus the session's stored uploads. */
  const attachments = new Set<string>();
  for (const { fileId } of requested) {
    const row = rows.find((candidate) => candidate.id === fileId);
    if (row === undefined || role === null) {
      return { kind: 'refused', response: concealedNotFound() };
    }
    const reserved = row.path.split('/', 1)[0]?.toLowerCase() === RESERVED_PREFIX;
    const ownSessionFile = attachable !== null && isUnderSessionPrefix(row.path, attachable);
    // A skill row is never a run attachment, for any token; a user's file beside it still is.
    // @story US-STO-08
    if (
      row.area === 'skills' ||
      (principal.scope?.kind === 'session' ? !ownSessionFile : reserved && !ownSessionFile)
    ) {
      return { kind: 'refused', response: concealedNotFound() };
    }
    // As `GET /api/files/:id` does: a folder is `own` only when every row under it is the caller's.
    const owned = rows
      .filter(
        (candidate) => candidate.path === row.path || candidate.path.startsWith(`${row.path}/`),
      )
      .every((candidate) => candidate.ownerPrincipalId === principal.ownerPrincipalId);
    if (!ownSessionFile) {
      const decision = decide({
        role,
        method: 'GET',
        path: `/api/files/${encodeFileId(row.path)}`,
        ownership: owned ? 'own' : 'other',
        scope: principal.scope ?? null,
      });
      if (decision.effect !== 'allow') return { kind: 'refused', response: concealedNotFound() };
    }
    attachments.add(row.id);
    // A folder is attached with everything under it: its files count toward the size limits only.
    for (const candidate of rows) {
      if (
        candidate.kind !== 'folder' &&
        (candidate.path === row.path || candidate.path.startsWith(`${row.path}/`))
      ) {
        counted.set(candidate.id, candidate.sizeBytes);
      }
    }
    files.push({
      fileId: row.id,
      path: row.path,
      kind: row.kind === 'folder' ? 'directory' : 'file',
    });
  }
  // The session's stored uploads count with the new ones (check, then save), once each.
  // @story US-STO-11
  if (attachable !== null) {
    for (const stored of rows) {
      if (stored.kind !== 'folder' && isUnderSessionPrefix(stored.path, attachable)) {
        counted.set(stored.id, stored.sizeBytes);
        attachments.add(stored.id);
      }
    }
  }
  const sizes = [...counted.values()];
  if (sizes.some((size) => size > SURFACE_ATTACHMENT_MAX_BYTES)) {
    return {
      kind: 'refused',
      response: tooLarge(
        `an attached file is over ${String(SURFACE_ATTACHMENT_MAX_BYTES / MIB)} MiB`,
      ),
    };
  }
  if (attachments.size > SURFACE_ATTACHMENTS_MAX_FILES) {
    return {
      kind: 'refused',
      response: tooLarge(`more than ${String(SURFACE_ATTACHMENTS_MAX_FILES)} attachments`),
    };
  }
  if (sizes.reduce((sum, size) => sum + size, 0) > SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES) {
    return {
      kind: 'refused',
      response: tooLarge(
        `the attachments total over ${String(SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES / MIB)} MiB`,
      ),
    };
  }
  return { kind: 'ok', files };
}

/**
 * The turn the run receives: the caller's prompt, one line per attached file, and the consequence
 * of a read grant (ADR-0146 Decision 3). The stored prompt stays the caller's own.
 */
export function promptWithAttachments(
  prompt: string,
  attachments: readonly ResolvedAttachment[],
): string {
  if (attachments.length === 0) return prompt;
  const lines = attachments.map((file) => `Attached (read-only): ${file.path}`);
  return [
    prompt,
    '',
    ...lines,
    'This run cannot run commands, because attached files are read-only grants.',
  ].join('\n');
}
