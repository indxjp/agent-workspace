/**
 * The agent list and creation screens' data model — spec §17, §34, §46, transcribed (where the
 * mockup and the real W1-CP-05 API agree) from `ui/agents.html` and `ui/agent-new.html`.
 *
 * What lives here is what a test can call without a browser: filtering the list, building the
 * request body `POST /api/agents` accepts, and turning that route's own error envelope into
 * something a screen can show. The two `.tsx` files are layout and the fetches themselves.
 *
 * ## Why this is a simplified form, not §17's five-step wizard
 *
 * `ui/agent-new.html` draws the whole wizard — Agent, Model, Capabilities, Permissions, Runtime —
 * because it is `docs/spec.md` §17 as a mockup, and §17 is where a *later* wave's full feature set
 * lives. Spec §46 Phase 0's completion criterion is narrower and is quoted here because it is the
 * actual contract this task is built against:
 *
 * ```text
 * Create Agent
 * → enter instructions
 * → select Claude
 * → Run
 * → receive streamed result
 * ```
 *
 * Capabilities and Permissions remain deferred because their management flows are not present.
 * Wave 3 adds the real §17 Step 5 below: it reads `/api/runtime-profiles` and stores only the
 * selected profile id. No profile fields are copied into an agent request.
 *
 * ## Why there is no Description field
 *
 * `ui/agent-new.html` step 1 also shows a Description input. `agents.contract.ts`'s
 * `CreateAgentInput` has no field for it — the `agents` table (§17) has none either. An input the
 * API silently discards is the same dishonesty as a link to a route that 404s: it looks like it
 * does something and it does not. So it is not transcribed. See
 * docs/adr/W1-UI-04-the-form-has-no-description-field.md.
 *
 * ## Why every agent this form creates now has an explicit, non-null `model`
 *
 * §46 Phase 0 shipped with no Models management screen, so this form could not name a
 * `model_connections` row and every agent it created carried `model: null` ("let the Claude Agent
 * SDK choose"). `#128` (provider management) and `#129` (model discovery) have since landed, and
 * `#130`'s own regression report is that this form kept the Phase 0 behaviour by accident even
 * after they did: it read `GET /api/models` as if it still listed connections and treated a
 * connection's `config.deployment` as "the model", which only an Azure connection ever populates
 * — so a non-Azure selection still persisted `model: null`. `ModelStep` now reads
 * `../models/catalog.ts`'s real `(connectionId, providerModelId)` pairs and both fields this form
 * submits are always the ids of what was actually clicked.
 *
 * ## Why the four permissions are what they are
 *
 * `CreateAgentInput.permissions` has no default in the API — every one of the four keys is
 * required (`contract.ts`: "a column has no database default, because an agent whose permissions
 * nobody chose is an agent whose blast radius nobody chose"). This form has no Permissions step,
 * so it cannot ask. {@link DEFAULT_AGENT_PERMISSIONS} is not invented: it is §17 Step 4's own
 * default selection in `ui/agent-new.html` (Read files ✓, Write files ✓, Run commands ☐,
 * Access unrestricted internet ☐) — the same default PL-0 already chose, applied without
 * rendering the control that would let someone change it in this wave. See
 * docs/adr/W1-UI-04-permission-defaults-are-the-mockups-own.md.
 */
import type {
  AgentPermissions,
  AgentResourceAssignments,
  CreateAgentInput,
} from '../../contracts/agents';
import { EngineListResponseSchema, type EngineDescriptor } from '../../contracts/engines';
import type { ProjectResource } from '../../contracts/projects';
import type { ModelSelectionValue } from '../models/catalog';

/**
 * §17 Step 4's own default state, transcribed from `ui/agent-new.html` (`class="check on"` on
 * Read files and Write files; no `on` on the other two). See the module header.
 */
export const DEFAULT_AGENT_PERMISSIONS: AgentPermissions = {
  readFiles: true,
  writeFiles: true,
  runCommands: false,
  unrestrictedNetwork: false,
};

/**
 * What the Model section used to read before issue #130: one hand-rolled `ModelOption` per
 * *connection*, with `model` guessed from `config.deployment` (only Azure ever populates that
 * field, so every other provider's selection silently persisted `model: null` — the regression
 * `#130` names) and `capabilities` guessed from `provider === 'openai'` rather than read from
 * anywhere real. Both are gone, not replaced with a better guess: `../models/catalog.ts`'s
 * `CatalogModel` (`(connectionId, providerModelId)`, `capabilities` copied verbatim from `#129`'s
 * own discovery adapter) is what `agent-form.tsx` and `agent-detail.tsx` read and submit now.
 */

