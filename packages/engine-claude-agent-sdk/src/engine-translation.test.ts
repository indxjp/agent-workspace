import type { EngineRunRequest } from '@agent-workspace/engine';
import { skillPlacementVerdict } from '@agent-workspace/engine';
import { createScriptedGateway } from '@agent-workspace/engine/testing';
import { expect, it } from 'vitest';

import { CLAUDE_AGENT_SDK_ENGINE_ID } from './engine.js';
import {
  AGENT,
  CLAUDE_AGENT_SDK_ENGINE_ADAPTER,
  POLICY,
  PROJECT_KEY,
} from './engine.test-support.js';
import { ClaudeRunPolicy } from './policy.js';
import { CLAUDE_PROTECTED_CONFIG_DIRECTORY } from './scope.js';
import { claudeOptionsAllowWrite } from './options-readback.js';

const gateway = createScriptedGateway();
const base: EngineRunRequest = {
  runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
  sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
  projectKey: PROJECT_KEY,
  cwd: '/workspace/conformance',
  prompt: 'go',
  engine: CLAUDE_AGENT_SDK_ENGINE_ID,
  portable: AGENT,
  policy: POLICY,
  session: { mode: 'fresh' },
  gateway: gateway.connection,
  resources: { files: [], skills: [] },
  env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: gateway.connection.token },
};

it('maps the three session modes onto the three legal SDK combinations (R-01 §6)', () => {
  const fresh = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile(base);
  expect(fresh.ok && fresh.compiled.sessionId).toBe(base.sessionId);
  expect(fresh.ok && fresh.compiled.resume).toBeUndefined();

  const resumed = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
    ...base,
    session: { mode: 'resume', engineSessionId: 'c101d922-3c4b-4a12-9b1e-0a1b2c3d4e5f' },
  });
  expect(resumed.ok && resumed.compiled.resume).toBe('c101d922-3c4b-4a12-9b1e-0a1b2c3d4e5f');
  expect(resumed.ok && resumed.compiled.sessionId).toBeUndefined();

  // `fork` is refused before it can be compiled, because the capability set says so. The
  // refusal is what keeps a request the engine cannot honour from being silently narrowed
  // into a fresh session, which is a different conversation.
  const forked = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
    ...base,
    session: { mode: 'fork', engineSessionId: 'c101d922-3c4b-4a12-9b1e-0a1b2c3d4e5f' },
  });
  expect(forked.ok).toBe(false);
  expect(forked.ok ? '' : forked.code).toBe('engine_capability_unsupported');
});

it('refuses subagents as engine_capability_unsupported when the tool policy removes Agent', () => {
  const subagent = {
    name: 'billing-specialist',
    description: 'Answers billing questions.',
    instructions: 'You answer billing questions.',
    model: null,
    permissions: base.portable.permissions,
  };
  const portable = { ...base.portable, subagents: [subagent] };
  const open = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({ ...base, portable });
  expect(open.ok && Object.keys(open.compiled.agents ?? {})).toEqual(['billing-specialist']);
  const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
    ...base,
    portable,
    policy: {
      tools: {
        base: 'claude_code_preset',
        autoApprove: [],
        deny: ['Agent'],
        permissionMode: 'default',
        allowDangerouslySkipPermissions: false,
      },
      fileGrantDeny: [],
    },
  });
  expect(refused.ok ? '' : refused.code).toBe('engine_capability_unsupported');
  expect(refused.ok ? '' : refused.reason).toContain('removes Agent');
});

it('refuses a policy arm it cannot read rather than compiling a default', () => {
  for (const policy of [
    null,
    'claude',
    {},
    { tools: 'claude_code_preset' },
    { tools: null, fileGrantDeny: 'Bash' },
    { tools: null, extra: 1 },
  ]) {
    const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({ ...base, policy });
    expect(refused.ok, JSON.stringify(policy)).toBe(false);
    expect(refused.ok ? '' : refused.code).toBe('engine_policy_invalid');
  }
});

it('derives the policy arm from the catalogue: strict, with fileGrantDeny defaulting to empty (#992)', () => {
  expect(ClaudeRunPolicy.parse({ tools: null })).toEqual({
    tools: null,
    fileGrantDeny: [],
    requireApproval: [],
    handoff: false,
    approvedToolCalls: [],
  });
  expect(ClaudeRunPolicy.safeParse({ tools: null, thinkingLevel: 'high' }).success).toBe(false);
});

it('files a credential-named env entry as engine_credential_refused from the typed verdict', () => {
  // `RunRequest.parse` would also reject this body, with a `ZodError` whose message names
  // ANTHROPIC_API_KEY. The code must come from the sandbox verdict, not from that message.
  const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
    ...base,
    env: { ...base.env, ANTHROPIC_API_KEY: 'sk-ant-real' },
  });
  expect(refused.ok).toBe(false);
  expect(refused.ok ? '' : refused.code).toBe('engine_credential_refused');
  expect(refused.ok ? '' : refused.reason).toContain('must never enter a sandbox');
});

