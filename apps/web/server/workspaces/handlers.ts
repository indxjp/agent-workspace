/**
 * The handlers behind `/api/workspaces` and `/api/workspaces/:id` — issue #119.
 *
 * Every one of them takes plain data (a repository, resolved ids, a raw body) and returns an
 * {@link ApiResult}, the same split `apps/web/server/rbac/handlers.ts` uses and for the same
 * reason: a handler is exercised without a framework, a server or a network, and the route files
 * under `apps/web/app/api/workspaces/**` are the thin wiring above these.
 */
import type { ApiResult } from '../http/result';
import { problemWithDetail as problem } from '../http/result';
// `asObject`/`readString` are `apps/web/server/rbac/handlers.ts`'s, not a copy of them:
// verification round 1, finding 6, found jscpd reporting a byte-identical clone of both between
// this file and that one — both are this task's `Owns`, so the fix is one shared export, not a
// second copy.
import { asObject, readString } from '../rbac/handlers';
import { log } from '../telemetry/logger';
import type { WorkspaceRepositoryPort } from './runtime';

/**
 * These three are derived from {@link WorkspaceRepositoryPort} rather than imported from
 * `packages/core/src/db/repositories/workspaces.ts` directly: `@agent-workspace/core/db` is the
 * only audited public surface of the database layer (`packages/core/src/db/index.ts`'s header,
 * enforced by `database-reachability.test.ts`), and it re-exports by name only the types Wave 2's
 * six resource tracks already needed — this task did not widen that barrel (out of this task's
 * `Owns`), so the shapes are read back off the one type the barrel does carry, `DatabaseRoot`.
 */
type WorkspaceRecord = NonNullable<Awaited<ReturnType<WorkspaceRepositoryPort['get']>>>;
type WorkspaceMembershipView = Awaited<ReturnType<WorkspaceRepositoryPort['listForUser']>>[number];
type CreateWorkspaceOutcome = Awaited<ReturnType<WorkspaceRepositoryPort['create']>>;

function serialiseWorkspace(row: WorkspaceRecord) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    publicSharingEnabled: row.publicSharingEnabled,
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serialiseMembershipView(row: WorkspaceMembershipView) {
  return { ...serialiseWorkspace(row), role: row.role };
}

// ── collection ──────────────────────────────────────────────────────────────────────────────

/** `GET /api/workspaces` — exactly the workspaces `userId` currently belongs to (issue #119). */
export async function listWorkspaces(
  repository: WorkspaceRepositoryPort,
  userId: string,
): Promise<ApiResult> {
  const rows = await repository.listForUser(userId);
  return { status: 200, body: { workspaces: rows.map(serialiseMembershipView) } };
}

/**
 * `POST /api/workspaces` — create a workspace and its creator's Owner membership, atomically.
 * `onCreated` runs after the commit (the route ensures the new workspace's Builder, #1848); its
 * failure is logged and never fails the create.
 */
export async function createWorkspace(
  repository: WorkspaceRepositoryPort,
  ownerUserId: string,
  body: unknown,
  onCreated?: (workspaceId: string) => Promise<void>,
): Promise<ApiResult> {
  const object = asObject(body);
  if (!object.ok) return object.result;
  const name = readString(object.body, 'name', 200);
  if (!name.ok) return name.result;
  const slug = readString(object.body, 'slug', 64);
  if (!slug.ok) return slug.result;

  const outcome: CreateWorkspaceOutcome = await repository.create({
    name: name.value,
    slug: slug.value,
    ownerUserId,
  });
  switch (outcome.kind) {
    case 'created':
      if (onCreated !== undefined) {
        try {
          await onCreated(outcome.workspace.id);
        } catch {
          // The error may carry SQL or provider text, so the warning names only the workspace.
          log.warn('[workspaces] the after-create step failed', {
            workspaceId: outcome.workspace.id,
          });
        }
      }
      return {
        status: 201,
        body: { workspace: serialiseMembershipView({ ...outcome.workspace, role: 'owner' }) },
      };
    case 'conflict':
      return problem(
        409,
        'slug_taken',
        `"${outcome.slug}" is already in use by another workspace. Choose a different slug.`,
      );
    case 'invalid-slug':
      return problem(
        400,
        'invalid_field',
        `"${outcome.slug}" is not a valid slug: lower-case letters, digits and hyphens, ` +
          'starting and ending with a letter or digit.',
      );
    case 'invalid-name':
      return problem(400, 'invalid_field', '"name" must not be blank.');
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled createWorkspace outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

// ── item ────────────────────────────────────────────────────────────────────────────────────

/**
 * `GET /api/workspaces/:id`. Re-reads the row the route's `memberOwnershipResolver` already
 * proved the caller may see, the same "load again inside the handler" shape
 * `apps/web/server/agents/handlers.ts`'s `getAgent` uses after `resolverForRow` — one extra query
 * over threading the loaded row through `decide()`'s return value, which nothing else needs.
 */
export async function getWorkspace(
  repository: WorkspaceRepositoryPort,
  id: string,
  userId: string,
): Promise<ApiResult> {
  const view = await repository.getForMember(id, userId);
  if (view === null) return problem(404, 'workspace_not_found', `No workspace ${id}.`);
  return { status: 200, body: { workspace: serialiseMembershipView(view) } };
}

/**
 * `PATCH /api/workspaces/:id` — rename, archive, and/or restore. Reached only once the route's
 * `ownerOwnershipResolver` has already confirmed the caller is this workspace's Owner, so every
 * outcome below other than a concurrent delete is a body-shape problem, not an authorisation one.
 */
export async function updateWorkspace(
  repository: WorkspaceRepositoryPort,
  id: string,
  body: unknown,
): Promise<ApiResult> {
  const object = asObject(body);
  if (!object.ok) return object.result;
  const hasName = Object.hasOwn(object.body, 'name');
  const hasArchived = Object.hasOwn(object.body, 'archived');
  // A positive allow-list, not a "read what we recognise and drop the rest": a `slug` in the body
  // is refused rather than silently ignored — "Slug changes stay an explicit, separate operation"
  // means this route has no reading of that field, not that it pretends not to have seen it.
  const unknownField = Object.keys(object.body).find(
    (field) => field !== 'name' && field !== 'archived',
  );
  if (unknownField !== undefined) {
    return problem(
      400,
      'invalid_field',
      `"${unknownField}" is not a field this route accepts. Only "name" and "archived" may be ` +
        'patched here; slug changes are a separate operation this wave does not build.',
    );
  }
  if (!hasName && !hasArchived) {
    return problem(400, 'empty_patch', 'Provide "name" and/or "archived".');
  }

  let name: string | undefined;
  if (hasName) {
    const field = readString(object.body, 'name', 200);
    if (!field.ok) return field.result;
    name = field.value;
  }
  let archived: boolean | undefined;
  if (hasArchived) {
    const raw = object.body['archived'];
    if (typeof raw !== 'boolean') {
      return problem(400, 'invalid_field', '"archived" must be true or false.');
    }
    archived = raw;
  }

  let current: WorkspaceRecord | null =
    name === undefined ? await repository.get(id) : await repository.update(id, { name });
  if (current === null) {
    return problem(404, 'workspace_not_found', `No workspace ${id}.`);
  }
  if (archived !== undefined) {
    current = archived ? await repository.archive(id) : await repository.restore(id);
    if (current === null) {
      return problem(404, 'workspace_not_found', `No workspace ${id}.`);
    }
  }
  return { status: 200, body: { workspace: serialiseWorkspace(current) } };
}
