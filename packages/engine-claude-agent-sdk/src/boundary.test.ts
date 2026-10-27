import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ClassifiedSdkEvent } from '@agent-workspace/run-protocol';

import {
  decideToolPermission,
  startRun,
  structuredOutputFailure,
  toSdkOptions,
  type ApprovalState,
} from './boundary.js';
import { CLAUDE_DELEGATION_TOOL } from './compile.js';
import type { ClaudeApprovalGate, CompiledSdkOptions } from './options.js';
import { canonicalCall } from '@indx-workspace/contracts/agents';

// Read as text: only `./boundary.ts` may import the SDK (§42), and the pinned tool names are not
// types (see `CLAUDE_DELEGATION_TOOL`). `toSdkAgents` in `./boundary.ts` assigns every
// `AgentDefinition` field by name, so the typecheck catches a drift in the agent shape.
const sdkDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../node_modules/@anthropic-ai/claude-agent-sdk',
);

const compiled: CompiledSdkOptions = {
  cwd: '/run/claude',
  env: {},
  settingSources: ['project'],
  strictMcpConfig: true,
  mcpServers: {},
  permissionMode: 'default',
  allowedTools: [],
  disallowedTools: [],
  tools: { type: 'preset', preset: 'claude_code' },
  skills: [],
};

describe('toSdkOptions agents', () => {
  it('passes compiled subagents through as the SDK agents option', () => {
    const options = toSdkOptions({
      ...compiled,
      agents: {
        billing: { description: 'Billing.', prompt: 'Answer.', disallowedTools: ['Write'] },
        legal: { description: 'Legal.', prompt: 'Review.', model: 'claude-haiku-4-5' },
      },
    });
    expect(options['agents']).toEqual({
      billing: { description: 'Billing.', prompt: 'Answer.', disallowedTools: ['Write'] },
      legal: { description: 'Legal.', prompt: 'Review.', model: 'claude-haiku-4-5' },
    });
  });

  it('sets no agents option without subagents', () => {
    expect('agents' in toSdkOptions(compiled)).toBe(false);
  });
});

describe('toSdkOptions outputFormat', () => {
  const schema = { type: 'object', properties: { total: { type: 'number' } } };

  it('carries a copy of the compiled output format as the SDK outputFormat option', () => {
    const options = toSdkOptions({ ...compiled, outputFormat: { type: 'json_schema', schema } });
    expect(options['outputFormat']).toEqual({ type: 'json_schema', schema });
    expect((options['outputFormat'] as { schema: unknown }).schema).not.toBe(schema);
  });

  it('sets no outputFormat unless one was compiled', () => {
    expect('outputFormat' in toSdkOptions(compiled)).toBe(false);
  });
});

describe('structuredOutputFailure', () => {
  const result = (subtype: 'error_max_structured_output_retries' | 'success' | 'error_max_turns') =>
    ({
      kind: 'result',
      subtype,
      carriesUsage: true,
      event: { type: 'result', subtype, result: 'model text SENTINEL' },
    }) satisfies ClassifiedSdkEvent;

  it('names output_schema_unsatisfied for the SDK giving up on the schema, without model text', () => {
    const failure = structuredOutputFailure(result('error_max_structured_output_retries'));
    expect(failure?.message).toMatch(/^output_schema_unsatisfied: /u);
    expect(failure?.message).not.toContain('SENTINEL');
  });

  it('is null for every other result and for events that are not results', () => {
    expect(structuredOutputFailure(result('success'))).toBeNull();
    expect(structuredOutputFailure(result('error_max_turns'))).toBeNull();
    expect(
      structuredOutputFailure({ kind: 'system', subtype: 'init', event: { type: 'system' } }),
    ).toBeNull();
  });
});