it('files an unrelated parse failure as engine_policy_invalid even when it mentions a credential', () => {
  // An agent whose name mentions every word the old message match looked for: the refusal is a
  // bad policy arm, and its code must not depend on what the sentence happens to contain.
  const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
    ...base,
    policy: { tools: { base: 'sandbox ANTHROPIC_API_KEY AUTH_TOKEN' }, fileGrantDeny: [] },
  });
  expect(refused.ok).toBe(false);
  expect(refused.ok ? '' : refused.code).toBe('engine_policy_invalid');
});

it('compiles a read-only grant into write-tool and shell denials over the normalised path', () => {
  const granted = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
    ...base,
    resources: {
      files: [
        { kind: 'directory', path: './docs/', access: 'read' },
        { kind: 'file', path: 'notes/plan.md', access: 'read-write' },
      ],
      skills: [],
    },
  });
  if (!granted.ok) throw new Error(granted.reason);
  expect(granted.compiled.disallowedTools).toEqual([
    'Edit(//workspace/conformance/docs/**)',
    'Bash',
    'BashOutput',
    'KillShell',
    'Edit(//workspace/conformance/.claude/**)',
    'Edit(//workspace/conformance/.mcp.json)',
    'Edit(//workspace/conformance/CLAUDE.md)',
    'Edit(//workspace/conformance/**/CLAUDE.md)',
  ]);
  expect(claudeOptionsAllowWrite(granted.compiled, 'docs/a/../b.md')).toBe(false);
  expect(claudeOptionsAllowWrite(granted.compiled, 'notes/plan.md')).toBe(true);
});

it('adds nothing to a deny list the control plane already narrowed for the same grant', () => {
  // compose's `applyFileGrantPolicy` writes the same rules into the request; the adapter's
  // de-duplication is what keeps those runs' compiled options exactly what they were.
  const already = ['Edit(//workspace/conformance/docs/**)', 'Bash', 'BashOutput', 'KillShell'];
  const granted = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
    ...base,
    policy: { tools: null, fileGrantDeny: already },
    resources: { files: [{ kind: 'directory', path: 'docs', access: 'read' }], skills: [] },
  });
  if (!granted.ok) throw new Error(granted.reason);
  expect(granted.compiled.disallowedTools).toEqual([
    ...already,
    'Edit(//workspace/conformance/.claude/**)',
    'Edit(//workspace/conformance/.mcp.json)',
    'Edit(//workspace/conformance/CLAUDE.md)',
    'Edit(//workspace/conformance/**/CLAUDE.md)',
  ]);
});

it('refuses a grant into its own configuration directory', () => {
  const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
    ...base,
    resources: {
      files: [{ kind: 'file', path: 'x/../.claude/settings.json', access: 'read' }],
      skills: [],
    },
  });
  expect(refused.ok ? '' : refused.code).toBe('engine_policy_invalid');
});

it('places every granted skill file under CLAUDE_CONFIG_DIR/skills/<name>/ (spec §7, R-01 §8)', () => {
  const skills = [
    {
      name: 'invoice-review',
      files: [
        { path: 'SKILL.md', contentBase64: 'IyBJbnZvaWNlcw==' },
        { path: 'reference/rates.md', contentBase64: 'cmF0ZXM=' },
      ],
    },
  ];
  const placements = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.placeSkills({
    ...base,
    resources: { files: [], skills },
  });
  // The paths this engine chose, byte for byte what `apps/runner/src/resources.ts` wrote before
  // ENG-04b moved the decision behind the port — which is the behaviour-preservation claim for
  // skills: a resumed session finds its transcript and its skills exactly where it left them.
  expect(placements.map((placement) => placement.path)).toEqual([
    '.claude/skills/invoice-review/SKILL.md',
    '.claude/skills/invoice-review/reference/rates.md',
  ]);
  expect(
    skillPlacementVerdict(placements, skills, CLAUDE_PROTECTED_CONFIG_DIRECTORY),
  ).toMatchObject({ ok: true, files: 2 });
  expect(CLAUDE_AGENT_SDK_ENGINE_ADAPTER.placeSkills(base)).toEqual([]);
});

it('refuses a provider credential in the sandbox with its own code', () => {
  const refused = CLAUDE_AGENT_SDK_ENGINE_ADAPTER.compile({
    ...base,
    env: { ...base.env, SOME_PROVIDER_API_KEY: 'sk-live-real-credential' },
  });
  expect(refused.ok).toBe(false);
  expect(refused.ok ? '' : refused.code).toBe('engine_credential_refused');
});

import { vi } from 'vitest';

// The real `compileRunRequest` behind a spy, so a test can count the compiles one start performs.
vi.mock('./compile.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./compile.js')>();
  return { ...original, compileRunRequest: vi.fn(original.compileRunRequest) };
});
