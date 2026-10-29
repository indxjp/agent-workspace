import { refuseIfFeatureDisabled } from '../features/guard';
import { noStoreResultResponse, problemBody } from '../http/result';
import { ownerPrincipalIdOf } from '../rbac/owner-principal';
import { requireResourceAccess, type ResourceAccess } from '../resources/authorise';
import type { ProjectCreateInput, ProjectPatchInput } from '../../contracts/projects';
import { DomainError } from '../errors';
import { applicationContext } from '../application-context';
import type { ProjectActor, ProjectsRuntime } from './runtime';
import type { ProjectListFilter } from './store';

export type ProjectContext = Awaited<ReturnType<ProjectsRuntime['forWorkspace']>> & {
  actor: Extract<ProjectActor, { kind: 'workspace' }>;
};
export function problem(status: number, code: string, message: string): Response {
  return Response.json(problemBody(code, message), { status });
}
export async function json(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    throw invalidProject('This endpoint accepts application/json.');
  }
  try {
    return await request.json();
  } catch (cause) {
    throw invalidProject('The request body is not valid JSON.', cause);
  }
}
export async function withProjects(
  request: Request,
  fn: (context: ProjectContext) => Promise<Response> | Response,
): Promise<Response> {
  const runtime = applicationContext()?.projects;
  if (!runtime)
    return problem(503, 'projects_runtime_not_configured', 'The projects API is not configured.');
  const actor = await runtime.resolveActor(request);
  if (actor.kind === 'unauthenticated') return problem(401, 'unauthenticated', actor.reason);
  if (actor.kind === 'forbidden') return problem(403, 'forbidden', actor.reason);
  // ADR-0160 D7: before the workspace's rows are read, so a switched-off feature confirms no row.
  const refused = await refuseIfFeatureDisabled(request, actor.workspaceId);
  if (refused !== null) return noStoreResultResponse(refused);
  return fn({ ...(await runtime.forWorkspace(actor.workspaceId)), actor });
}

export async function requireProjectAccess(
  request: Request,
  actor: ProjectContext['actor'],
  ownerPrincipalId?: string,
): Promise<ResourceAccess> {
  const access = await requireResourceAccess(
    request,
    ownerPrincipalId === undefined
      ? 'not-applicable'
      : ownerPrincipalId === ownerPrincipalIdOf(actor)
        ? 'own'
        : 'other',
  );
  if (!access.ok || access.principal.workspaceId === actor.workspaceId) return access;
  return {
    ok: false,
    response: problem(403, 'forbidden', 'The authorisation identity resolved another workspace.'),
  };
}
/**
 * The `?archived=` control on `GET /api/projects` — issue #183, discharging the obligation
 * `docs/adr/W9-PROJ-182-archived-at-is-the-project-lifecycle-primitive.md` records on the task that
 * ships the archive route: *"The follow-up must not land the route without a filter control."*
 *
 * `ProjectRepository.list()` already defaults to `'active'`, so omitting the parameter keeps the
 * response exactly what it was before archiving existed; without this control there would be no
 * way back to an archived project through the API at all. An unrecognised value is refused rather
 * than silently read as the default, so a caller that misspells `all` learns it saw a filtered
 * list instead of assuming it saw everything.
 */
export function parseProjectListFilter(request: Request): ProjectListFilter {
  const raw = new URL(request.url).searchParams.get('archived');
  if (raw === null || raw === 'active') return 'active';
  if (raw === 'archived' || raw === 'all') return raw;
  throw invalidProject('archived must be one of "active", "archived" or "all".');
}