describe('toSdkOptions run_skill_script', () => {
  const setup = {
    cwd: '/run/claude',
    skillsDirectory: '.claude/skills',
    skills: [{ name: 'review', scripts: ['check.mjs'] }],
    writable: [],
  };

  it('adds the in-process server that carries the tool, beside the connectors', () => {
    const options = toSdkOptions(compiled, { skillScript: setup });
    expect(options['mcpServers']).toMatchObject({
      'agent-workspace': { type: 'sdk', name: 'agent-workspace' },
    });
  });

  it('adds no server without a setup', () => {
    expect(toSdkOptions(compiled)['mcpServers']).toEqual({});
  });

  it('mounts the same server for the handoff tool alone', () => {
    const options = toSdkOptions(compiled, { handoff: { record: () => undefined } });
    expect(options['mcpServers']).toMatchObject({
      'agent-workspace': { type: 'sdk', name: 'agent-workspace' },
    });
  });
});

describe('the delegation tool name', () => {
  it('is the tool the pinned SDK delegates to subagents through', () => {
    const tools = readFileSync(path.join(sdkDir, 'sdk-tools.d.ts'), 'utf8');
    const schemas = /export type ToolInputSchemas =([^;]*);/u.exec(tools)?.[1] ?? '';
    expect(schemas.split('|').map((member) => member.trim())).toContain(
      `${CLAUDE_DELEGATION_TOOL}Input`,
    );
    expect(readFileSync(path.join(sdkDir, 'sdk.d.ts'), 'utf8')).toContain(
      `custom subagent that can be invoked via the ${CLAUDE_DELEGATION_TOOL} tool`,
    );
  });
});

describe('startRun', () => {
  // Both keys are refused by `validateTenantSessionScope` (packages/run-protocol/src/schemas.test.ts).
  it.each(['tenant a', 'con'])(
    'refuses the project key %j before the SDK is reached',
    (projectKey) => {
      expect(() =>
        startRun({ runId: 'run-1', projectKey, prompt: 'go', options: compiled }),
      ).toThrow(/^refusing to start run run-1:/u);
    },
  );
});

describe('toSdkOptions canUseTool (ADR-0145)', () => {
  const gate: ClaudeApprovalGate = {
    requireApproval: ['Write'],
    deferred: [],
    approvedToolCalls: [],
  };

  it('sets canUseTool only when the gate requires approval for some tool', () => {
    const state: ApprovalState = { consumed: new Set(), request: null };
    expect('canUseTool' in toSdkOptions(compiled)).toBe(false);
    expect(
      'canUseTool' in
        toSdkOptions(compiled, { approval: { gate: { ...gate, requireApproval: [] }, state } }),
    ).toBe(false);
    expect(typeof toSdkOptions(compiled, { approval: { gate, state } })['canUseTool']).toBe(
      'function',
    );
  });

  it('makes every gate an ask rule and turns settings hooks off, so project settings cannot settle a gated call', () => {
    const state: ApprovalState = { consumed: new Set(), request: null };
    // A workspace `.claude/settings.json` with `permissions.allow: ['Bash']` is loaded through
    // `settingSources: ['project']`; the flag tier outranks it and ask rules precede allow rules.
    const options = toSdkOptions(compiled, {
      approval: { gate: { ...gate, requireApproval: ['Bash', 'mcp__gh__*'] }, state },
    });
    expect(options['settingSources']).toEqual(['project']);
    expect(options['settings']).toEqual({
      permissions: { ask: ['Bash', 'mcp__gh__*'] },
      disableAllHooks: true,
    });
    expect('settings' in toSdkOptions(compiled)).toBe(false);
  });

  it('records the request into the run state it was given', async () => {
    const state: ApprovalState = { consumed: new Set(), request: null };
    // `toSdkOptions` deliberately types its result without the SDK; this is the SDK's `CanUseTool`.
    const canUseTool = toSdkOptions(compiled, { approval: { gate, state } })['canUseTool'] as
      | ((
          toolName: string,
          input: Record<string, unknown>,
          options: { signal: AbortSignal; toolUseID: string },
        ) => Promise<unknown>)
      | undefined;
    if (canUseTool === undefined) throw new Error('canUseTool is not set');
    await expect(
      canUseTool('Write', { path: 'a' }, { signal: new AbortController().signal, toolUseID: 't1' }),
    ).resolves.toMatchObject({ behavior: 'deny', interrupt: true });
    expect(state.request).toEqual({
      toolName: 'Write',
      toolUseId: 't1',
      canonicalCall: canonicalCall('Write', { path: 'a' }),
    });
  });
});