/** A non-blank name, the same rule `parseAgentName` applies server-side (`contract.ts`). */
export function isValidAgentName(raw: string): boolean {
  return raw.trim().length > 0;
}

/**
 * Build the `POST /api/agents` body for the simplified form. `name` is trimmed here too — the
 * server trims independently, but showing the untrimmed value back to a caller that reads what it
 * is about to send would be a second, disagreeing answer to "what is this agent named".
 *
 * `selectedModel` is `#130`'s `(connectionId, providerModelId)` pair, never `null` here — the form
 * cannot submit without one selected (`NewAgentScreen`'s own `canSubmit`), so a `null` reaching
 * this function is a caller error, not a state to reserve API meaning for.
 */
export function buildCreateAgentInput(
  name: string,
  instructions: string,
  runtimeProfileId: string,
  selectedModel: NonNullable<ModelSelectionValue>,
  permissions = DEFAULT_AGENT_PERMISSIONS,
): CreateAgentInput {
  return {
    name: name.trim(),
    instructions,
    modelConnectionId: selectedModel.connectionId,
    model: selectedModel.model,
    runtimeProfileId,
    permissions: { ...permissions },
  };
}

/** The only profile fields Step 5 renders; the POST body keeps only {@link id}. */
export interface RuntimeProfileOption {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
}

export interface AgentResourceOptions {
  readonly files: readonly { readonly id: string; readonly label: string }[];
  readonly skills: readonly { readonly id: string; readonly label: string }[];
  readonly connectors: readonly { readonly id: string; readonly label: string }[];
}

function resourceRows(body: unknown, key: string, labelKey: string) {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>)[key])
  )
    throw new Error(`The ${key} response has no list.`);
  return ((body as Record<string, unknown>)[key] as unknown[]).map((entry, index) => {
    if (typeof entry !== 'object' || entry === null)
      throw new Error(`${key} ${String(index)} was not an object.`);
    const row = entry as Record<string, unknown>;
    if (typeof row['id'] !== 'string' || typeof row[labelKey] !== 'string')
      throw new Error(`${key} ${String(index)} has no stable id or label.`);
    return { id: row['id'], label: row[labelKey] };
  });
}

export function readAgentResourceOptions(
  filesBody: unknown,
  skillsBody: unknown,
  connectorsBody: unknown,
): AgentResourceOptions {
  return {
    files: resourceRows(filesBody, 'files', 'path'),
    skills: resourceRows(skillsBody, 'skills', 'name'),
    connectors: resourceRows(connectorsBody, 'connectors', 'name'),
  };
}

// ── Issue #133: rendering an agent's existing resource assignments by name ────────────────────────
//
// `GET /api/agents/:id/resources` answers bare ids — `agent_files.file_id` is the catalog UUID
// `ResourceCatalogRepository` mints, not a path, and `agent_skills`/`agent_mcp_servers` are keyed
// the same way — because that is what `agent-resources.ts`'s repository persists and validates
// against. Rendering "by name" (the card's own words) therefore needs a name/path catalog resolved
// separately, the same way `apps/web/server/compose/resource-loader.ts` resolves the identical ids
// server-side before a run: `GET /api/files`/`GET /api/skills`/`GET /api/connectors` are the only
// HTTP surfaces that carry the name a stored id means, so `AgentDetailScreen` fetches them itself
// — no route in this task's Owns globs changes shape to embed a name in the assignment response.

/** One resolved file/folder catalog entry — everything a name-by-id lookup needs to show a row. */
interface CatalogFileEntry {
  readonly path: string;
  readonly kind: 'file' | 'folder';
}

/** id → path/kind for every file and folder `GET /api/files` can reach, however deep. */
export type FileCatalog = ReadonlyMap<string, CatalogFileEntry>;

/**
 * Walk the whole workspace file tree via repeated one-level `fetchPage` calls — the exact shape
 * `GET /api/files?path=` already answers — building the id → path/kind map above.
 *
 * Mirrors `resource-loader.ts`'s own `walkObjectFiles`: no depth or breadth cap, because that
 * function (the one a run itself is composed from) has none either, so this reads no more
 * conservatively than a run already does. `fetchPage` is injected so this stays a pure function a
 * test can drive without a network — the real caller (`useResourceCatalogs` in
 * `resource-editor.tsx`) supplies one backed by `fetch('/api/files?path=…')`.
 */
