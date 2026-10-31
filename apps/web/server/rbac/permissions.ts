/**
 * Spec §21's permission split, as data.
 *
 * §21 introduces the split with the word **"Suggested"**, so it proposes rather than fixes it.
 * This file is where the proposal becomes a decision, and every entry below carries the sentence
 * of §21 it comes from or, where §21 is silent, the least-privilege reading this task chose.
 * `docs/adr/W2-CP-06-the-four-roles-and-their-permission-split.md` quotes each ambiguity in full
 * and records the choice; this header states only the shape.
 *
 * ## The shape
 *
 * A permission is `(role, resource, operation) → grant`, and a grant is one of four widths:
 *
 *   * `any`  — every row of the resource in the caller's workspace;
 *   * `own`  — the rows the caller owns, and no others;
 *   * `permitted` — the rows the caller owns plus the rows an `agent_grants` row grants to the
 *     caller (issue #117, ADR-0152). §21 uses this shape in Viewer's *"Run **permitted** agents"*
 *     and Builder's *"run agents … where permitted"*. A grant the handler cannot confirm denies:
 *     an undecidable predicate is refused, never assumed satisfied (ADR-0031);
 *   * `none` — no rows.
 *
 * Each role is declared as a fallback plus the resources §21 names for it. The fallback is
 * `none` for every role but Owner, so a resource nobody thought about is refused rather than
 * granted — the ADR-0015 shape, applied to a table instead of to a classifier.
 *
 * ## What this table does NOT decide
 *
 * Whether a row is the caller's. `own` and `permitted` are answered by the handler, which has the
 * row, and are handed to `decide` as its `ownership` argument. A handler that cannot tell passes
 * `unknown`, and `unknown` denies.
 */
import { composeSubResources, DECLARED_SUB_RESOURCES } from './declared-sub-resources';
import { RESOURCES, type Resource } from './resources';
import { ROLES, type Role } from './roles';

export { parseResource, RESOURCES, type Resource } from './resources';

/**
 * The sub-resources §34's deepest shape admits under each resource, and nothing else.
 *
 * §34 fixes the shape `/api/<resource>/:id/<sub>` (ADR-0026 decision 3). Round 1 parsed the
 * `<sub>` segment out of the path and then used it for nothing but telling `run` from `write` on
 * a `POST`, so a sub-resource nobody had classified silently inherited the **parent's** grants.
 * The verifier registered `GET /api/agents/:id/secrets` the way any Wave-2 task would and every
 * one of §21's four roles was allowed it, including Viewer — a capability `/api/secrets` denies
 * to everyone but the Owner — with no edit to this file and no failure from any gate.
 *
 * That is ADR-0015 inverted: a classifier with no rejecting `else`. This table is the `else`.
 * Every pair below carries the reason it is classified, and a segment that is not in its
 * resource's list is **refused** by `decide`, not granted the parent's width.
 *
 * A sub-resource is deliberately *not* re-resourced to a top-level entry: `POST
 * /api/agents/:id/runs` is running an agent, and §21 grants running under *"Create/edit/**run**
 * agents"* — the `runs` row of this table is about `GET /api/runs/:id`, which is a different
 * capability. What the classification decides is only that the sub segment is one somebody has
 * thought about; the grants stay the parent's, and that reading is what each comment records.
 *
 * Total over {@link Resource} by construction: a new resource with no entry is a compile error
 * here, and the empty list is the answer that refuses every sub-resource under it.
 *
 * ## This is §34's half; the other half is partitioned by owner
 *
 * Every pair below is one spec §34 prints, read by W2-CP-06 out of the specification. A sub segment
 * a *task* ships that §34 does not print is declared by that task, in
 * `declarations/<TASK-ID>.ts`, and composed into {@link SUB_RESOURCES} by
 * {@link composeSubResources} — see `declared-sub-resources.ts` for why, and ADR-0040 for the
 * decision. The split matters: this table is a reading of the specification and stays with §21's
 * `POLICY` below it, while a task's claim that its own route's `<sub>` belongs to its parent is a
 * claim about that task's routes and belongs with them.
 *
 * What the partition does not move is the refusal. A declaration can only attach a segment to a
 * resource §21's table already classifies; it cannot add a resource, cannot change a grant, and
 * cannot make anything skip. An unclassified segment is still `decide()`'s rejecting `else`.
 */