describe('decideToolPermission (ADR-0145)', () => {
  const fresh = (): ApprovalState => ({ consumed: new Set(), request: null });
  const gate = (overrides: Partial<ClaudeApprovalGate> = {}): ClaudeApprovalGate => ({
    requireApproval: ['mcp__gh__push'],
    deferred: ['mcp__gh__*'],
    approvedToolCalls: [],
    ...overrides,
  });
  const input = { branch: 'main', token: 'SECRET-ARGUMENT' };
  const call = canonicalCall('mcp__gh__push', input);

  it('stops a gated call: denies with interrupt and records the call', () => {
    const state = fresh();
    const decision = decideToolPermission(gate(), state, 'mcp__gh__push', input, 'toolu_1');
    expect(decision).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(state.request).toEqual({
      toolName: 'mcp__gh__push',
      toolUseId: 'toolu_1',
      canonicalCall: call,
    });
  });

  it('never puts the arguments in the message', () => {
    const decision = decideToolPermission(gate(), fresh(), 'mcp__gh__push', input, 'toolu_1');
    expect(decision.behavior === 'deny' && decision.message).not.toContain('SECRET-ARGUMENT');
  });

  it('keeps the first request when the model issues several gated calls', () => {
    const state = fresh();
    decideToolPermission(gate(), state, 'mcp__gh__push', input, 'toolu_1');
    decideToolPermission(gate(), state, 'mcp__gh__push', { branch: 'dev' }, 'toolu_2');
    expect(state.request?.toolUseId).toBe('toolu_1');
  });

  it('allows an approved call once, with its input unchanged, then refuses a replay', () => {
    const state = fresh();
    const approved = gate({ approvedToolCalls: [call] });
    expect(decideToolPermission(approved, state, 'mcp__gh__push', input, 'toolu_1')).toEqual({
      behavior: 'allow',
      updatedInput: input,
    });
    const replay = decideToolPermission(approved, state, 'mcp__gh__push', input, 'toolu_2');
    expect(replay.behavior === 'deny' && replay.message).toMatch(/^approval_already_used/u);
    expect(replay).not.toHaveProperty('interrupt');
    expect(state.request).toBeNull();
  });

  it('refuses a call whose arguments differ from the approved ones, without a new request', () => {
    const state = fresh();
    const decision = decideToolPermission(
      gate({ approvedToolCalls: [call] }),
      state,
      'mcp__gh__push',
      { branch: 'other' },
      'toolu_1',
    );
    expect(decision.behavior === 'deny' && decision.message).toMatch(/^approval_call_mismatch/u);
    expect(state.request).toBeNull();
  });

  it('reads arguments that are not JSON as needing approval, never as approved', () => {
    const state = fresh();
    const decision = decideToolPermission(
      gate(),
      state,
      'mcp__gh__push',
      { when: () => 0 },
      'toolu_1',
    );
    expect(decision.behavior === 'deny' && decision.message).toMatch(/^approval_required/u);
    expect(decision).not.toHaveProperty('interrupt');
    expect(state.request).toBeNull();
  });

  it('allows a tool only a deferred auto-approval covers, and denies anything else', () => {
    expect(decideToolPermission(gate(), fresh(), 'mcp__gh__list', {}, 'toolu_1')).toEqual({
      behavior: 'allow',
      updatedInput: {},
    });
    const other = decideToolPermission(gate(), fresh(), 'Bash', {}, 'toolu_1');
    expect(other).toMatchObject({ behavior: 'deny' });
    expect(other).not.toHaveProperty('interrupt');
  });

  it('never allows a tool through a scoped deferred rule, whose path it cannot read', () => {
    const edits = gate({ requireApproval: ['Write'], deferred: ['Edit(//ws/**)'] });
    expect(
      decideToolPermission(edits, fresh(), 'Edit', { file_path: '/etc/x' }, 't'),
    ).toMatchObject({
      behavior: 'deny',
    });
  });
});
