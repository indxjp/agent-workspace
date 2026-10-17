# W1-RN-01 — Session durability is a verdict the boundary earns, never a default

Status: accepted
Date: 2026-09-03
Decided by: W1-RN-01 (Runner)
Scope: `apps/runner/src/claude.ts`; the §14.9 resume claim every later runner and UI change makes

## Context

Spec §14.9 is unusually blunt: *"If session state lives solely in `CLAUDE_CONFIG_DIR` inside a
sandbox, a runtime switch silently loses the conversation — treat that as a release blocker, not a
detail."* R-01 §6 then verified live that this is the default: with no further configuration a
session is one JSONL file at `<CLAUDE_CONFIG_DIR>/projects/<projectKey>/<sessionId>.jsonl` inside
the sandbox, and the session id in Postgres is not enough to resume it.

R-01 §7 adds three properties of the fix that decide the shape of this record:

- a `sessionStore` is a **mirror**, not a replacement — the subprocess always writes locally first
  and the SDK forwards the same batch to `append()`;
- mirror writes are **best-effort**: three attempts, short backoff, timeouts not retried; after the
  final failure the batch is **dropped**, a `{type:'system', subtype:'mirror_error'}` message is
  emitted, and *the run continues normally*;
- on a store-resumed run the local copy is deleted at run end, so a dropped batch on such a run has
  no surviving copy anywhere.

So "the platform has a `SessionStore`" and "this run's conversation survives the sandbox" are two
different statements, and the gap between them is silent by design. The natural way to write the
check is the way ADR-0015 forbids: `if (sawMirrorError) notDurable;` — falsy on a run that never
reached the store at all, falsy on a run the consumer abandoned halfway, falsy on a run whose
`append()` was still in flight when the stream ended. Each of those fails **open**, and the thing
that fails open is a resume button the operator believes in.

## Decision

`ClaudeRun.sessionDurability()` returns a two-arm verdict:

```ts
type SessionDurability =
  | { readonly durable: true; readonly mirroredBatches: number }
  | { readonly durable: false; readonly reason: string };
```

`durable: true` is returned **only** when all of the following were observed, in one run:

1. the event stream was **exhausted** — the generator's loop drained, which a consumer that
   `break`s out of the stream does not cause;
2. the stream did not end in an error;
3. a `sessionStore` was supplied;
4. no `system/mirror_error` event arrived;
5. no wrapped `append()` call rejected;
6. no wrapped `append()` call was still in flight when the stream ended;
7. a `result` event arrived, so the run reached a terminal state;
8. at least one `append()` call **resolved**.

Point 8 is the one that makes this an assertion rather than an absence. The boundary wraps the
caller's store and counts settled appends; `durable: true` carries that count. A store that was
configured and never called yields `durable: false` with that as the reason — which is exactly the
run whose transcript exists nowhere but the sandbox while the platform holds a mirror object and
would otherwise say yes.

Every other path returns `durable: false` **with a sentence**, and the sentences are ordered from
most to least specific so the operator is told the real cause rather than the first one a boolean
tripped over.

Two implementation notes that are decisions, not details:

- The wrapper **re-throws** from `append()`. The SDK owns the retry policy and the `mirror_error`
  it emits after the third failure; swallowing the rejection would turn a dropped batch into a
  silent one and delete the very signal this record exists to read.
- The wrapper **binds** the store's methods rather than spreading the object. `{ ...store }` copies
  own enumerable properties only, so a class-based adapter — the SDK's own `InMemorySessionStore`
  is one, and spec §20's Postgres adapter will be another — loses its prototype methods and
  produces a store that throws on first use.

## Alternatives considered

- **Return a boolean.** Rejected: a `false` with no reason cannot be shown to an operator, cannot
  be audited (§36), and cannot distinguish "no store configured" from "the store dropped a batch",
  which are a configuration bug and an outage respectively.
- **Emit a synthetic `durability` event into the stream.** Rejected: durability is a property of a
  *finished* run, and putting it in the stream invites a consumer to read it early. The verdict is
  a method precisely so that calling it mid-run answers "not yet, and here is why".
- **Trust `system/mirror_error` alone.** Rejected — it is the ADR-0015 failure verbatim. The event
  only fires when a store exists and its writes failed; every other way for a session to be
  non-durable produces no event at all.