const SPEC_34_SUB_RESOURCES: Readonly<Record<Resource, readonly string[]>> = {
  // §34 prints `POST /api/agents/:id/runs`. Starting a run is §21's `run` verb on `agents`, which
  // is what `parseOperation` already reads it as, so the parent's grants are the right ones.
  agents: ['runs'],
  'api-keys': [],
  'audit-events': [],
  connectors: [],
  // Issue #949 (ADR-0134). §34 never printed `endpoint-clients`; its `keys` sub-resource is the
  // task's own to declare, in `declarations/PT-T1A-ENDPOINT-CLIENTS.ts`.
  'endpoint-clients': [],
  // Issue #319 (ENG-02c). `/api/engines` is a catalogue, not a collection of rows: an engine has
  // no `:id` route and therefore nothing a sub segment under it could address.
  engines: [],
  // Issue #968 (ADR-0133). `/api/platforms` is a catalogue like `engines`: no `:id`, no sub segment.
  platforms: [],
  files: [],
  // Issue #121 (W9-TEAM-121). Empty here, not because `/api/invitations/:id/resend` has no sub of
  // its own — it does — but because §34 never printed `invitations` at all: this whole resource is
  // this task's mandate on §21, so its sub-resource ("resend") is this task's own to declare, in
  // `declarations/W9-TEAM-121.ts`, the same way `messages` under `sessions` is W2-CP-07's rather
  // than a line here. `:id/accept` is declared nowhere on purpose — see that file's header.
  invitations: [],
  // Issue #233. A principal is a singleton per caller: `/api/me` names no row and has no `:id`,
  // so there is nothing a sub segment under it could address. The empty list refuses every one.
  me: [],
  memberships: [],
  metrics: [],
  'model-connections': [],
  models: [],
  projects: [],
  // §34 prints `GET /api/runs/:id/events`. §21 says nothing about events as a capability of their
  // own; they are the contents of the run, so reading them is reading the run.
  runs: ['events'],
  'runtime-connections': [],
  'runtime-profiles': [],
  runtimes: [],
  secrets: [],
  // Issue #1690. `credential`, `test` and `browse` are declared by
  // `declarations/STO-503-STORAGE-CONNECTIONS-1690.ts`.
  'storage-connections': [],
  // §34 prints `POST /api/sessions/:id/messages`. Sending a message to a session is what spends
  // money and executes an agent, so `parseOperation` reads it as `run` on `sessions`.
  sessions: ['messages'],
  shares: [],
  'sharing-policies': [],
  skills: [],
  setup: [],
  'tool-bundles': [],
  // Issue #236. A minted token names no row of its own and has no `:id`, so there is nothing a
  // sub segment under it could address — same reasoning as `me`.
  tokens: [],
  // Issue #1293 (ADR-0144). §34 never printed `triggers`; its `secret` (rotate) sub-resource is the
  // task's own to declare, in `declarations/PT-TRIGGERS-1293.ts`.
  triggers: [],
  users: [],
  // Issue #250 (N-3). `/api/webhooks/:id` has no sub-resource: there is no update, no rotate and
  // no deliveries route yet (ADR-SDK-18-N3-250 D8 and its declared gaps).
  webhooks: [],
  workspaces: [],
};

/**
 * §34's sub-resources and every task's declared ones, as one total record.
 *
 * `decide.ts` and {@link parseSub} read this and nothing else, so the composition is invisible to
 * every caller — which is what makes adding the partition a change to *where* a classification is
 * written rather than to what an unclassified segment does.
 */