const createProjectFields = new Set([
  'name',
  'instructions',
  'defaultAgentId',
  'visibility',
  'fileIds',
  'mcpServerIds',
]);
const patchProjectFields = new Set([
  ...createProjectFields,
  'defaultModelConnectionId',
  'defaultModel',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * `projects.id` and `projects.default_model_connection_id` are both `uuid` columns, so a non-UUID
 * cannot match a row — a caller refuses one here rather than hand it to PostgreSQL, which answers
 * an unmatchable literal with `22P02 invalid input syntax for type uuid` instead of "no such row".
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * `packages/core/src/db/schema/projects.ts` puts two foreign keys on `default_model_connection_id`:
 * Drizzle's own single-column key off the column's `.references()` (`projects_default_model_
 * connection_id_model_connections_id_fk`, checked against every workspace's connections), and the
 * composite `projects_default_model_connection_workspace_fk` (checked against this project's own
 * workspace only). An id that names no connection anywhere trips the first; an id that belongs to
 * another workspace passes the first and trips only the second. Both are "this workspace cannot
 * resolve that connection" — the identical rejection is the point (issue #153 §25: the response
 * must not tell a foreign id apart from a nonexistent one).
 *
 * Drizzle wraps the rejecting `pg` error in a `DrizzleQueryError`, so this walks `error`'s `cause`
 * chain rather than reading `error.code`/`error.constraint` directly — see
 * `docs/adr/W2-DB-02-constraint-violations-arrive-wrapped.md`, whose shared reader
 * (`packages/core/src/db/repositories/violations.ts`'s `postgresViolations`) this route cannot
 * import: it is not part of `@agent-workspace/core/db`'s public surface, and widening that surface
 * is `packages/core/src/db/repositories/index.ts` — outside this task's Owns globs. Bounded to the
 * same depth `postgresViolations` uses, for the same reason: a cyclic `cause` chain must not turn
 * a failed update into a hung request.
 */
const UNRESOLVABLE_MODEL_CONNECTION_CONSTRAINTS = new Set([
  'projects_default_model_connection_id_model_connections_id_fk',
  'projects_default_model_connection_workspace_fk',
]);

/**
 * #586: the project repository refuses a binding that names a tool connector
 * (`ProjectConnectorKindError` in `packages/core/src/db/repositories/project-mcp-servers.ts`), and
 * one that names a visitor upload (`ProjectFileReservedError`, ADR-0146 D6).
 * Matched by `name` for the reason {@link isUnresolvableModelConnection} reads codes: that class is
 * not on `@agent-workspace/core/db`'s public surface.
 */
export function projectConnectorKindRefusal(error: unknown): Response | null {
  if (!(error instanceof Error)) return null;
  // ADR-0146 D6: a file under `.attachments/` (`ProjectFileReservedError`, `project-files.ts`) is
  // not bindable. It answers as the agent assignment's unknown file, confirming nothing about it.
  if (error.name === 'ProjectFileReservedError') {
    return problem(400, 'unknown_file', 'An assigned file is not in this workspace.');
  }
  if (error.name !== 'ProjectConnectorKindError') return null;
  return problem(
    400,
    'project_connector_not_mcp',
    'mcpServerIds names a tool connector; a project binds MCP connectors only. Assign a tool ' +
      'connector to the agent instead.',
  );
}

export function isUnresolvableModelConnection(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 10 && typeof cursor === 'object' && cursor !== null; depth += 1) {
    const link = cursor as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (
      link.code === '23503' &&
      typeof link.constraint === 'string' &&
      UNRESOLVABLE_MODEL_CONNECTION_CONSTRAINTS.has(link.constraint)
    ) {
      return true;
    }
    cursor = link.cause;
  }
  return false;
}

function invalidProject(message: string, cause?: unknown): DomainError {
  return new DomainError({
    category: 'validation',
    code: 'invalid_project',
    publicMessage: message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function projectObject(raw: unknown, allowedFields: ReadonlySet<string>): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidProject('The request body must be a JSON object.');
  }
  const value = raw as Record<string, unknown>;
  for (const forbidden of ['tools', 'permissions', 'model', 'budget', 'runtime'])
    if (forbidden in value)
      throw invalidProject(
        'Projects never grant tools or permissions and have no model, budget, or runtime settings.',
      );
  const unknownField = Object.keys(value).find((field) => !allowedFields.has(field));
  if (unknownField !== undefined) throw invalidProject(`Unknown project field: ${unknownField}.`);
  return value;
}

function visibility(value: unknown): 'private' | 'workspace' | 'public' {
  if (value !== 'private' && value !== 'workspace' && value !== 'public')
    throw invalidProject('Invalid visibility.');
  return value;
}

function stringIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw invalidProject(`${field} must be an array of ids.`);
  return [...new Set(value)];
}

export function parseProject(raw: unknown): ProjectCreateInput {
  const value = projectObject(raw, createProjectFields);
  if (typeof value['name'] !== 'string' || !value['name'].trim())
    throw invalidProject('Project name is required.');
  return {
    name: value['name'].trim(),
    ...(typeof value['instructions'] === 'string' ? { instructions: value['instructions'] } : {}),
    ...(typeof value['defaultAgentId'] === 'string' || value['defaultAgentId'] === null
      ? { defaultAgentId: value['defaultAgentId'] }
      : {}),
    visibility: visibility(value['visibility'] ?? 'private'),
    fileIds: value['fileIds'] === undefined ? [] : stringIds(value['fileIds'], 'fileIds'),
    mcpServerIds:
      value['mcpServerIds'] === undefined ? [] : stringIds(value['mcpServerIds'], 'mcpServerIds'),
  };
}

/** PATCH parser that distinguishes an omitted field from an explicit empty/null value. */
export function parseProjectPatch(raw: unknown): ProjectPatchInput {
  const value = projectObject(raw, patchProjectFields);
  const patch: ProjectPatchInput = {};
  if ('name' in value) {
    if (typeof value['name'] !== 'string' || !value['name'].trim())
      throw invalidProject('Project name must be a non-empty string.');
    patch.name = value['name'].trim();
  }
  if ('instructions' in value) {
    if (typeof value['instructions'] !== 'string' && value['instructions'] !== null)
      throw invalidProject('instructions must be a string or null.');
    patch.instructions = value['instructions'];
  }
  if ('defaultAgentId' in value) {
    if (typeof value['defaultAgentId'] !== 'string' && value['defaultAgentId'] !== null)
      throw invalidProject('defaultAgentId must be an id or null.');
    patch.defaultAgentId = value['defaultAgentId'];
  }
  const hasModelConnection = 'defaultModelConnectionId' in value;
  const hasModel = 'defaultModel' in value;
  if (hasModelConnection !== hasModel) {
    throw invalidProject('defaultModelConnectionId and defaultModel must be updated together.');
  }
  if (hasModelConnection && hasModel) {
    const connectionId = value['defaultModelConnectionId'];
    const model = value['defaultModel'];
    const bothNull = connectionId === null && model === null;
    // `defaultModelConnectionId` is a `uuid` column (packages/core/src/db/schema/projects.ts), so
    // a non-UUID cannot match a row — refused here rather than left for the database's own
    // "invalid input syntax for type uuid" (issue #153, matching every other id-shaped field's
    // own local `isUuid` in this codebase; see e.g. `runtimes/contract.ts`).
    const bothValid = isUuid(connectionId) && typeof model === 'string' && model.trim() !== '';
    if (!bothNull && !bothValid) {
      throw invalidProject(
        'defaultModelConnectionId must be a UUID and defaultModel a non-empty string, or both null.',
      );
    }
    patch.defaultModelConnectionId = connectionId;
    patch.defaultModel = typeof model === 'string' ? model.trim() : model;
  }
  if ('visibility' in value) patch.visibility = visibility(value['visibility']);
  if ('fileIds' in value) patch.fileIds = stringIds(value['fileIds'], 'fileIds');
  if ('mcpServerIds' in value)
    patch.mcpServerIds = stringIds(value['mcpServerIds'], 'mcpServerIds');
  if (Object.keys(patch).length === 0) {
    throw invalidProject('Project patch must not be empty.');
  }
  return patch;
}