- **Have the boundary supply its own `SessionStore`.** Rejected as scope: spec §20's durable store
  is a Wave 2 task, and a default store here would make "durable" the silent default, which is the
  opposite of what §14.9 asks for.
- **Refuse to start a run with no `sessionStore`.** Rejected as too strong for W1: a local
  development run with no Postgres behind it is legitimate. The run is allowed; the *claim* is not.

## The honest downside

The verdict is conservative in ways that will produce false negatives. A consumer that streams a run
into an SSE response (R-13) and stops early because the client disconnected leaves the stream
unexhausted, so the run reports `durable: false` even though the SDK very likely mirrored everything
it had. A long-running interactive session that has not reached a `result` reports `durable: false`
for its whole life. Both are the safe direction and both will need a follow-up: W2 should record the
verdict at run end and, for the abandoned-stream case, distinguish "consumer went away" from "run
did not finish".

The count in `mirroredBatches` is a count of `append()` calls that resolved, not of entries, and not
of bytes. It is evidence that the mirror was live, not a reconciliation.

And the largest caveat: this establishes durability *at the boundary*. It says a store accepted
every batch the SDK offered. It does not say the store is durable — that a Postgres adapter fsynced,
that `load()` returns entries deep-equal to what was appended, or that a resume on another host
works. R-01 marks multi-host resume as **documented, not probed**, and the vendor conformance suite
has not been run against any adapter. `RuntimeCapabilities.sessionPortability` must stay declared
unverified until W3 tests a real runtime switch across two machines.

## Evidence — four live scenarios, one host

Re-run 2026-09-03 in verification round 1, against the current file, on Windows 11, Node v24.19.0,
one OAuth account, SDK 0.3.258 (Claude Code 2.1.258), model `claude-haiku-4-5`, `maxTurns: 1`. Real
output, unedited except for line wrapping and the elisions marked `...`. The session ids differ
from the first round's because each run mints a fresh one; nothing else about the shape changed.

```text
DURABILITY_BEFORE: {"durable":false,"reason":"the event stream has not been exhausted. ..."}
KINDS_YIELDED: ["system","rate_limit_event","assistant","result"]
EVENTS: ["system/init","rate_limit_event","system/thinking_tokens","system/thinking_tokens",
         "assistant","assistant","result/success"]
ASSISTANT_TEXT: "PONG"
DURABILITY_AFTER: {"durable":true,"mirroredBatches":2}
STORE_KEYS: ["tenant-probe/fd1ec1f3-e5c0-472c-9902-ae9297d557b5/"]
STORE_ENTRY_TYPES: ["queue-operation","queue-operation","user","attachment","ai-title",
                    "atis-latch","assistant","assistant","last-prompt"]
LOCAL_TRANSCRIPT_DIRS: tenant-probe
MINTED_SESSION_ID_HONOURED: true fd1ec1f3-e5c0-472c-9902-ae9297d557b5

FAILING_MIRROR_EVENTS: ["system/init","rate_limit_event","system/thinking_tokens",
   "system/thinking_tokens","system/thinking_tokens","assistant","assistant",
   "system/mirror_error","result/success","system/mirror_error"]
FAILING_MIRROR_DURABILITY: {"durable":false,"reason":"the SDK emitted 2 system/mirror_error
   event(s): a batch of transcript entries was dropped after 3 attempts and has no surviving copy
   in the store. First: tenant-probe-2/17cd1d22-f38d-426d-93ae-ca0aa18af4b4: probe: the mirror is
   down"}

NO_STORE_DURABILITY: {"durable":false,"reason":"no sessionStore was supplied, so this session
   exists only as <CLAUDE_CONFIG_DIR>/projects/<projectKey>/<sessionId>.jsonl inside the sandbox
   (R-01 §6, verified live). Spec §14.9: ..."}

WINDOWS_DEVICE_SCOPE_REFUSED: [{"code":"custom","message":"CLAUDE_CODE_PROJECT_DIR_NAME=\"con\" is
   a reserved Windows device name. The SDK ignores it silently, with the same c...
EMPTY_CONFIG_DIR_REFUSED: [{"code":"custom","message":"CLAUDE_CONFIG_DIR is empty. The SDK's
   resolver treats that as unset and ignores CLAUDE_CODE_PROJECT_DIR_NAME, silent...
```

The probe below also runs five skill-surface scenarios. Their output and what it settles are in
`W1-RN-01-the-skill-surface-is-narrowed-not-closed.md`; they are in the same script because they
need the same seeded config directories, not because they are about durability.