export async function fetchFileCatalog(
  fetchPage: (
    path: string,
  ) => Promise<
    readonly { readonly id: string; readonly path: string; readonly kind: 'file' | 'folder' }[]
  >,
): Promise<FileCatalog> {
  const found = new Map<string, CatalogFileEntry>();
  const seenPaths = new Set<string>(['']);
  const queue: string[] = [''];
  while (queue.length > 0) {
    // `queue` only ever grows by paths this same loop pushed, so `shift()` here is never `undefined`.
    const path = queue.shift() as string;
    const rows = await fetchPage(path);
    for (const row of rows) {
      found.set(row.id, { path: row.path, kind: row.kind });
      if (row.kind === 'folder' && !seenPaths.has(row.path)) {
        seenPaths.add(row.path);
        queue.push(row.path);
      }
    }
  }
  return found;
}

/** One resolved skill/connector catalog entry. */
interface CatalogNamedEntry {
  readonly name: string;
  readonly enabled: boolean;
}

/** id → name/enabled for every skill or connector `GET /api/skills`/`GET /api/connectors` lists. */
export type NamedCatalog = ReadonlyMap<string, CatalogNamedEntry>;

/**
 * Read `{ [listKey]: [{ id, name, enabled }, …] }` into a {@link NamedCatalog}. An entry with no
 * string `id` (`GET /api/skills` omits it for a skill whose `SKILL.md` failed to sync — see that
 * route's own comment) is skipped rather than guessed at: `agent_skills`/`agent_mcp_servers` can
 * only ever reference a row that has a catalog id, so such an entry could never be an assignment's
 * target in the first place.
 */
export function readNamedCatalog(body: unknown, listKey: string): NamedCatalog {
  const map = new Map<string, CatalogNamedEntry>();
  if (typeof body !== 'object' || body === null) return map;
  const list = (body as Record<string, unknown>)[listKey];
  if (!Array.isArray(list)) return map;
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row['id'] !== 'string' || typeof row['name'] !== 'string') continue;
    map.set(row['id'], { name: row['name'], enabled: row['enabled'] === true });
  }
  return map;
}

/**
 * One assignment row as the editor renders it: the catalog resolution of one grant, or the
 * "missing" state the card requires when a stored id no longer resolves.
 *
 * `missing` is `false` while `catalog` is still `null` (not yet loaded) — an unresolved id during
 * loading is "not yet known", not "gone"; only a `catalog` that loaded and does not contain the id
 * earns the missing badge. Keeping that distinction here, once, is what lets every caller treat
 * "loading" and "confirmed absent" as the two different states the card's acceptance criteria
 * (\"Missing/disabled resources are visible\") actually distinguish.
 */
export interface FileGrantDisplay {
  readonly fileId: string;
  readonly access: AgentResourceAssignments['files'][number]['access'];
  readonly path: string | null;
  readonly kind: 'file' | 'folder' | null;
  readonly missing: boolean;
}

export function resolveFileGrants(
  files: AgentResourceAssignments['files'],
  catalog: FileCatalog | null,
): readonly FileGrantDisplay[] {
  return files.map((grant) => {
    const entry = catalog?.get(grant.fileId);
    return {
      fileId: grant.fileId,
      access: grant.access,
      path: entry?.path ?? null,
      kind: entry?.kind ?? null,
      missing: catalog !== null && entry === undefined,
    };
  });
}

/** The same resolved shape for one skill or connector id — see {@link FileGrantDisplay}. */
export interface NamedAssignmentDisplay {
  readonly id: string;
  readonly name: string | null;
  readonly enabled: boolean | null;
  readonly missing: boolean;
}

export function resolveNamedAssignments(
  ids: readonly string[],
  catalog: NamedCatalog | null,
): readonly NamedAssignmentDisplay[] {
  return ids.map((id) => {
    const entry = catalog?.get(id);
    return {
      id,
      name: entry?.name ?? null,
      enabled: entry?.enabled ?? null,
      missing: catalog !== null && entry === undefined,
    };
  });
}

/**
 * Issue #125's project associations, surfaced read-only on the agent this project would hand them
 * to at run time — never editable here (`docs/adr/W9-PROJ-125-project-resources-narrow-never-widen.md`
 * still governs how they compose into a run; this only decides which projects to show). A project
 * contributes to a run through whichever agent that run actually uses, but the one durable link
 * this deployment records between a project and an agent is `defaultAgentId` — "runs of this
 * project with no agent picked use this one" — so that is the association read here. A project
 * whose resources reached this agent only because a caller picked it explicitly for one session
 * has no persisted trace to read back and is out of this card's Minimum implementation.
 */
