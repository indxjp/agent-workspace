import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EngineRefusalError } from '@agent-workspace/engine';
import type { ClassifiedSdkEvent } from '@agent-workspace/run-protocol';

import {
  decideToolPermission,
  normalise,
  normaliseMirrored,
  RESULT_LINGER_MS,
  startRun,
  structuredOutputFailure,
  toSdkOptions,
  type ApprovalState,
} from './boundary.js';
import { CLAUDE_DELEGATION_TOOL } from './compile.js';
import { newRunState } from './run-state.js';
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

  it("drops the schema's top-level $schema, which Claude Code's validator cannot resolve", () => {
    const named = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema };
    const options = toSdkOptions({
      ...compiled,
      outputFormat: { type: 'json_schema', schema: named },
    });
    expect(options['outputFormat']).toEqual({ type: 'json_schema', schema });
    expect(named.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
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

describe('toSdkOptions translation refusals', () => {
  const bare: Omit<CompiledSdkOptions, 'tools' | 'skills'> = {
    cwd: compiled.cwd,
    env: compiled.env,
    settingSources: compiled.settingSources,
    strictMcpConfig: compiled.strictMcpConfig,
    mcpServers: compiled.mcpServers,
    permissionMode: compiled.permissionMode,
    allowedTools: compiled.allowedTools,
    disallowedTools: compiled.disallowedTools,
  };
  it.each<[string, CompiledSdkOptions]>([
    ['no tools', { ...bare, skills: [] }],
    ['no skills', { ...bare, tools: [] }],
    ['an untranslatable skills value', { ...bare, tools: [], skills: 7 as unknown as [] }],
    [
      'an untranslatable tools value',
      { ...bare, skills: [], tools: { type: 'preset', preset: 'other' } as unknown as [] },
    ],
  ])('refuses %s as a typed engine_policy_invalid refusal', (_name, options) => {
    let thrown: unknown = null;
    try {
      toSdkOptions(options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EngineRefusalError);
    expect(thrown).toMatchObject({ code: 'engine_policy_invalid' });
  });

  it('refuses the same way at startRun, before the SDK is reached', () => {
    expect(() =>
      startRun({
        runId: 'run-1',
        projectKey: 'tenant-a',
        prompt: 'go',
        options: { ...bare, skills: [] },
      }),
    ).toThrow(EngineRefusalError);
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
    ask: ['Write'],
  };

  it('sets canUseTool only when the gate requires approval for some tool', () => {
    const state: ApprovalState = { consumed: new Set(), request: null, denied: [] };
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
    const state: ApprovalState = { consumed: new Set(), request: null, denied: [] };
    // A workspace `.claude/settings.json` with `permissions.allow: ['Bash']` is loaded through
    // `settingSources: ['project']`; the flag tier outranks it and ask rules precede allow rules.
    const options = toSdkOptions(compiled, {
      approval: {
        gate: { ...gate, requireApproval: ['Bash', 'mcp__gh__*'], ask: ['Bash', 'mcp__gh__*'] },
        state,
      },
    });
    expect(options['settingSources']).toEqual(['project']);
    expect(options['settings']).toEqual({
      permissions: { ask: ['Bash', 'mcp__gh__*'] },
      disableAllHooks: true,
    });
    expect('settings' in toSdkOptions(compiled)).toBe(false);
  });

  it("asks through canUseTool but writes no ask rule for Run commands' own gate (#2091)", () => {
    // Claude Code keeps running a read-only command, and an allowed one, without asking; only a
    // command it would have refused reaches canUseTool. Hooks stay on, as for any run.
    const state: ApprovalState = { consumed: new Set(), request: null, denied: [] };
    const options = toSdkOptions(compiled, {
      approval: { gate: { ...gate, requireApproval: ['Bash'], ask: [] }, state },
    });
    expect(typeof options['canUseTool']).toBe('function');
    expect('settings' in options).toBe(false);
    const both = toSdkOptions(compiled, {
      approval: { gate: { ...gate, requireApproval: ['Write', 'Bash'], ask: ['Write'] }, state },
    });
    expect(both['settings']).toEqual({ permissions: { ask: ['Write'] }, disableAllHooks: true });
  });

  it('records the request into the run state it was given', async () => {
    const state: ApprovalState = { consumed: new Set(), request: null, denied: [] };
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
  const fresh = (): ApprovalState => ({ consumed: new Set(), request: null, denied: [] });
  const gate = (overrides: Partial<ClaudeApprovalGate> = {}): ClaudeApprovalGate => ({
    requireApproval: ['mcp__gh__push'],
    deferred: ['mcp__gh__*'],
    approvedToolCalls: [],
    ask: ['mcp__gh__push'],
    ...overrides,
  });
  const input = { branch: 'main', token: 'SECRET-ARGUMENT' };
  const call = canonicalCall('mcp__gh__push', input);

  it('records a call no rule allows, and nothing for a gated or deferred one', () => {
    const state = fresh();
    decideToolPermission(gate(), state, 'Write', { file_path: '/a' }, 'toolu_w');
    decideToolPermission(gate(), state, 'mcp__gh__push', input, 'toolu_g');
    decideToolPermission(gate(), state, 'mcp__gh__list', {}, 'toolu_d');
    expect(state.denied).toEqual([
      {
        toolName: 'Write',
        toolUseId: 'toolu_w',
        message: "Write is not allowed by this agent's tool policy.",
      },
    ]);
  });

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

describe('normalise: a run ends with its result (issue #2076)', () => {
  const failedCall = {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', content: 'ECONNREFUSED', is_error: true, tool_use_id: 't' }],
    },
  };
  const result = { type: 'result', subtype: 'success', result: 'done' };

  /** `messages`, then a read that never settles; it records each `return()`. */
  function lingeringStream(messages: readonly unknown[]) {
    const seen = { returned: 0 };
    let index = 0;
    const iterator: AsyncIterator<unknown> = {
      next: () =>
        index < messages.length
          ? Promise.resolve({ done: false, value: messages[index++] })
          : new Promise<IteratorResult<unknown>>(() => undefined),
      return: () => {
        seen.returned += 1;
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    return { source: { [Symbol.asyncIterator]: () => iterator }, seen };
  }

  async function kindsOf(events: AsyncGenerator<ClassifiedSdkEvent, void, void>) {
    const kinds: string[] = [];
    for await (const event of events) kinds.push(event.kind);
    return kinds;
  }

  it('ends a run whose tool call failed and whose stream stays open after its result', async () => {
    const { source, seen } = lingeringStream([failedCall, result]);
    const aborts: Error[] = [];
    const started = Date.now();

    const kinds = await kindsOf(
      normalise(source, { ms: 20, abort: (reason) => void aborts.push(reason) }),
    );

    expect(kinds).toStrictEqual(['event', 'result']);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(aborts.map((reason) => reason.message)).toStrictEqual([
      "the SDK stream stayed open 20 ms after the run's result",
    ]);
    expect(seen.returned).toBe(1);
  });

  it("reports a call canUseTool refused by policy as the SDK's own permission_denied (#2091)", async () => {
    // With a gate, canUseTool settles every call that asks; one no rule allows is refused there and
    // the SDK sends no permission_denied of its own, so the console's notice (#2207) needs this.
    const state = newRunState(false);
    const gate: ClaudeApprovalGate = {
      requireApproval: ['Bash'],
      deferred: [],
      approvedToolCalls: [],
      ask: [],
    };
    const toolResult = {
      type: 'user',
      session_id: 'session-1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_w', is_error: true }],
      },
    };
    async function* refusedWrite() {
      yield { type: 'system', subtype: 'init', session_id: 'session-1' };
      // The SDK asks canUseTool between two messages; the gap stands in for that.
      await Promise.resolve();
      expect(
        decideToolPermission(gate, state.approval, 'Write', { file_path: '/a' }, 'toolu_w'),
      ).toMatchObject({
        behavior: 'deny',
      });
      yield toolResult;
    }

    const events: ClassifiedSdkEvent[] = [];
    for await (const event of normalise(
      refusedWrite(),
      { ms: 10, abort: () => undefined },
      state,
    )) {
      events.push(event);
    }

    const denied = events.filter(
      (event) => event.kind === 'system' && event.subtype === 'permission_denied',
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]?.event).toMatchObject({
      tool_name: 'Write',
      tool_use_id: 'toolu_w',
      session_id: 'session-1',
      message: "Write is not allowed by this agent's tool policy.",
    });
    // Before the refused call's tool result, as the SDK orders its own.
    expect(events.indexOf(denied[0] as ClassifiedSdkEvent)).toBe(1);
    expect(state.approval.denied).toEqual([]);
  });

  it('still reports a refusal the stream ends right after', async () => {
    const state = newRunState(false);
    state.approval.denied.push({ toolName: 'Edit', toolUseId: 'toolu_e', message: 'no' });
    const kinds: string[] = [];
    async function* empty() {}
    for await (const event of normalise(empty(), { ms: 10, abort: () => undefined }, state)) {
      kinds.push(event.kind === 'system' ? event.subtype : event.kind);
    }
    expect(kinds).toEqual(['permission_denied']);
  });

  it('waits for a slow result, and aborts nothing when the stream closes', async () => {
    async function* slow() {
      yield failedCall;
      await new Promise((resolve) => setTimeout(resolve, 60));
      yield result;
    }
    const aborts: Error[] = [];

    const kinds = await kindsOf(
      normalise(slow(), { ms: 10, abort: (reason) => void aborts.push(reason) }),
    );

    expect(kinds).toStrictEqual(['event', 'result']);
    expect(aborts).toStrictEqual([]);
  });

  /** A mirror that keeps nothing; each run below hands it one batch, as the SDK would. */
  const mirror = {
    append: () => Promise.resolve(),
    load: () => Promise.resolve(null),
  };
  const key = { projectKey: 'tenant-a', sessionId: 'session-1' };

  it('never calls a session durable once the stream was aborted after its result', async () => {
    const { source } = lingeringStream([failedCall, result]);
    const run = normaliseMirrored(source, { ms: 20, abort: () => undefined }, mirror);
    await run.sessionStore.append(key, []);

    expect(await kindsOf(run.events)).toStrictEqual(['event', 'result']);
    expect(run.sessionDurability()).toStrictEqual({
      durable: false,
      reason:
        "the SDK stream was aborted after the run's result because it stayed open past the linger window, so the CLI may have been stopped before its last transcript batch was mirrored.",
    });
  });

  it('calls the same mirrored run durable when its stream closes on its own', async () => {
    const messages: readonly unknown[] = [failedCall, result];
    let index = 0;
    const closes: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.resolve<IteratorResult<unknown>>(
            index < messages.length
              ? { done: false, value: messages[index++] }
              : { done: true, value: undefined },
          ),
      }),
    };
    const run = normaliseMirrored(closes, { ms: 20, abort: () => undefined }, mirror);
    await run.sessionStore.append(key, []);

    expect(await kindsOf(run.events)).toStrictEqual(['event', 'result']);
    expect(run.sessionDurability()).toStrictEqual({ durable: true, mirroredBatches: 1 });
  });

  it('gives a lingering stream seconds, far below a run credential lifetime', () => {
    expect(RESULT_LINGER_MS).toBeLessThanOrEqual(10_000);
  });
});