Three of these upgrade a row R-01 left open, and the upgrades are worth naming:

| R-01 row | Was | Now |
| --- | --- | --- |
| Minting our own session id via `options.sessionId` | verified (type contract) — *"no probe passed a caller-supplied `sessionId`"* | **verified (probe — executed)**: the store's key carried the UUID this run minted |
| `mirror_error` after a dropped batch | documented (doc comment) | **verified (probe — executed)**: a rejecting store produced two `system/mirror_error` events and the run still ended `result/success` |
| The two silent `CLAUDE_CODE_PROJECT_DIR_NAME` fallbacks | documented, and asserted against `sdk.mjs` by `tests/sdk-surface.test.ts` | still documented for the SDK's own behaviour; **the platform's refusal to start such a run is now probed** |

Note on the last row: both refusals came out of `RunRequest.parse()` as a `ZodError` before
`validateTenantSessionScope` was reached. Both checks are positive assertions and either is
sufficient; the explicit second one exists so that a future caller who bypasses the schema still
cannot start a run on a scope the SDK would silently ignore.

What this does **not** establish, and must not be read as establishing: any of it on Linux (the
runner's target); resume from a store, on the same host or another; the conformance of a real
Postgres adapter; or the "local copy is deleted at run end on a store-resumed run" rule, which no
probe here exercised. `LOCAL_TRANSCRIPT_DIRS: tenant-probe` confirms the local copy is still
written, as R-01 §7 says a mirror must.

## The probe, in full

Not committed: it falls outside this task's ownership globs, and it seeds credentials out of the
operator's `~/.claude`. It is reproduced here so the results above are reproducible rather than
merely reported. Note what it does **not** import — nothing from `@anthropic-ai/claude-agent-sdk`.
That is the §42 claim exercised rather than asserted: a caller of the boundary never needs the SDK,
not even to supply a transcript mirror. The mirror below is a plain object literal satisfying the
platform's own `TranscriptMirror` type, which is why round 1's removal of the SDK's `SessionStore`
from the exported surface changed nothing about this file.

Save it one directory above a worktree checked out at `w1-03/`, build `packages/core` once
(`pnpm --filter @agent-workspace/core run build`), then run it under Node 24's type stripping from
inside the worktree: `node ../.probe-W1-RN-01.mjs`.

```js
// W1-RN-01 live acceptance probe — real runs through apps/runner/src/claude.ts.
//
// It imports NOTHING from @anthropic-ai/claude-agent-sdk: only `startRun` from the boundary
// file, plus a ten-line in-memory transcript mirror. That is the point — if the boundary really
// is the boundary, a caller never needs the SDK.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { startRun } from './w1-03/apps/runner/src/claude.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-rn-01-'));
const cwd = path.join(ROOT, 'workspace');
fs.mkdirSync(cwd, { recursive: true });

// R-01 §7: CLAUDE_CONFIG_DIR points at a fresh directory, so seed credentials or the run dies
// with "Not logged in" (probe 1's only result). Same seeding step as R-01's probe 3.
const real = path.join(os.homedir(), '.claude');
const dotClaudeJson = path.join(os.homedir(), '.claude.json');
function freshConfigDir(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['.credentials.json', 'settings.json']) {
    const src = path.join(real, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
  if (fs.existsSync(dotClaudeJson)) fs.copyFileSync(dotClaudeJson, path.join(dir, '.claude.json'));
  return dir;
}
const cfg = freshConfigDir('cfg');

// A transcript mirror with no SDK import: append/load is the whole required surface (R-01 §7).
const rows = new Map();
const store = {
  async append(key, entries) {
    const k = `${key.projectKey}/${key.sessionId}/${key.subpath ?? ''}`;
    rows.set(k, [...(rows.get(k) ?? []), ...entries]);
  },
  async load(key) {
    return rows.get(`${key.projectKey}/${key.sessionId}/${key.subpath ?? ''}`) ?? null;
  },
};

// `env` REPLACES the subprocess environment (R-01 §3), and RunEnvironment refuses the two
// session-scope variables so they can only come from `scope`.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k, v]) =>
      typeof v === 'string' && k !== 'CLAUDE_CONFIG_DIR' && k !== 'CLAUDE_CODE_PROJECT_DIR_NAME',
  ),
);

const mintedSessionId = randomUUID();

const request = {
  runId: randomUUID(),
  sessionId: randomUUID(),
  cwd,
  prompt: 'Reply with exactly the word PONG and nothing else.',
  agent: {
    name: 'probe',
    instructions: '',
    model: 'claude-haiku-4-5',
    permissions: {
      readFiles: false,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
    tools: {
      base: [],
      autoApprove: [],
      deny: [],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    // The lever R-01 contradiction 6 identified: an empty allowlist, not settingSources.
    skills: { mode: 'allowlist', names: [] },
    mcpServers: {},
    limits: { maxTurns: 1, maxBudgetUsd: null },
  },
  session: { kind: 'fresh', sessionId: mintedSessionId },
  scope: { projectKey: 'tenant-probe', configDir: cfg },
  env,
};

const run = startRun(request, { sessionStore: store });

console.log('DURABILITY_BEFORE:', JSON.stringify(run.sessionDurability()));

const seen = [];
let text = '';
for await (const event of run.events) {
  switch (event.kind) {
    case 'system':
    case 'system-unknown':
      seen.push(`system/${event.subtype}`);
      break;
    case 'result':
    case 'result-unknown':
      seen.push(`result/${event.subtype}`);
      break;
    case 'event':
      seen.push(event.type);
      if (event.type === 'assistant') {
        const content = event.event.message?.content ?? [];
        for (const block of content) if (block.type === 'text') text += block.text;
      }
      break;
    case 'unknown':
      seen.push(`unknown:${event.type}`);
      break;
    case 'malformed':
      seen.push(`MALFORMED(${event.reason})`);
      break;
    default:
      throw new Error(`the normalised union grew an arm this probe does not handle`);
  }
}

console.log('KINDS_YIELDED:', JSON.stringify([...new Set(seen.map((s) => s.split('/')[0]))]));
console.log('EVENTS:', JSON.stringify(seen));
console.log('ASSISTANT_TEXT:', JSON.stringify(text.trim()));
console.log('DURABILITY_AFTER:', JSON.stringify(run.sessionDurability()));
console.log('STORE_KEYS:', JSON.stringify([...rows.keys()]));
console.log('STORE_ENTRY_TYPES:', JSON.stringify([...rows.values()].flat().map((e) => e.type)));
console.log(
  'LOCAL_TRANSCRIPT_DIRS:',
  fs.existsSync(path.join(cfg, 'projects'))
    ? fs.readdirSync(path.join(cfg, 'projects')).join(', ')
    : '(none)',
);
console.log(
  'MINTED_SESSION_ID_HONOURED:',
  [...rows.keys()].every((k) => k.split('/')[1] === mintedSessionId),
  mintedSessionId,
);

// Scenario 2: the mirror drops. The release-blocker path of spec §14.9.
const failing = {
  async append() {
    throw new Error('probe: the mirror is down');
  },
  async load() {
    return null;
  },
};
const run2 = startRun(
  {
    ...request,
    runId: randomUUID(),
    sessionId: randomUUID(),
    session: { kind: 'fresh', sessionId: randomUUID() },
    scope: { projectKey: 'tenant-probe-2', configDir: freshConfigDir('cfg2') },
  },
  { sessionStore: failing },
);
const seen2 = [];
for await (const event of run2.events) {
  if (event.kind === 'system' || event.kind === 'system-unknown')
    seen2.push(`system/${event.subtype}`);
  else if (event.kind === 'result' || event.kind === 'result-unknown')
    seen2.push(`result/${event.subtype}`);
  else if (event.kind === 'event') seen2.push(event.type);
  else seen2.push(event.kind);
}
console.log('FAILING_MIRROR_EVENTS:', JSON.stringify(seen2));
console.log('FAILING_MIRROR_DURABILITY:', JSON.stringify(run2.sessionDurability()));

// Scenario 3: no store at all. §14.9's default, which must never read as durable.
const run3 = startRun({
  ...request,
  runId: randomUUID(),
  sessionId: randomUUID(),
  session: { kind: 'fresh', sessionId: randomUUID() },
  scope: { projectKey: 'tenant-probe-3', configDir: freshConfigDir('cfg3') },
});
for await (const event of run3.events) void event;
console.log('NO_STORE_DURABILITY:', JSON.stringify(run3.sessionDurability()));

// Scenario 4: a scope the SDK would silently ignore must not start a run at all.
try {
  startRun({ ...request, scope: { projectKey: 'con', configDir: cfg } });
  console.log('WINDOWS_DEVICE_SCOPE: NOT REFUSED (bug)');
} catch (error) {
  console.log('WINDOWS_DEVICE_SCOPE_REFUSED:', String(error.message).slice(0, 160));
}
try {
  startRun({ ...request, scope: { projectKey: 'tenant-probe', configDir: '' } });
  console.log('EMPTY_CONFIG_DIR_SCOPE: NOT REFUSED (bug)');
} catch (error) {
  console.log('EMPTY_CONFIG_DIR_REFUSED:', String(error.message).slice(0, 160));
}

// ── Scenarios 5-9: what the `skills` option does and does not close ─────────────────────
//
// Verification round 1 recorded three defects here. These runs are the evidence for the
// corrected wording in claude.ts and in the ADR.

let scopeCounter = 0;
async function skillScenario(label, { prompt, skills, tools, maxTurns = 1 }) {
  scopeCounter += 1;
  const name = `tenant-skills-${scopeCounter}`;
  const run = startRun({
    ...request,
    runId: randomUUID(),
    sessionId: randomUUID(),
    prompt,
    agent: {
      ...request.agent,
      tools: tools ?? request.agent.tools,
      skills,
      limits: { maxTurns, maxBudgetUsd: null },
    },
    session: { kind: 'fresh', sessionId: randomUUID() },
    scope: { projectKey: name, configDir: freshConfigDir(name) },
  });
  let initSkills = null;
  let assistant = '';
  const toolUses = [];
  const toolResults = [];
  for await (const event of run.events) {
    if (event.kind === 'system' && event.subtype === 'init') {
      initSkills = event.event.skills ?? null;
    } else if (event.kind === 'event' && event.type === 'assistant') {
      for (const block of event.event.message?.content ?? []) {
        if (block.type === 'text') assistant += block.text;
        if (block.type === 'tool_use') toolUses.push(`${block.name}(${JSON.stringify(block.input)})`);
      }
    } else if (event.kind === 'event' && event.type === 'user') {
      const content = event.event.message?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === 'tool_result') {
          const c = block.content;
          const asText = typeof c === 'string' ? c : JSON.stringify(c);
          toolResults.push(`is_error=${String(block.is_error === true)} ${asText.slice(0, 200)}`);
        }
      }
    }
  }
  console.log(`\n--- ${label} ---`);
  console.log('  COMPILED_SKILLS:', JSON.stringify(skills.mode === 'all' ? 'all' : skills.names));
  console.log('  PROMPT:', JSON.stringify(prompt));
  console.log('  INIT_SKILLS:', JSON.stringify(initSkills));
  if (toolUses.length > 0) console.log('  TOOL_USES:', JSON.stringify(toolUses));
  if (toolResults.length > 0) console.log('  TOOL_RESULTS:', JSON.stringify(toolResults));
  console.log('  ASSISTANT_TEXT:', JSON.stringify(assistant.trim().slice(0, 320)));
}

const PRESET_TOOLS = {
  base: 'claude_code_preset',
  autoApprove: ['Skill'],
  deny: [],
  permissionMode: 'default',
  allowDangerouslySkipPermissions: false,
};

await skillScenario('S5 skills:[] + a user-typed /dataviz', {
  prompt: '/dataviz\nIn one sentence, say which skill you just loaded.',
  skills: { mode: 'allowlist', names: [] },
});

await skillScenario('S6 skills:"all" + the same prompt', {
  prompt: '/dataviz\nIn one sentence, say which skill you just loaded.',
  skills: { mode: 'all' },
});

await skillScenario('S7 control: skills:[] + a name that is not a skill', {
  prompt: '/zzz-not-a-skill\nReply with one sentence.',
  skills: { mode: 'allowlist', names: [] },
});

await skillScenario('S8 skills:[] + the model-invoked Skill tool', {
  prompt: 'Use the Skill tool to load the skill named claude-api, then reply DONE.',
  skills: { mode: 'allowlist', names: [] },
  tools: PRESET_TOOLS,
  maxTurns: 2,
});

await skillScenario('S9 skills:["claude-api"] + the model-invoked Skill tool', {
  prompt: 'Use the Skill tool to load the skill named claude-api, then reply DONE.',
  skills: { mode: 'allowlist', names: ['claude-api'] },
  tools: PRESET_TOOLS,
  maxTurns: 2,
});
```