export const SUB_RESOURCES: Readonly<Record<Resource, readonly string[]>> = composeSubResources(
  SPEC_34_SUB_RESOURCES,
  DECLARED_SUB_RESOURCES,
);

/**
 * The sub segment of a path, or `null`.
 *
 * Positive: the segment has to *be* one of the pairs {@link SUB_RESOURCES} classifies for this
 * resource. There is no fall-through — an unclassified sub-resource is not a narrower version of
 * its parent, it is a route this program refuses to authorise.
 */
export function parseSub(resource: Resource, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const found = SUB_RESOURCES[resource].find((sub) => sub === value);
  return found ?? null;
}

/** What a caller is trying to do to a resource. */
export type Operation = 'read' | 'write' | 'run';

/** How wide a grant is. See this file's header. */
export type Grant = 'none' | 'own' | 'permitted' | 'any';

/** The three operations' grants for one (role, resource) pair. */
export interface Grants {
  readonly read: Grant;
  readonly write: Grant;
  readonly run: Grant;
}

/** How one role's grants are declared: a fallback, and the resources §21 names for it. */
interface RolePolicy {
  /** The sentence of §21 this role's grants come from, quoted. */
  readonly because: string;
  /** Applied to every resource `byResource` does not name. */
  readonly fallback: Grants;
  readonly byResource: Partial<Readonly<Record<Resource, Grants>>>;
}

const NOTHING: Grants = { read: 'none', write: 'none', run: 'none' };
const EVERYTHING: Grants = { read: 'any', write: 'any', run: 'any' };
/** Full control of a resource, with no run verb because the resource has nothing to run. */
const MANAGE: Grants = { read: 'any', write: 'any', run: 'none' };
/** Readable across the workspace, writable and runnable only where the caller owns the row. */
const OWN_WRITES: Grants = { read: 'any', write: 'own', run: 'own' };
/** The caller's own rows and no others. */
const OWN_ONLY: Grants = { read: 'own', write: 'own', run: 'none' };
/** Readable where owned; nothing else. */
const OWN_READS: Grants = { read: 'own', write: 'none', run: 'none' };
/**
 * Readable across the workspace; nothing may write it.
 *
 * Issue #233 gives this to `me` for Admin, Builder and Viewer, leaving Owner on its `EVERYTHING`
 * fallback. `GET /api/me` answers "who is this credential?" out of the `Principal` the request
 * already carried, so the only condition §21 can place on it is the one every route shares — the
 * caller is authenticated — and `read: 'any'` for all four roles is how this table says that.
 * `write` and `run` stay `none` for the three narrower roles because there is nothing to write: a
 * principal is a projection of a membership row or an API-key row, and both are administered
 * through `/api/memberships` and `/api/api-keys` under their own §21 grants. `read: 'own'` was
 * rejected as saying something narrower than the truth — it would deny for ownership answers the
 * route can never produce, since its handler always passes `not-applicable`.
 */
const READ_ONLY: Grants = { read: 'any', write: 'none', run: 'none' };
/**
 * Issue #119's `workspaces` grant, identical for all four roles and never `EVERYTHING`'s `any` —
 * see the ADR for why `any` is unsafe here. `workspaces` is the one resource whose row IS the
 * tenant `decide()` otherwise assumes from `principal.workspaceId`: a `GET`/`PATCH
 * /api/workspaces/:id` may legitimately name a workspace that is not the caller's *session*
 * workspace (a member of two workspaces, switching), so `any` — which `applyGrant` allows without
 * ever consulting `ownership` — would let an Owner-in-session-A `PATCH` a workspace they do not
 * belong to at all. `own` forces every request through the resolvers in
 * `apps/web/server/workspaces/access.ts`, which compare the caller's real membership of the
 * *target* workspace, never the session's: `read: 'own'` is satisfied by any current membership,
 * `write: 'own'` only by an Owner membership of that same target. `not-applicable` (the collection
 * routes, `GET`/`POST /api/workspaces`) is allowed by `own` regardless of width — see
 * `decide.ts`'s `applyGrant` — which is what makes workspace creation and "my workspaces" listing
 * available to every role: #119 puts no role gate on who may create a workspace or see their own
 * membership list, only on who may administer one once it exists.
 */