export interface ProjectProvidedGroup {
  readonly projectId: string;
  readonly projectName: string;
  readonly files: readonly {
    readonly id: string;
    readonly path: string | null;
    readonly missing: boolean;
  }[];
  readonly connectors: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly missing: boolean;
  }[];
}

export function projectProvidedGroups(
  projects: readonly ProjectResource[],
  agentId: string,
  fileCatalog: FileCatalog | null,
  connectorCatalog: NamedCatalog | null,
): readonly ProjectProvidedGroup[] {
  return projects
    .filter((project) => project.defaultAgentId === agentId)
    .map((project) => ({
      projectId: project.id,
      projectName: project.name,
      files: project.fileIds.map((id) => {
        const entry = fileCatalog?.get(id);
        return {
          id,
          path: entry?.path ?? null,
          missing: fileCatalog !== null && entry === undefined,
        };
      }),
      connectors: project.mcpServerIds.map((id) => {
        const entry = connectorCatalog?.get(id);
        return {
          id,
          name: entry?.name ?? null,
          missing: connectorCatalog !== null && entry === undefined,
        };
      }),
    }));
}

/** Read the exact ordered profile list returned by `GET /api/runtime-profiles`. */
export function readRuntimeProfileOptions(body: unknown): readonly RuntimeProfileOption[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('The runtime profiles response was not an object.');
  }
  const profiles = (body as { runtimeProfiles?: unknown }).runtimeProfiles;
  if (!Array.isArray(profiles)) throw new Error('The runtime profiles response has no list.');
  return profiles.map((profile, index) => {
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
      throw new Error(`Runtime profile ${String(index)} was not an object.`);
    }
    const value = profile as Record<string, unknown>;
    if (
      typeof value['id'] !== 'string' ||
      typeof value['name'] !== 'string' ||
      typeof value['driver'] !== 'string'
    ) {
      throw new Error(`Runtime profile ${String(index)} has no id, name, or driver.`);
    }
    return { id: value['id'], name: value['name'], driver: value['driver'] };
  });
}

/**
 * The engines `GET /api/engines` says this deployment offers (issue #319, ENG-02c).
 *
 * Validated against the published `EngineListResponseSchema` rather than hand-read, because the
 * route's body is an owned contract with a strict shape: a descriptor the schema refuses is drift
 * to report, not something to render half of.
 */
export function readEngineCatalog(body: unknown): readonly EngineDescriptor[] {
  const parsed = EngineListResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error('The engines response was not the published catalogue.');
  return parsed.data.engines;
}

/** Case-insensitive substring match. `''` (no query typed) matches everything. */
export function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || name.toLowerCase().includes(q);
}

/** The list mockup's search box, applied client-side to a list already fetched in full. */
export function filterAgentsByName<T extends { readonly name: string }>(
  agents: readonly T[],
  query: string,
): T[] {
  return agents.filter((agent) => matchesQuery(agent.name, query));
}

/**
 * The Model column's text for one agent. `null` means "the workspace default" (`contract.ts`'s
 * own words for it) — not necessarily Claude forever, only for as long as this deployment has one
 * model connection, so the column says what the field means rather than naming today's resolution
 * of it.
 */
export function describeModel(model: string | null): string {
  return model === null ? 'Workspace default' : model;
}

/** A one-line preview of `instructions` for the list's `.cell-sub`, or `''` for an empty agent. */
export function instructionsPreview(instructions: string, maxLength = 96): string {
  const collapsed = instructions.trim().replace(/\s+/gu, ' ');
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** `agents.createdAt`, already ISO-8601, as the list's Created column. No relative time — that ages. */
export function formatCreatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Talking to `/api/agents` ───────────────────────────────────────────────────────────────────

/**
 * The route's own error envelope, read back as data.
 *
 * This application ships **two** producers of it and they spell the prose differently:
 * `server/http/error-response.ts` (agents, projects, shares, runs, sessions) writes
 * `{ error: { code, message, details? } }`, and `server/rbac/http.ts`'s `problem()` (users,
 * memberships, API keys, invitations) writes `{ error: { code, detail } }`. Issue #185 is where
 * that mattered: the carefully worded `409 last_owner` a demoted last Owner gets
 * (`server/rbac/handlers.ts`) was dropped on the floor here and rendered as *"The server answered
 * 409 without the usual error envelope."* — the opposite of an actionable refusal.
 *
 * Both fields are optional in the type and at least one is required by the guard, so a body with
 * neither is still not an envelope. Read the prose with {@link envelopeProse} rather than reaching
 * for one of the two fields.
 */
export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message?: string;
    readonly detail?: string;
    readonly details?: readonly string[];
  };
}

