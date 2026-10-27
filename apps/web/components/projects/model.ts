/**
 * The Projects screens' data model — issue #123 (W9-PROJ-123), against the real, already-landed
 * contracts in `apps/web/contracts/projects.ts` (`POST /api/projects`,
 * `PATCH /api/projects/:id`) and the repository methods in
 * `packages/core/src/db/repositories/projects.ts`. Nothing here invents a field the API does not
 * already accept: `ProjectCreateInput` and `ProjectPatchInput` are imported, not redeclared.
 *
 * What lives here is what a test can call without a browser or a running server: building the
 * request bodies the two routes accept, resolving an id list against a workspace catalogue into
 * names (and a missing/deleted state for an id the catalogue no longer carries), and deciding
 * whether an in-progress edit differs from what was last saved. The two `.tsx` files are layout
 * and the fetches themselves, the same split `../agents/model.ts` already established for the
 * agent screens.
 *
 * `type RequestProblem` is **not** redeclared here — it is `../agents/model.ts`'s own, generic
 * over any route that answers this platform's one error envelope. The SDK decodes that envelope,
 * and `./project-requests-model.ts` turns its typed errors into this shape, so "duplicate-name,
 * invalid-association, 403 and 409 responses are rendered as the server worded them" (the task
 * card's own words).
 *
 * ## Why there is still no runtime or budget field
 *
 * `server/projects/http.ts`'s `projectObject()` throws if a submitted body carries `tools`,
 * `permissions`, `budget` or `runtime` — "Projects never grant tools or permissions" and have no
 * runtime or budget settings of their own. Those stay out for the same reason `../agents/model.ts`'s
 * header gives for its own omitted Description field: a control the server would only reject looks
 * like it does something and does not.
 *
 * ## The project default model — issue #130
 *
 * `#123`'s Proposed Changes deferred model controls "until their explicit resolution contract
 * lands (`#130`, Wave 9.4)" — this is that task. `projects.defaultModelConnectionId`/`defaultModel`
 * (added by `#129`) are stored as one pair and resolved by `apps/web/instrumentation-node.ts` when a
 * run starts. The PATCH parser enforces the same pair invariant before persistence.
 *
 * ## Why the nested file picker is not here
 *
 * The task card declares this a gap (G-3): the root-level `/api/files` list is used, the same
 * list `../agents/agent-form.tsx`'s Resources step already reads, and the nested picker `#132`
 * builds later is adopted in a later wave. `readFileOptions` below reads exactly that root list.
 */
import type {
  ProjectArchiveCapability,
  ProjectCreateInput,
  ProjectPatchInput,
  ProjectResource,
} from '../../contracts/projects';
import type { RequestProblem } from '../agents/model';
import type { ModelSelectionValue } from '../models/catalog';

export type { RequestProblem };
export type { ProjectArchiveCapability } from '../../contracts/projects';

export type ProjectVisibility = ProjectResource['visibility'];

/**
 * What `GET /api/projects` and `GET /api/projects/:id` answer over the wire: the row, plus its
 * associations. `createdAt`/`updatedAt` are narrowed to `string` — `Response.json()` serialises a
 * `Date` through its own `toJSON()`, so the client never receives one — the same wire/row split
 * `contracts/agents.ts` draws between its `AgentResource` and the server's DB-row type.
 */
export type { ProjectResource } from '../../contracts/projects';

/** One row of a workspace catalogue (agents, files, or connectors) — an id and a display label. */
export interface CatalogOption {
  readonly id: string;
  readonly label: string;
}

/**
 * Read one of `GET /api/agents`, `GET /api/files` or `GET /api/connectors` into
 * {@link CatalogOption}s. Every field is checked before it is trusted, the same defensiveness
 * `../models/catalog.ts`'s `readCatalog` applies to its own catalogue — a malformed row is a
 * thrown, named error, never a silently blank option.
 */