const WORKSPACE_MEMBER_SCOPED: Grants = { read: 'own', write: 'own', run: 'none' };

/**
 * §21, role by role.
 *
 * Owner is the only role with a permissive fallback, and that is §21's own word: *"Everything."*
 * Every other role's fallback is `none`, which is what makes a resource nobody classified a
 * denial rather than an accident.
 */
const POLICY: Readonly<Record<Role, RolePolicy>> = {
  owner: {
    because: '§21 Owner — "Everything."',
    fallback: EVERYTHING,
    byResource: {
      // An explicit override, not left to the `EVERYTHING` fallback: see
      // {@link WORKSPACE_MEMBER_SCOPED}'s own comment for why `any` is unsafe for this resource
      // even for Owner, whose fallback for every other resource is deliberately unrestricted.
      workspaces: WORKSPACE_MEMBER_SCOPED,
    },
  },
  admin: {
    because: '§21 Admin — "Users, agents, models, API keys, connectors, runtimes."',
    fallback: NOTHING,
    byResource: {
      // Admin's clause is a list of resources with no verb attached, unlike Builder's
      // "Create/edit/run". Unqualified control of "agents" therefore includes starting a run:
      // reading the clause as management-without-execution would be a *narrower* reading than the
      // words, not a least-privilege reading of an ambiguity.
      agents: EVERYTHING,
      'api-keys': MANAGE,
      // ADR-0152 (roles are monotonic): `EVERYTHING`, not `MANAGE`, because Builder runs its own
      // connectors and `MANAGE` would leave Admin narrower than Builder on `run`.
      connectors: EVERYTHING,
      // Issue #949 (ADR-0134): an endpoint client is credential-bearing configuration like an API
      // key, which Admin manages; `EVERYTHING` so an Admin can bind any agent the workspace may run.
      'endpoint-clients': EVERYTHING,
      // Issue #1293 (ADR-0144 D3): a trigger starts runs without a person at the keyboard, which
      // is configuration of the workspace's agents; Admin manages every one. No route classifies
      // as `run` here (a firing is the public ingress, never a role's call), but the cell is
      // `EVERYTHING` rather than `MANAGE` because Builder holds `run: own` and roles are monotonic
      // (ADR-0152).
      triggers: EVERYTHING,
      // Issue #250 (ADR-SDK-18-N3-250 D6): where the workspace's run outcomes are sent is the same
      // kind of authority as its API keys; no webhook route classifies as `run`, and Builder holds
      // nothing here, so `MANAGE` keeps roles monotonic (ADR-0152).
      webhooks: MANAGE,
      // "Users" is the capability; a membership is how a user is attached to a workspace with a
      // role. Managing users without managing their membership is not a capability §21 could
      // have meant, because §21's user model has no other way to say who belongs where.
      memberships: MANAGE,
      // Issue #121: inviting is the same capability as attaching a membership directly
      // (`POST /api/memberships`), one step earlier — the invitee is not yet a `users` row this
      // deployment recognises. Same width as `memberships` and `users`, and for the same reason:
      // an Admin manages who belongs here and at what role, whichever of the three routes does it.
      // `conferRole` (`apps/web/server/rbac/conferral.ts`) still refuses an Admin's own attempt to
      // invite an Owner — that check is orthogonal to this grant and runs inside the handler on
      // the *requested* role, the same way it already does for `POST /api/users`.
      invitations: MANAGE,
      // Issue #233. Every authenticated caller may read its own principal and nothing may write
      // one; see {@link READ_ONLY} for the reading, and the identical cells under Builder and
      // Viewer below. Owner is deliberately left on the `EVERYTHING` fallback rather than
      // overridden here, so `permissions.test.ts`'s "Everything." assertion keeps covering it.
      me: READ_ONLY,
      metrics: READ_ONLY,
      // Issue #319 (ENG-02c). §21 names no "engines" capability, and the least-privilege reading
      // of that silence is not `NOTHING`: the catalogue is deployment configuration that carries
      // no workspace data, no credential and no row, and every surface that lets a role choose an
      // engine — the agent editor, `aw agents create --engine` — needs it to say which engines
      // exist at all. `write` and `run` stay `none` for all three narrower roles: an engine is
      // installed by deploying an adapter, and no route writes one. Owner is left on its
      // `EVERYTHING` fallback, as for `me`, so `permissions.test.ts`'s "Everything." assertion
      // keeps covering it.
      engines: READ_ONLY,
      // Issue #968 — the platform catalogue, same cell and reading as `engines`.
      platforms: READ_ONLY,
      'model-connections': MANAGE,
      // Issue #1690 (storage design Q-22): Owner and Admin connect and change a bucket; Member
      // (the `builder` role) may see which connections exist, Viewer may not.
      'storage-connections': MANAGE,
      models: MANAGE,
      // "runtimes" — §34 prints the resource as `runtime-profiles` and §15 names them.
      'runtime-profiles': MANAGE,
      // §14.8's live driver registry is exposed separately from persisted runtime profiles, but
      // both are covered by §21's explicit "runtimes" capability.
      runtimes: MANAGE,
      // A runtime connection is credential-bearing configuration, the same shape as a secret or
      // an API key — both of which Admin manages and nothing wider grants. §14.9 names no role;
      // this is the least-privilege reading, matching `runtime-profiles` immediately above.
      'runtime-connections': MANAGE,
      // ADR-0152 (roles are monotonic): §21's Admin clause does not name projects, and the
      // literal reading left Admin with no grant here while Builder holds its own. `MANAGE` —
      // every project in the workspace, no run verb because a project has nothing to run (Builder
      // holds none either). `GET /api/projects` already lists every project for an Admin.
      projects: MANAGE,
      // §21's sharing block, verbatim: "Admin  revoke or suspend any share in the workspace, see
      // the shared-links page."
      shares: MANAGE,
      'sharing-policies': READ_ONLY,
      users: MANAGE,
      // §21 gives Admin no clause about sessions, so this cell keeps W2-CP-06's least-privilege
      // reading of that silence. Note what it does NOT buy, because the resource names invite the
      // wrong inference: the `runs` reading immediately below reaches the `events` sub-resource,
      // which streams another member's named SDK frames, and the live session routes do not read
      // this table at all — `apps/web/server/composition/session-rbac.ts`'s `canAccessSession`
      // already admits any Admin to every session in the workspace. That divergence predates
      // issue #165 and is not resolved here.
      sessions: OWN_ONLY,
      // Issue #165 reverses W2-CP-06's reading of §21's silence for this one cell, and for `read`
      // only. §21 does print two Admin sentences that bear on run history: "Admin  revoke or
      // suspend **any** share in the workspace, see the shared-links page" — already a
      // workspace-wide view of other members' artefacts — and "Publishing a runnable public link
      // … requires Admin or Owner, because it spends the workspace budget", which makes Admin
      // accountable for spend whose persisted record *is* the run history. `READ_ONLY`, not
      // `EVERYTHING`: an Admin reads every run in the workspace and still cannot start or write
      // one. Builder and Viewer keep `OWN_READS`. The width follows the resource, so it reaches
      // `GET /api/runs/:id` and the `events` sub-resource with the list — see
      // docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md.
      //
      // Issue #235 (S-14) adds `run: 'any'` to this cell: an Admin already reads every run in the
      // workspace (the reading above) and may revoke any run's gateway tokens through the
      // dedicated decision capability (`apps/web/server/rbac/decide.ts`), so an Admin can also
      // interrupt one — `docs/adr/SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md`.
      runs: { ...READ_ONLY, run: 'any' },
      // ADR-0116 (supersedes W2-CP-06's literal reading, which left these two cells on the `none`
      // fallback): Admin holds `skills` and `files` the way it holds `agents`, the other resource
      // Builder holds as `OWN_WRITES` — every row, including running one. `MANAGE` would leave
      // Admin narrower than Builder on `run`, contradicting ADR-0102's "An Admin can change
      // anything a Builder can".
      skills: EVERYTHING,
      files: EVERYTHING,
      // Issue #790: a bundle is the code of a tool on an agent version, and content-addressed, so
      // there is no row to own: whoever may save versions (`agents`) may upload and read bundles.
      'tool-bundles': MANAGE,
      workspaces: WORKSPACE_MEMBER_SCOPED,
      // Issue #236 (SDK-04, S-1): §22's "provide workspace [credentials] for programmatic access",
      // applied to a short-lived scoped bearer the same way it already governs `api-keys`. `any`,
      // matching Admin's width over `api-keys` itself: Admin mints a browser token scoped to any
      // run or session in the workspace, not only rows it created.
      tokens: { read: 'none', write: 'any', run: 'none' },
    },
  },
  builder: {
    because: '§21 Builder — "Create/edit/run agents, skills, files, connectors where permitted."',
    fallback: NOTHING,
    byResource: {
      // "where permitted" names no mechanism. The least-privilege reading that still leaves the
      // clause with meaning is that a Builder creates freely and edits what it owns.
      //
      // ADR-0152 (roles are monotonic) makes `run` `permitted`, which `applyGrant` reads as "own
      // or granted": Viewer runs the agents an `agent_grants` row names, and `own` alone did not
      // admit that, so a granted Builder was denied what a granted Viewer was allowed. A Builder
      // still may not run an agent it neither owns nor was granted.
      agents: { ...OWN_WRITES, run: 'permitted' },
      skills: OWN_WRITES,
      files: OWN_WRITES,
      connectors: OWN_WRITES,
      // Issue #949: a Builder creates freely and edits or revokes the clients it created; the
      // handler also refuses binding an agent the Builder could not itself run.
      'endpoint-clients': OWN_WRITES,
      // Issue #1293 (ADR-0144 D3): a Builder creates a trigger for an agent it may run and edits,
      // rotates or removes the ones it owns; the firing runs as that owner, so the handler also
      // refuses an agent the Builder could not itself run.
      triggers: OWN_WRITES,
      // Issue #790: as Admin's cell; a Builder saves versions of its own agents, so it uploads the
      // bundles those versions pin. Viewer keeps none.
      'tool-bundles': MANAGE,
      // Issue #388: read-only. Choosing an agent's runtime profile is part of "Create/edit ...
      // agents" — the agent editor lists profiles and cannot submit without one, and the SDK's
      // agent-definition export and import resolve a profile by name — so a Builder must read
      // them. Writing them stays Owner/Admin (§21 Admin: "runtimes"). A profile carries no
      // credential (§14.9 keeps those on runtime connections, which stay refused; the profile
      // routes refuse a credential-looking `driverConfig` key), so the read discloses sizing and
      // network policy, never secret material. ADR-0088 records this grant and its alternatives.
      'runtime-profiles': READ_ONLY,
      // Issue #1690 (Q-22): a Member reads the connections an agent can be granted; never writes.
      'storage-connections': READ_ONLY,
      // §21's sharing block: "Builder  share own agents, projects and sessions to workspace or
      // public link." Projects and sessions are therefore the Builder's own, and shares over them
      // are the Builder's own.
      projects: OWN_ONLY,
      sessions: OWN_ONLY,
      shares: OWN_ONLY,
      'sharing-policies': READ_ONLY,
      // Issue #235 (S-14): `run: 'own'` — §21's own clause, "Create/edit/**run** agents", is the
      // sentence this cell already reads runs by; stopping a run a Builder started is part of
      // running it, per `docs/adr/SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md`.
      runs: { ...OWN_READS, run: 'own' },
      // Issue #233 — same cell, same reading, as Admin's above.
      me: READ_ONLY,
      metrics: READ_ONLY,
      // Issue #319 — same cell, same reading, as Admin's above: a Builder chooses an agent's
      // engine, so it must be able to read which engines this deployment offers.
      engines: READ_ONLY,
      // Issue #968 — the platform catalogue, same cell and reading as `engines`.
      platforms: READ_ONLY,
      workspaces: WORKSPACE_MEMBER_SCOPED,
      // Issue #236: `own` — a Builder mints a browser token only for a run or session it itself
      // owns; the target's ownership is what `POST /api/tokens`'s handler resolves and hands
      // `decide()` as this cell's `ownership` fact, the same shape `runs`'s own `own` cell uses.
      tokens: { read: 'none', write: 'own', run: 'none' },
    },
  },
  viewer: {
    because: '§21 Viewer — "Run permitted agents and view their own sessions."',
    fallback: NOTHING,
    byResource: {
      // Reading the agent list is what makes "run permitted agents" a sentence about something a
      // Viewer can do at all, and no clause of §21 restricts reading. Running is `permitted`:
      // the agents this Viewer owns or an `agent_grants` row names — see this file's header.
      agents: { read: 'any', write: 'none', run: 'permitted' },
      // "view their own sessions".
      sessions: OWN_READS,
      // Issue #235 (S-14) — same reading as Builder's cell above: stopping a run this Viewer
      // started is part of running it.
      runs: { ...OWN_READS, run: 'own' },
      // §21's sharing block: "Viewer  share own sessions to workspace; public links only if the
      // workspace allows it." The public-link condition is a workspace policy switch §21 gives to
      // the Owner and that no route in this wave exposes; the share itself is the Viewer's own.
      shares: OWN_ONLY,
      'sharing-policies': READ_ONLY,
      // Issue #233 — same cell, same reading, as Admin's and Builder's above. A Viewer is the
      // role this route matters most to: it is the only way a Viewer's own credential can tell it
      // which workspace and which role it resolved to.
      me: READ_ONLY,
      metrics: READ_ONLY,
      // Issue #319 — same cell, same reading, as Admin's and Builder's above. A Viewer reads the
      // agents it may run (`agents: read any`), and the engine is part of what an agent is.
      engines: READ_ONLY,
      // Issue #968 — the platform catalogue, same cell and reading as `engines`.
      platforms: READ_ONLY,
      workspaces: WORKSPACE_MEMBER_SCOPED,
    },
  },
};

/**
 * The grants one role has over one resource. Total over both arguments by construction: `Role` and
 * `Resource` are closed unions, and a role missing from {@link POLICY} is a compile error.
 */
export function grantsFor(role: Role, resource: Resource): Grants {
  const policy = POLICY[role];
  return policy.byResource[resource] ?? policy.fallback;
}

/** The sentence of §21 a role's grants come from. Quoted in every decision's explanation. */
export function policyBecause(role: Role): string {
  return POLICY[role].because;
}

/**
 * Every (role, resource) pair this table classifies, for a test that wants to quantify over the
 * product of the two lists without rebuilding it by hand.
 */
export function everyGrant(): { role: Role; resource: Resource; grants: Grants }[] {
  return ROLES.flatMap((role) =>
    RESOURCES.map((resource) => ({ role, resource, grants: grantsFor(role, resource) })),
  );
}
