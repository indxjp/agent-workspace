# W1-CORE-01 — The four defaults the compile step applies to every run

Status: accepted
Date: 2026-09-03
Decided by: W1-CORE-01 (Schema/Core)
Scope: `packages/core/src/config.ts`; binding on W1-RN-01 and on the §17 agent UI

## Context

Spec §5 says the platform *"should simply compile UI/database settings into Claude Agent SDK
options"* and sketches nine option names. Four of the values that compilation must produce are not
tenant settings and are not in §5's sketch: they are platform posture, and leaving them unset means
taking the SDK's default, which for a multi-tenant control plane is the wrong default in three of
the four cases. §5 is silent on all four, so per ADR-0004 the smallest defensible reading is chosen
and recorded here.

## Decision

**1. `settingSources: ['project']`.** R-01 §8 and its contract summary record that a workspace's
`.claude/skills/` and `CLAUDE.md` load only when the `project` source is enabled, and spec §7
materialises a tenant's skills exactly there — so `'project'` must be present. `'user'` and
`'local'` are excluded: they read the sandbox image's own home directory, which is platform-owned,
and a tenant's run must not be able to pick up tools or instructions from it.

What this explicitly does **not** do is scope skills. R-01's contradiction 6 is a straight factual
error in spec §7: probe 2 ran with `settingSources: []` and still received 17 bundled Claude Code
skills. The lever for the tenant's skill surface is the `skills` option, which is why
`AgentSkillPolicy` exists and why an empty allowlist is representable.

**2. `strictMcpConfig: true`.** R-01 §9: without it the SDK also loads the workspace's `.mcp.json`,
user settings, plugins and on-disk agent frontmatter, and *"a tenant's workspace files can inject
connectors we never registered."* Spec §8's connector list is only true if this is on. The cost is
that a tenant cannot self-serve a connector by committing a file, which is the intended trade for a
control plane.

**3. Instructions append to the Claude Code preset; they do not replace the system prompt.**
`systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions }` (R-01 §3, option 63).
§17 Step 1 asks for "Instructions" and offers "You help employees answer questions..." as the
example — a sentence about the agent's job, not a replacement for the prompt that teaches it to use
its tools. An empty or whitespace-only `instructions` emits **no** `systemPrompt` key at all rather
than an empty append, matching what the `agents.instructions` column means by `""`.

**4. `null` limits and a `null` model omit their keys rather than sending `null`.** `maxTurns: null`
means "the SDK's own default", not "unlimited", and `model: null` means "the workspace default",
per the `agents.model` column. Sending `null` would ask the SDK to interpret a value we mean as an
absence.

All four are exported as named constants or are visible in one `compileRunRequest`, so a reviewer can
see the platform's posture in one place instead of inferring it from what is missing.

## Alternatives considered

- **Make `settingSources` a per-agent setting.** Rejected as premature: no §17 step asks for it, and
  the only value that differs meaningfully — adding `'user'` — is the one that breaks tenant
  isolation. If a use case appears, this constant is where it changes.
- **`settingSources: []` to give a tenant a clean surface.** Rejected on evidence: R-01 proved it
  does not do that, and it would also drop `.claude/skills/`, which §7 depends on.
- **`strictMcpConfig: false` so tenants can commit `.mcp.json`.** Rejected: it makes spec §8's
  connector inventory advisory rather than authoritative.
- **Replace the system prompt with the agent's instructions** (`{ type: 'custom' }`). Rejected: it
  silently removes Claude Code's tool-use instructions, and the resulting agent would be worse in a
  way no §17 screen warns about.
- **Emit `maxTurns: null` and let the SDK sort it out.** Rejected under ADR-0015: `null` reaching a
  comparison is the failure class this programme keeps hitting.

## Consequences

- Every platform-launched run has the same four postures. A future per-agent override has one place
  to be added and one record to amend.
- A tenant cannot add an MCP connector or a user-level skill by writing a file into their workspace.
  That is intended; the UI is the only path, which is what §8 and §7 already assume.
- The instructions-append mapping means a tenant cannot fully replace the system prompt. Nothing in
  §17 offers that, so nothing is lost today. Declared as a gap rather than as a feature.