/**
 * The envelope's human-readable half, whichever of the two producers wrote it.
 *
 * Type-checked rather than `??`-chained: the guard below requires only **one** of the two fields to
 * be a string, so a body carrying a non-string `message` beside a valid `detail` is an envelope, and
 * `??` would return that non-string typed as `string` into a `RequestProblem` every screen renders
 * into JSX — where React throws "Objects are not valid as a React child" and takes the screen down.
 */
function envelopeProse(envelope: ApiErrorEnvelope): string {
  const { message, detail } = envelope.error;
  return typeof message === 'string' ? message : (detail ?? '');
}

/**
 * Does `body` have the shape `{ error: { code: string, message | detail: string } }`? Checked, not
 * assumed.
 */
export function isApiErrorEnvelope(body: unknown): body is ApiErrorEnvelope {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  const detail = (error as { detail?: unknown }).detail;
  return typeof code === 'string' && (typeof message === 'string' || typeof detail === 'string');
}

/**
 * One screen-shaped answer for a fetch against `/api/agents` that did not return the 2xx it was
 * sent for. Every arm carries a message a person can read; none of them is invented — either the
 * route said it, or `reason` names the transport failure that kept the route from answering at
 * all.
 */
export type RequestProblem =
  | {
      readonly kind: 'api';
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: 'transport'; readonly reason: string };

/**
 * Turn a *rejected* `fetch()` promise into the same {@link RequestProblem} shape
 * {@link describeRequestFailure} produces for a `Response` that came back but was not `ok` — a
 * transport failure that happened before the server could answer at all (a reset connection, a
 * DNS failure, a client-side abort or timeout). `agent-form.tsx`'s `onSubmit` already reports
 * exactly this class for `POST /api/agents` inline; this is the same message shape, extracted so
 * `AgentDetailScreen.save()`'s two requests (`apps/web/components/agents/agent-detail.tsx`) can
 * share it and a test can drive it without a real network failure.
 *
 * Verification round 2, finding 1: `save()` used to call `fetch` for both halves with no
 * `try`/`catch` at all, so a rejected promise (Playwright's `page.route(...).abort()`, or a real
 * connection reset) was an *uncaught* exception — `setSaving(false)` was never reached, the
 * button stayed disabled on "Saving…" forever, and no {@link SaveReport} was ever shown. Routing
 * the rejection through this function and into `resolveSaveOutcome` (the same path a `4xx`/`5xx`
 * response already takes) makes a transport-level failure of either half exactly as visible as an
 * HTTP-level one, and leaves `assignmentsDraft` untouched the same way (see `resolveSaveOutcome`'s
 * own comment on `persistedAssignments: null`).
 */
export function describeTransportRejection(error: unknown): RequestProblem {
  return {
    kind: 'transport',
    reason: `The request failed before the server could answer: ${error instanceof Error ? error.message : String(error)}`,
  };
}

/**
 * Turn a non-ok `Response` into a {@link RequestProblem}. `parseJson` is injected so a test can
 * supply a body without constructing a real `Response` (`Response.json()` needs a fetch polyfill
 * Vitest does not have in this project — see `apps/web/vitest.config.mts`).
 */
export async function describeRequestFailure(
  response: Response,
  parseJson: () => Promise<unknown>,
): Promise<RequestProblem> {
  let body: unknown;
  try {
    body = await parseJson();
  } catch {
    return {
      kind: 'transport',
      reason: `The server answered ${String(response.status)} with a body that was not JSON.`,
    };
  }
  if (isApiErrorEnvelope(body)) {
    return {
      kind: 'api',
      status: response.status,
      code: body.error.code,
      message: envelopeProse(body),
    };
  }
  return {
    kind: 'transport',
    reason: `The server answered ${String(response.status)} without the usual error envelope.`,
  };
}

