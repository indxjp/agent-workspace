# ADR-0072 — The Claude tool mapping and skill placement live in the Claude adapter

Status: accepted
Date: 2026-09-28
Decided by: the agent-engines programme (tracker #299, unit ENG-04b #325)
Scope: `packages/core/src/schemas.ts`'s `RunRequest` (the v2 split);
`packages/contracts/src/agents.ts`' Claude permission floor;
`packages/engine/src/{port,skills}.ts` and `src/testing/conformance.ts`;
`packages/engine-claude-agent-sdk/src/{tools,policy,scope,compile,engine}.ts`;
`apps/web/server/compose/run-request.ts` and `apps/web/server/agents/policy.ts`;
`apps/runner/src/{resources,engines,runtime,index}.ts`; `packages/runtime/src/env.ts`;
`formal/AgentWorkspace/Behaviour/Engine{ToolPolicy,Skills}.lean`

## Context

ENG-04 (#324, ADR-0070) put the Claude Agent SDK behind an engine port and made adding an engine a
matter of adding a package. It did not finish: two Claude-shaped decisions stayed in applications
that are not allowed to know an engine exists, and the PR recorded them as its **Deviations 7 and
8**. The Owner decided on 2026-09-28 to defer them rather than hold that unit.

- **Deviation 7, the tool mapping.** `apps/web/server/compose/run-request.ts` derived
  `allowedTools` / `disallowedTools` / `tools` from §17 Step 4's four permission checkboxes
  (`toolPolicyFor`), added an `mcp__<server>__*` approval per assigned connector, and unioned the
  agent's stored policy into the result. Every name it produced — `Read`, `Bash`, `WebFetch`,
  `Write(/workspace/…/docs/**)` — is `@anthropic-ai/claude-agent-sdk`'s. A second engine would have
  been handed a tool policy written in another engine's vocabulary.
- **Deviation 8, skill placement.** `apps/runner/src/resources.ts` wrote skills to
  `${scope.configDir}/skills/<name>/`, `sandboxFor` set `configDir = ${cwd}/.claude`, and
  `packages/runtime/src/env.ts` did the same — three modules naming one engine's directory.

Both are blocked on the same thing: the private `/run` contract carried `agent: AgentConfig`, whose
`tools` field *is* the Claude grammar, so compose could not stop producing it without the body
changing shape. ADR-0070 D3 deferred that as the "`RunRequest` v2 split".

## Decision

### D1 — `RunRequest` v2 splits the body into a portable core and one engine-native arm

`agent` and `scope` are gone. In their place:

- `portable: PortableAgentConfig` — the agent's name, instructions, model, the four permission
  booleans, its skill surface, its connectors and its limits. Everything **every** engine must
  honour, in the platform's own vocabulary. Nothing here names a tool, because tool names are the
  first thing two engines disagree about.
- `policy: unknown` — the engine-native arm, addressed to the adapter `engine` names and parsed by
  it. For the Claude engine it is `{ tools: AgentToolPolicy | null, fileGrantDeny: string[] }`
  (`packages/engine-claude-agent-sdk/src/policy.ts`).
- `projectKey: string` — the tenant namespace, which used to travel inside `scope` beside a
  `configDir` that is now derived.

`policy` is deliberately not validated by `packages/core`. Only the adapter knows what its own
engine's policy means, and a schema that guessed would either refuse a valid policy for an engine it
has not heard of or accept a malformed one. An arm the adapter cannot read is
`engine_policy_invalid`, a typed refusal before any output frame.

**This is a breaking change to the private contract**, unlike ENG-04's defaulted `engine` and
optional `gateway`. It is breaking because it has to be: a body carrying both shapes would need the
control plane to compile the Claude arm as well, which is exactly the code this unit removes. The
runner and the control plane ship together (#303) and must be **deployed** together for this
release; a new control plane talking to a pre-ENG-04b runner is answered `400 invalid_run_request`
by that runner's own strict schema, which is a loud failure and not a silently wider run. The
release note for this version says so.

### D2 — the *engine's* configuration directory leaves the wire, and every caller asks

`configDir` was `${cwd}/.claude` computed by the control plane. It is now
`claudeSessionScope(cwd, projectKey)` inside the adapter, from `CLAUDE_PROTECTED_CONFIG_DIRECTORY`
— the same string, derived where the knowledge is. Three consequences:

- `sandboxFor` answers `{ cwd, projectKey }` and names no engine directory;
- `apps/runner/src/resources.ts` takes the adapter's `protectedConfigDirectory` and
  `sessionScopedWorkspacePaths` / `sessionWorkspacePaths` take it as a **required** parameter. ENG-04
  left `.claude` as their default so callers could be moved one at a time; the last of them moved
  here, so the default is gone. A default would be one engine's layout, right for exactly one
  engine and therefore impossible to catch.

The **published** reserved-path rule for the workspace file tree (`.claude/**` in
`packages/contracts/src/files.ts`, enforced by `apps/web/server/files/handlers.ts`) is deliberately
**not** engine-derived. It is a statement about which paths a tenant may store in their workspace,
it is on the public files contract, and making it depend on which engine an agent happens to use
would change `GET`/`PUT /api/files` behaviour per agent. Generalising it belongs to the unit that
adds a second engine's directory to that contract.

### D3 — the permission→tool table lives in `packages/contracts`, not in the adapter

The rest of the tool mapping moved into `packages/engine-claude-agent-sdk/src/tools.ts`. The table
that says *which Claude tools each permission switch removes* did not, and this is the one place
this unit does not put a Claude-shaped thing in the Claude package.

It has a second caller the adapter cannot serve. `GET /api/agents/:id/policy` answers the Claude arm
of `AgentPolicySchema` for an agent whose `policy` column is NULL, and `apps/web` may never import an
engine adapter (`dependency-cruiser.config.mjs`). The alternatives were both worse: restating the
table in the control plane is two spellings of one security decision — precisely the drift
`docs/adr/W2-CP-07-a-restatement-across-a-package-boundary-is-watched-by-a-replay-not-a-comment.md`
exists to prevent, and a drift whose failure mode is a run wider than the API says it is; and
changing the route to answer `deny: []` would be a public behaviour change to an endpoint whose
whole purpose is to report what an agent may do.

So the table sits beside `AgentToolPolicySchema` — which the contracts already document as *"the
Claude Agent SDK's own tool grammar. No other arm may reuse it"* — as
`CLAUDE_PERMISSION_TOOL_DENIALS` / `claudeDeniedToolsFor` / `claudeBaseToolPolicyFor`, and the
control plane and the adapter read the same one. What lives in the adapter is everything the
*compile* does with it: the union with the stored arm, the connector approvals, the file-grant
denials, the order, and the de-duplication.

### D4 — the runner writes skills; the adapter says where

`AgentEngine.placeSkills(request)` answers one workspace-relative path per skill file. The runner
checks every answer with `packages/engine`'s `skillPlacementVerdict` and then writes the bytes with
the machinery it already had: a symlink anywhere on the path is refused rather than followed, files
land `0o444` under `0o555` directories, and revoked resources are removed.

The check is not a formality. The runner is handed paths by code it does not own, and a placement at
the sandbox root would put tenant-supplied content beside the agent's own working files — reachable
by tools the platform never scoped to it. `skillPlacementVerdict` names five distinct mistakes
rather than one "invalid": a path that does not normalise, a path outside the declared directory, a
placement for an ungranted skill, two placements on one path, and a granted skill with no placement
at all. The last is the vacuity control: an adapter that returns `[]` must not pass a check about
where its skills land.

The manifest consequently records the **paths written** and not only the skill names. Before this
unit the revocation pass knew a skill's directory and could delete the tree; it cannot any more and
must not guess, so it removes exactly the paths that are no longer granted and prunes the
directories that become empty. That is strictly more precise: a support file dropped from a
still-assigned skill between two turns of one session is now removed.

### D5 — the compose-side file-grant guard stays, and this is when it may go

`applyFileGrantPolicy` remains in compose, changed from *"edit an agent configuration"* to
*"answer the denial list"*, and its output travels as the Claude arm's `fileGrantDeny`. It is
defence in depth: the adapter derives the same list from the same grants and de-duplicates the two in
order, so the field can only ever narrow a run and never widen or reorder one —
`the_compose_side_guard_changes_nothing` states that as a theorem over every modelled input.

It exists for a runtime image whose Claude adapter predates ENG-04 (#324), when nothing but compose
compiled grant denials. **It may be deleted once the minimum supported runtime image carries an
adapter that compiles grants itself**, which is every image from ENG-04 onwards — so in practice
once this release's deployment window has closed. Recording the condition here is what makes
removing it a decision somebody takes rather than a line nobody dares touch.

## Consequences

- Adding an engine adds a package and a row in `apps/runner/src/engines.ts`. Neither compose nor the
  runner learns anything new.
- `grep -rn "toolPolicyFor\|mcp__" apps/web/server` matches nothing outside tests and the legacy
  guard's prose; `.claude` appears in the run-sandbox path only in
  `packages/engine-claude-agent-sdk`.
- The conformance kit gains two scenarios —
  `the-portable-permissions-decide-the-tool-policy` and
  `skills-are-placed-inside-the-declared-config-directory` — and the kit's own self-test breaks
  each of them deliberately with a fake adapter, so neither is vacuous.
- `EngineConformanceSubject` gains `permissionAllowed`. An adapter has to be able to answer *"do
  your compiled options still allow what this switch governs"*, which is the only engine-neutral way
  to see an adapter that reads `portable.permissions` and compiles nothing from it.
- The compiled SDK options are unchanged for every existing vector. The one vector *input* that
  changed is `formal/generated/vectors/run-compose/environment.json`'s `CLAUDE_CONFIG_DIR`: the
  fixture used to be able to name any configuration directory and now names the sandbox root the
  adapter derives one from, so the expectation is `"/run/claude/tenant-a/.claude"` where it was
  `"/run/claude/tenant-a"`. The function's behaviour did not change; the fixture's freedom did.
