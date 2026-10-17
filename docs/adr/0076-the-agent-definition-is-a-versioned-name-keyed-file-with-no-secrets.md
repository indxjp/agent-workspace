# ADR-0076 — The agent definition is a versioned, name-keyed file with no secrets

Status: accepted
Date: 2026-09-29
Decided by: the implementer of SDK migration unit 7 (K-1, issue #239)
Scope: `packages/contracts/src/agents.ts` (`AgentDefinitionSchema`,
`AGENT_DEFINITION_PROBLEM_CODES`); `packages/sdk/src/resources/agent-definitions.ts`;
`packages/aw/src/commands/agents.ts` (`agents export|import`); `docs/sdk/04-api-specification.md` §6.2;
the additive `source` of `AgentPolicyResponseSchema` and `apps/web/app/api/agents/[id]/policy/route.ts`
(D2)

## Context

K-1 asks for `aw.agents.export(id)` and `aw.agents.import(definition)`: one agent — its record,
policy and assignments — moved between workspaces or environments. The draft in spec §6.2 used
`schemaVersion: 1`, the pre-ADR-0065 `provider` discriminant, and an optional `materials` bundle
of skill directories and connector definitions. Two later decisions bear on the format:

- the developer platform's Phase 2 ("workspace as code", the developer-platform product and roadmap)
  stores one file per resource in git, addressed by name, holding `secretRef` names only;
- ADR-0065 made the policy's discriminant `engine`, and an engine a deployment does not install
  is refused as `400 unsupported_engine`.

## Decision

### D1 — A stable `apiVersion` and `kind`, not a package version

The file carries `apiVersion: 'agentworkspace.dev/v1'` and `kind: 'AgentDefinition'`. The version
names the file format, so a definition written today stays importable by every release that reads
`v1`, however often `@agent-workspace/contracts` is released; a breaking change is a new version
string, never a reinterpretation. This replaces the issue's `contractsVersion`, which would have
made every contracts release look like a format change.

The group is the one the developer platform's roadmap fixes for every project file
(the developer-platform product and roadmap §4.2: "Every YAML file starts with
`apiVersion: agentworkspace.dev/v1` and `kind:`"). The Phase 2 workspace-as-code files reuse this
`apiVersion` group for their other kinds rather than starting a second one, and an agent file under
`workspace/agents/*.yaml` is this `AgentDefinition`, written as YAML instead of JSON.

The canonical agent shape is therefore `kind: AgentDefinition` with the engine at `policy.engine`,
the discriminant ADR-0065 gave the policy and the one the contracts already validate. The roadmap's
customisation table (§4.3) lists the engine as "agent YAML `engine:`"; that row maps to
`policy.engine` of this kind. There is no top-level `engine` field: two places to name the engine
could disagree.

### D2 — Names, never ids; the policy verbatim

Every reference to another resource is its name in the destination: `modelConnectionName`,
`runtimeProfileName`, `resources.skills`, `resources.connectors`, and a file's workspace `path`.
The policy is `AgentPolicySchema` unchanged — its skill allowlist and tool rules already speak in
names. Import resolves each name in the destination, refuses a name two resources share
(`409 agent_definition_reference_ambiguous`), and either refuses (`422
agent_definition_references_missing`, the default) or drops (`onMissing: 'skip'`) a missing one.

Because the definition embeds `AgentPolicySchema` and `AgentPermissionsSchema`, a breaking change
to either — a field removed or renamed, a value narrowed, a meaning changed — needs a new
`apiVersion`, as a breaking change to the definition's own fields does. An additive, optional field
does not. `packages/contracts/src/agent-definition.test.ts` holds a frozen `v1` fixture, written
out literally, that must keep parsing value for value.

An allowlist may only name skills `resources.skills` assigns; the schema refuses any other
(`invalid_agent_definition`), so under `onMissing: 'fail'` the allowlist is sent exactly as written
and under `'skip'` only the names actually skipped are removed from it. Export carries only the
allowlist entries the agent is still assigned: a stored allowlist can outlive an assignment, and a
run intersects it with the current assignments anyway.

**Stored or compiled.** For an agent nobody has `PUT` a policy onto, `GET /api/agents/:id/policy`
answers the policy _compiled_ from its permission checkboxes and its assigned, enabled skills, and
that policy follows every later change to either. Storing it in the destination would freeze the
compiled deny list and allowlist: a skill assigned later would stay excluded and a widened
permission would stay denied. So the definition carries `policySource: 'stored' | 'compiled'`, and
import `PUT`s only a stored policy; a compiled one stays compiled. A hand-written file that leaves
`policySource` out means `'stored'` — the policy it spells out is the one it wants.

No existing read told the two apart, so the policy routes gained the smallest read-only signal: an
additive `source: 'stored' | 'compiled'` on `AgentPolicyResponseSchema`. `GET` answers `'compiled'`
exactly when the agent's `policy` column is NULL, and `PUT` answers `'stored'`. It is optional in
the contract because a server older than #239 does not send it; the SDK then reads `'stored'`,
the reading that never loses a policy. The field adds no route, no RBAC row and no formal route
decision — both routes stay behind the same `authorise` check.

### D3 — No secret and no bytes

There is no credential field anywhere in the shape and every object is `.strict()`, so a file that
smuggles one in is refused before a request is sent. The draft's `materials` bundle is dropped: a
skill moves with `skills.export`/`import`, and the issue's acceptance criterion is that import never
copies skill bytes or connector credentials across the boundary. If Phase 2 needs a credential
reference, it is a `secretRef` name added under a new `apiVersion`, never a value.

### D4 — A client composition that raises its own problems in the one envelope

Export and import compose existing routes (`agents.get`, `getPolicy`, resource assignments, the
catalog lists, `agents.create` with assignments, `replacePolicy`), so every read and write passes
the same RBAC as the individual calls and no route, RBAC row or formal route decision is added.
The refusals the composition decides itself are `ApiProblemError`s with the codes of
`AGENT_DEFINITION_PROBLEM_CODES` — one error class and one envelope, not a fourth error kind. Each
code documents its `details`: `<kind>:<name>` for `agent_definition_references_missing` and
`agent_definition_reference_ambiguous` (a file's name is its path), `<kind>:<source id>` for
export's `agent_definition_reference_unresolvable` (there is no name to report), the engine id for
`unsupported_engine`, and one `<dotted.path>: <message>` per parse issue for
`invalid_agent_definition`.

Nothing is written until every name resolves. If a step after the create then fails — the server
refuses the policy, or the caller aborts — the new agent is removed again (without the caller's
signal, so an abort still cleans up) so a retry never duplicates it, and the original failure is
thrown. A failed removal is never swallowed: the original refusal stays the error, same status and
code, with one more `details` entry `agent:<id>` naming the agent left behind; a failure that was
not an `ApiProblemError` (an abort, a network error) becomes `409
agent_definition_import_incomplete` with `details` `[agent:<id>]` and the original as its `cause`.

Run grants are not exported: they name principals of the source workspace.

## Consequences

- An agent moves with `aw agents export <id> > agent.json` and `aw agents import agent.json`.
- A server-side export (for share snapshots after RF-103, or a transactional import) can adopt this
  exact shape later without a format change.
- Export finds a file grant's path by walking folders breadth-first, 16 listings in flight at a
  time and bounded at 500 listings, because the files
  routes have no path-of-id lookup; a grant it cannot place is refused by name
  (`409 agent_definition_reference_unresolvable`), never dropped.