function readCatalog(body: unknown, listKey: string, labelKey: string): readonly CatalogOption[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`The ${listKey} response was not an object.`);
  }
  const list = (body as Record<string, unknown>)[listKey];
  if (!Array.isArray(list)) throw new Error(`The ${listKey} response has no list.`);
  return list.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${listKey} ${String(index)} was not an object.`);
    }
    const row = entry as Record<string, unknown>;
    if (typeof row['id'] !== 'string' || typeof row[labelKey] !== 'string') {
      throw new Error(`${listKey} ${String(index)} has no stable id or label.`);
    }
    return { id: row['id'], label: row[labelKey] };
  });
}

/** `GET /api/agents` — the default-agent picker's options. Read-only projection: id and name. */
export function readAgentOptions(body: unknown): readonly CatalogOption[] {
  return readCatalog(body, 'agents', 'name');
}

/** `GET /api/files` (root, no `path`) — the same one-level list `agent-form.tsx` already reads. */
export function readFileOptions(body: unknown): readonly CatalogOption[] {
  return readCatalog(body, 'files', 'path');
}

/** `GET /api/connectors` — the connector-association options. */
export function readConnectorOptions(body: unknown): readonly CatalogOption[] {
  return readCatalog(body, 'connectors', 'name');
}

/** A non-blank name, the same rule `parseProject`/`parseProjectPatch` apply server-side. */
export function isValidProjectName(raw: string): boolean {
  return raw.trim().length > 0;
}

/** The editable fields both the create form and the settings surface hold in state. */
export interface ProjectDraft {
  readonly name: string;
  readonly instructions: string;
  readonly visibility: ProjectVisibility;
  readonly defaultAgentId: string | null;
  /** Issue #130's project-layer default. `null` means "no project default; fall through to the
   *  workspace default" — never omitted, the same "submits every field it renders" rule the rest
   *  of this draft already follows. */
  readonly defaultModel: ModelSelectionValue;
  readonly fileIds: readonly string[];
  readonly mcpServerIds: readonly string[];
}

/** `POST /api/projects`'s body. `name` is trimmed here too, for the same reason the agent form
 *  trims it: showing an untrimmed value back to a caller that reads what it is about to send would
 *  be a second, disagreeing answer to "what is this project named".
 *
 *  No `defaultModelConnectionId`/`defaultModel` on create — `#123`'s create form never rendered a
 *  model control and this task does not add one there; a project is created with no default and
 *  gets one afterwards through the settings surface, once `W9-PROJ-125` accepts the PATCH (see this
 *  file's own header). */
export function buildCreateProjectInput(draft: ProjectDraft): ProjectCreateInput {
  return {
    name: draft.name.trim(),
    instructions: draft.instructions,
    defaultAgentId: draft.defaultAgentId,
    visibility: draft.visibility,
    fileIds: [...draft.fileIds],
    mcpServerIds: [...draft.mcpServerIds],
  };
}

/**
 * `PATCH /api/projects/:id`'s body. The settings surface always submits every editable field —
 * `parseProjectPatch` distinguishes an omitted field from an explicit one, but this screen never
 * omits one it renders, so there is no third state ("untouched") for it to disagree with the form
 * about.
 *
 * The connection id and provider-side model id are always sent together, including as two nulls
 * when the project should inherit its workspace default.
 */
export function buildProjectPatch(draft: ProjectDraft): ProjectPatchInput {
  return {
    name: draft.name.trim(),
    instructions: draft.instructions,
    defaultAgentId: draft.defaultAgentId,
    visibility: draft.visibility,
    fileIds: [...draft.fileIds],
    mcpServerIds: [...draft.mcpServerIds],
    defaultModelConnectionId: draft.defaultModel === null ? null : draft.defaultModel.connectionId,
    defaultModel: draft.defaultModel === null ? null : draft.defaultModel.model,
  };
}

/** A saved project's fields, read into the same shape a draft holds, so the two can be compared. */
export function draftFromProject(project: ProjectResource): ProjectDraft {
  return {
    name: project.name,
    instructions: project.instructions ?? '',
    visibility: project.visibility,
    defaultAgentId: project.defaultAgentId,
    defaultModel:
      project.defaultModelConnectionId === null || project.defaultModel === null
        ? null
        : { connectionId: project.defaultModelConnectionId, model: project.defaultModel },
    fileIds: project.fileIds,
    mcpServerIds: project.mcpServerIds,
  };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function sameModel(a: ModelSelectionValue, b: ModelSelectionValue): boolean {
  if (a === null || b === null) return a === b;
  return a.connectionId === b.connectionId && a.model === b.model;
}

/**
 * Whether `draft` differs from `saved` in any field the settings surface can change — the
 * dirty-state guard's whole decision. Order-insensitive on the two association lists: reopening a
 * picker and toggling the same set back on is not a change a person made.
 */
export function isProjectDirty(saved: ProjectDraft, draft: ProjectDraft): boolean {
  return (
    saved.name !== draft.name ||
    saved.instructions !== draft.instructions ||
    saved.visibility !== draft.visibility ||
    saved.defaultAgentId !== draft.defaultAgentId ||
    !sameModel(saved.defaultModel, draft.defaultModel) ||
    !sameIds(saved.fileIds, draft.fileIds) ||
    !sameIds(saved.mcpServerIds, draft.mcpServerIds)
  );
}

/**
 * Did the server's PATCH response carry the project default model we asked it to save? Keeping this
 * check at the client boundary catches a stale or incompatible deployment without trusting a 2xx.
 */
export function projectModelSaveTookEffect(
  requested: ModelSelectionValue,
  saved: ProjectResource,
): boolean {
  const savedValue: ModelSelectionValue =
    saved.defaultModelConnectionId === null || saved.defaultModel === null
      ? null
      : { connectionId: saved.defaultModelConnectionId, model: saved.defaultModel };
  return sameModel(requested, savedValue);
}

/** One assigned resource, resolved against its workspace catalogue. */
export interface ResolvedResource {
  readonly id: string;
  /** The catalogue's current label, or `null` when the id names a resource the catalogue no
   *  longer carries — the missing/deleted state the task card asks for instead of a bare count. */
  readonly label: string | null;
}

/** Resolve an association's ids against the catalogue that was fetched alongside it. */
export function resolveResourceNames(
  ids: readonly string[],
  catalog: readonly CatalogOption[],
): readonly ResolvedResource[] {
  return ids.map((id) => ({
    id,
    label: catalog.find((option) => option.id === id)?.label ?? null,
  }));
}

// ── Project lifecycle — issue #184 ──────────────────────────────────────────────────────────────

/**
 * The three values `GET /api/projects?archived=` accepts, in the server's own vocabulary
 * (`server/projects/http.ts`'s `parseProjectListFilter`).
 *
 * The words are repeated rather than imported because the producer's type lives in
 * `@agent-workspace/core/db`, which browser code must not import; the pairing is held by
 * `projectsListQuery`'s tests and by the server's own 400 for an unrecognised value.
 */
export const PROJECT_FILTERS = ['active', 'archived', 'all'] as const;

/** One of {@link PROJECT_FILTERS} — which slice of the project list a view is showing. */
export type ProjectFilter = (typeof PROJECT_FILTERS)[number];

/**
 * Read `?archived=` from the browser's own URL.
 *
 * An unrecognised value reads as `'active'` rather than being refused, which is the opposite of
 * what the server does with the same word, and deliberately: the server is answering a caller who
 * must learn that its request was narrowed, while this is a person's address bar, where the safe
 * reading of a typo is the default view that hides nothing an active workspace needs.
 * {@link projectsListQuery} then sends the parsed value, so the server is never asked a word it
 * would reject.
 */
export function parseProjectFilter(raw: string | null): ProjectFilter {
  return (PROJECT_FILTERS as readonly string[]).includes(raw ?? '')
    ? (raw as ProjectFilter)
    : 'active';
}

/**
 * What the list says when the chosen slice is empty.
 *
 * Per filter, because "no projects yet" is wrong under the archived filter — a workspace can have
 * plenty of projects and none retired, and the create form the active copy points at is not what
 * that person is looking for. Kept here rather than in the screen so it is assertable: the empty
 * state is reached only after a fetch resolves, which a static-markup render never does.
 */
export function describeEmptyProjectList(filter: ProjectFilter): string {
  switch (filter) {
    case 'archived':
      return 'No archived projects.';
    case 'active':
    case 'all':
      return 'No projects yet. Create one above.';
    default: {
      const unreachable: never = filter;
      throw new Error(`unhandled project filter ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Whether this project has been retired (issue #182's `archived_at`, published by #183). */
export function isProjectArchived(project: ProjectResource): boolean {
  return project.archivedAt !== null;
}

/** The UTC calendar day a project was archived, for the read-only banner. */
export function describeArchivedOn(project: ProjectResource): string | null {
  if (project.archivedAt === null) return null;
  const archived = new Date(project.archivedAt);
  return Number.isNaN(archived.getTime()) ? null : archived.toISOString().slice(0, 10);
}

/**
 * May this caller archive or restore this project?
 *
 * The whole decision is the ownership comparison `requireProjectAccess` itself makes
 * (`server/projects/http.ts`): whose project is it, and which of the server's two answers applies.
 * No role is named here and none is compared — issue #184 forbids a client-side role table, and a
 * copy of §21's grants would drift from `permissions.ts` silently.
 *
 * Fails closed on an unresolved viewer: without a user id the ownership question has no answer, and
 * an undecidable check denies (ADR-0015).
 */
export function canArchiveProject(
  capability: ProjectArchiveCapability,
  project: ProjectResource,
): boolean {
  if (capability.viewerPrincipalId === null) return false;
  return project.ownerPrincipalId === capability.viewerPrincipalId
    ? capability.canArchiveOwn
    : capability.canArchiveOther;
}

/** The largest page `GET /api/runs` will answer (`server/runs/api.ts`'s `MAX_RUN_LIST_LIMIT`). */
export const ARCHIVE_IMPACT_RUN_LIMIT = 200;

/**
 * What the confirmation counted, as read from the two list endpoints the caller already has.
 *
 * `runsTruncated` is `true` when `GET /api/runs` answered a `nextCursor`, i.e. there are more runs
 * than the one page this screen asked for. The dialog then says `200+` rather than `200`, because
 * a client that stopped reading has not verified the total.
 */
export interface ArchiveImpactCounts {
  readonly sessions: number;
  readonly runs: number;
  readonly runsTruncated: boolean;
}

function countPhrase(count: number, singular: string, plural: string, truncated: boolean): string {
  if (truncated) return `${String(count)}+ ${plural}`;
  return count === 1 ? `1 ${singular}` : `${String(count)} ${plural}`;
}

/**
 * The impact sentence the confirmation renders.
 *
 * It says "that you can see" because that is what these counts are: `GET /api/runs` and
 * `GET /api/sessions` both narrow to the caller's own rows for every role below Owner/Admin, and
 * neither publishes a total. Naming the scope is the difference between a partial count and a wrong
 * one — see the task ADR, which records what an exact count would cost.
 */
export function summariseArchiveImpact(counts: ArchiveImpactCounts): string {
  if (counts.sessions === 0 && counts.runs === 0 && !counts.runsTruncated) {
    return 'No sessions or runs that you can see are affected. Archiving stops new sessions and runs from starting in this project.';
  }
  const sessions = countPhrase(counts.sessions, 'session', 'sessions', false);
  const runs = countPhrase(counts.runs, 'run', 'runs', counts.runsTruncated);
  return `${sessions} and ${runs} that you can see become read-only. Completed work stays in history, and no new sessions or runs can start in this project.`;
}

/**
 * Every state the archive confirmation can be in, so a component test can render each one without
 * a browser: this repository has no jsdom, so an async state is only reachable as a prop.
 */
export type ArchiveDialogState =
  /** Open with nothing to count — what a restore confirmation is, since it retires nothing. */
  | { readonly kind: 'confirming' }
  | { readonly kind: 'counting' }
  | { readonly kind: 'counted'; readonly impact: ArchiveImpactCounts }
  | { readonly kind: 'count-unavailable' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'failed'; readonly problem: RequestProblem };

/**
 * A failed archive or restore, worded for the screen.
 *
 * A `404` from these two routes is deliberately ambiguous and must stay that way here: issue #183
 * rewrites a refusal into the byte-identical answer a nonexistent id gets, so "you may not" and
 * "there is no such project" are one response. The server's own `Project not found.` would read as
 * a claim about the database that this client cannot make, so the wording names only what is true
 * for both readings. Every other status keeps the server's own message.
 */
export function describeLifecycleFailure(problem: RequestProblem): RequestProblem {
  return problem.kind === 'api' && problem.status === 404
    ? { ...problem, message: 'This project is no longer available.' }
    : problem;
}

function rows(body: unknown, listKey: string): readonly Record<string, unknown>[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`The ${listKey} response was not an object.`);
  }
  const list = (body as Record<string, unknown>)[listKey];
  if (!Array.isArray(list)) throw new Error(`The ${listKey} response has no list.`);
  return list.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${listKey} ${String(index)} was not an object.`);
    }
    return entry as Record<string, unknown>;
  });
}

/**
 * `GET /api/sessions` → the project each visible session belongs to.
 *
 * A row without a `projectId` reads as `null` rather than as a malformed response: the route has a
 * second, older response shape whose rows carry no project at all (`server/sessions/api.ts`'s
 * store fallback), and a session that names no project is not one this project's archive retires.
 */
export function readSessionProjectIds(body: unknown): readonly (string | null)[] {
  return rows(body, 'sessions').map((row) =>
    typeof row['projectId'] === 'string' ? row['projectId'] : null,
  );
}

/** One page of `GET /api/runs`, reduced to what the impact summary needs. */
export interface RunPageSummary {
  readonly runs: number;
  /** `nextCursor` was not `null`: there are more runs than this page counted. */
  readonly truncated: boolean;
}

/** `GET /api/runs?project=…` → how many runs came back, and whether the page was cut short. */
export function readRunPage(body: unknown): RunPageSummary {
  const runs = rows(body, 'runs').length;
  const nextCursor = (body as Record<string, unknown>)['nextCursor'];
  if (typeof nextCursor !== 'string' && nextCursor !== null) {
    throw new Error('The runs response has no nextCursor.');
  }
  return { runs, truncated: nextCursor !== null };
}

/**
 * The two impact reads reduced to the counts the confirmation renders, with `null` for a read that
 * did not answer — `null` overall when **either** side is missing.
 *
 * A failed read is not a zero. Substituting one would put a digit this screen never established
 * into the sentence ("0 sessions and 4 runs … become read-only" for a project that may have any
 * number of live sessions), which is the opposite of what the confirmation is for. A half answer
 * therefore routes to the dialog's `count-unavailable` state, which still allows the archive.
 */
export function archiveImpactFromReads(
  sessionsInProject: readonly (string | null)[] | null,
  runs: RunPageSummary | null,
): ArchiveImpactCounts | null {
  if (sessionsInProject === null || runs === null) return null;
  return {
    sessions: sessionsInProject.length,
    runs: runs.runs,
    runsTruncated: runs.truncated,
  };
}