// ── Issue #133: the two-request save's partial-outcome state machine ──────────────────────────
//
// Verification round 1, finding 2: this whole state machine used to live only inside
// `AgentDetailScreen.save()` in `agent-detail.tsx` — an `async` event handler no test in this
// project's suite can drive (`apps/web` has no jsdom/testing-library, and the only rendering path
// this file's tests use, `renderToStaticMarkup`, never runs effects or handlers). Extracted here,
// the same way `resolveFileGrants`/`resolveNamedAssignments` above already pulled the resource
// editor's own display logic out of its component, so what happens on each of the three ways the
// two requests can land — and, load-bearingly, what a *reload* (a fresh `GET`) would show right
// after each one — is exercised without a browser.

/**
 * Issue #133's "explicit, visible partial outcome": `PATCH /api/agents/:id` (the Definition and
 * Permissions sections) and `PUT /api/agents/:id/resources` (the resource editor) are two
 * requests, deliberately never merged into one compound endpoint — the card's own "Deliberately
 * not built" section says a compound transactional endpoint is only needed "if atomic UX is
 * required", and reporting which of the two halves actually landed is simpler and satisfies the
 * criterion honestly. `'not-attempted'` covers the assignments half when the definition half
 * itself failed — the PUT is never sent in that case, which is as much a partial outcome as a PUT
 * that failed after a successful PATCH.
 */
export type HalfOutcome = 'saved' | 'failed' | 'not-attempted';

export interface SaveReport {
  readonly definition: HalfOutcome;
  readonly assignments: HalfOutcome;
  readonly definitionProblem: RequestProblem | null;
  readonly assignmentsProblem: RequestProblem | null;
}

export function describeHalf(
  label: string,
  outcome: HalfOutcome,
  problem: RequestProblem | null,
): string {
  if (outcome === 'saved') return `${label} saved.`;
  if (outcome === 'not-attempted') return `${label} was not attempted.`;
  const reason = problem === null ? '' : problem.kind === 'api' ? problem.message : problem.reason;
  return `${label} was not saved: ${reason}`;
}

/**
 * What actually happened on the wire for one `save()` attempt — the three (and only three) shapes
 * `AgentDetailScreen.save()` can observe. There is no "definition succeeded, assignments not
 * attempted" arm: once the PATCH succeeds the PUT is always sent (`save()`'s own comment on why —
 * sending it unconditionally, win or lose, would let a failed definition save look like it
 * succeeded the moment the resources half came back `200` on its own).
 */
export type SaveOutcome =
  | { readonly kind: 'definition-failed'; readonly problem: RequestProblem }
  | { readonly kind: 'assignments-failed'; readonly problem: RequestProblem }
  | { readonly kind: 'both-saved'; readonly persistedAssignments: AgentResourceAssignments };

/**
 * The result of resolving a {@link SaveOutcome}: the report to show, and — the reload-equivalence
 * rule verifier attack #3 names — the assignments a reload would show immediately afterward.
 *
 * `persistedAssignments: null` means "unchanged from whatever `GET` last returned before this save
 * attempt", never "cleared" or "the attempted draft" — a failed or not-attempted `PUT` writes
 * nothing (`AgentResourceRepository.replace` in `packages/core/src/db/repositories/
 * agent-resources.ts` only ever persists inside its own transaction, never partially), so the only
 * honest answer is "whatever a reload already would have shown", and the caller (`agent-detail.tsx`)
 * must not touch `loaded.assignments` or `assignmentsDraft` when it sees `null` here — touching
 * either would be exactly the "optimistic view of the assignments" the card's acceptance criteria
 * forbid.
 */
export interface SaveResolution {
  readonly report: SaveReport;
  readonly persistedAssignments: AgentResourceAssignments | null;
}

export function resolveSaveOutcome(outcome: SaveOutcome): SaveResolution {
  if (outcome.kind === 'definition-failed') {
    return {
      report: {
        definition: 'failed',
        assignments: 'not-attempted',
        definitionProblem: outcome.problem,
        assignmentsProblem: null,
      },
      persistedAssignments: null,
    };
  }
  if (outcome.kind === 'assignments-failed') {
    return {
      report: {
        definition: 'saved',
        assignments: 'failed',
        definitionProblem: null,
        assignmentsProblem: outcome.problem,
      },
      persistedAssignments: null,
    };
  }
  return {
    report: {
      definition: 'saved',
      assignments: 'saved',
      definitionProblem: null,
      assignmentsProblem: null,
    },
    persistedAssignments: outcome.persistedAssignments,
  };
}
