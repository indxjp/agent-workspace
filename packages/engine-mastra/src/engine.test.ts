/**
 * The Mastra adapter, behind the port (ENG-10, #309).
 *
 *  1. **The restated version is held to its source.** `MASTRA_CORE_VERSION` against this package's
 *     manifest, which pins Mastra exactly (the issue's "Mastra releases very frequently" risk).
 *  2. **The whole conformance kit reports PASS**, against recorded Mastra chunks replayed through
 *     the adapter's own compile, frame mapping, memory journal and durability code — the MCP
 *     scenario as an honoured connector. `boundary.test.ts` drives real Mastra against a fake
 *     gateway.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EngineRunRequest } from '@agent-workspace/engine';
import {
  CONFORMANCE_SCENARIOS,
  createFakeSessionStore,
  createScriptedGateway,
  expectConformance,
  type EngineConformanceSubject,
} from '@agent-workspace/engine/testing';
import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import { describe, expect, it } from 'vitest';

import { MASTRA_CORE_VERSION, type MastraRunStarter } from './boundary.js';
import type { MastraCompiled } from './compile.js';
import { MASTRA_ADAPTER_VERSION, MASTRA_CAPABILITIES, createMastraEngine } from './engine.js';
import type { MastraEvent } from './frames.js';
import { messageEntry, threadEntry } from './session.js';
import { mastraPlanAllowsPermission } from './tools.js';
import { mastraWriteAllowed } from './workspace.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function chunk(type: string, payload: Record<string, unknown> = {}): MastraEvent {
  return { kind: 'mastra', chunk: { type, runId: 'mastra-run', from: 'AGENT', payload } };
}

/**
 * One recorded Mastra run, as `fullStream` delivered it (shapes captured from `@mastra/core`
 * 1.71.0 against the scripted gateway): a read of `a.md`, the tool's answer, a streamed reply and
 * the terminal event the boundary builds from `finish`.
 */
export const RECORDED_MASTRA_RUN: readonly MastraEvent[] = [
  chunk('start', { id: 'agent-workspace', messageId: 'm-1' }),
  chunk('step-start', { messageId: 'm-1' }),
  chunk('tool-call-input-streaming-start', {
    toolCallId: 'toolu_1',
    toolName: 'mastra_workspace_read_file',
  }),
  chunk('tool-call', {
    toolCallId: 'toolu_1',
    toolName: 'mastra_workspace_read_file',
    args: { path: 'a.md' },
  }),
  chunk('tool-result', {
    toolCallId: 'toolu_1',
    toolName: 'mastra_workspace_read_file',
    args: { path: 'a.md' },
    result: 'a.md (9 bytes)\n     1→hello doc',
  }),
  chunk('step-finish', {
    stepResult: { reason: 'tool-calls', isContinued: true },
    output: { usage: { inputTokens: 10, outputTokens: 5 } },
  }),
  chunk('step-start', { messageId: 'm-1' }),
  chunk('text-start', { id: 'text-1' }),
  chunk('text-delta', { id: 'text-1', text: 'Done.' }),
  chunk('text-end', { type: 'text-end', id: 'text-1' }),
  chunk('step-finish', {
    stepResult: { reason: 'stop', isContinued: false },
    output: { usage: { inputTokens: 12, outputTokens: 3 } },
  }),
  {
    kind: 'run_completed',
    stopReason: 'end_turn',
    steps: 2,
    usage: {
      inputTokens: 22,
      outputTokens: 8,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: null,
      costUsd: 0,
    },
    finish: { type: 'finish', payload: { stepResult: { reason: 'stop' } } },
  },
];

/**
 * A starter that replays {@link RECORDED_MASTRA_RUN} instead of running Mastra. It reproduces the
 * two behaviours of the real one the kit asks about: the thread is journalled (the thread record
 * and the user message), and an abort ends the stream.
 */
export function replayingStarter(
  events: readonly MastraEvent[] = RECORDED_MASTRA_RUN,
): MastraRunStarter {
  return async function* (compiled, prompt, deps) {
    if (deps.journal !== null) {
      const now = new Date('2026-09-29T00:00:00.000Z');
      await deps.journal.record([
        threadEntry({
          id: compiled.memory.threadId,
          resourceId: compiled.memory.resourceId,
          createdAt: now,
          updatedAt: now,
        }),
        messageEntry({
          id: 'user-1',
          role: 'user',
          threadId: compiled.memory.threadId,
          resourceId: compiled.memory.resourceId,
          createdAt: now,
          content: { format: 2, parts: [{ type: 'text', text: prompt }] },
        }),
      ]);
    }
    for (const event of events) {
      if (deps.signal.aborted) {
        yield {
          kind: 'run_completed',
          stopReason: 'cancelled',
          steps: 0,
          usage: null,
          finish: null,
        };
        return;
      }
      yield event;
    }
  };
}

/** The kit's subject. The kit's portable core names no model: the adapter's default is compiled. */
function subject(
  starter: MastraRunStarter = replayingStarter(),
): EngineConformanceSubject<MastraCompiled> {
  return {
    engine: createMastraEngine(starter),
    gateway: createScriptedGateway({ protocol: 'anthropic-messages' }),
    policy: {},
    unreadablePolicy: { toolCallConcurrency: 0 },
    compiledEnv: (compiled) => compiled.env,
    writeAllowed: (compiled, candidate) => mastraWriteAllowed(compiled.workspace, candidate),
    permissionAllowed: (compiled, permission) =>
      mastraPlanAllowsPermission(
        { tools: compiled.agent.tools, networkEgress: compiled.networkEgress },
        permission,
      ),
    connectorsCompiled: (compiled) => compiled.mcpServers.map((server) => server.name),
    subagentsCompiled: (compiled) => compiled.subagents.map((subagent) => subagent.name),
    outputSchemaCompiled: (compiled) => compiled.outputSchema ?? undefined,
  };
}

const SESSION = '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e';

function request(overrides: Partial<EngineRunRequest> = {}): EngineRunRequest {
  return {
    runId: 'r',
    sessionId: SESSION,
    projectKey: 'tenant-a',
    cwd: '/workspace',
    prompt: 'go',
    engine: 'mastra',
    portable: {
      name: 'A',
      instructions: '',
      model: 'claude-sonnet-4-5',
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: false,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policy: {},
    session: { mode: 'fresh' },
    gateway: { baseUrl: 'http://gateway.invalid', token: 't', protocol: 'anthropic-messages' },
    resources: { files: [], skills: [] },
    env: {},
    ...overrides,
  };
}

describe('the Mastra adapter', () => {
  it('pins the Mastra version its manifest pins, exactly', () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      version: string;
      dependencies: Record<string, string>;
      agentWorkspace: { engineSdk: string };
    };
    expect(manifest.agentWorkspace.engineSdk).toBe('@mastra/core');
    expect(manifest.dependencies['@mastra/core']).toBe(MASTRA_CORE_VERSION);
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      if (!version.startsWith('workspace:')) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/u);
    }
    expect(MASTRA_ADAPTER_VERSION).toBe(`${manifest.version}+${MASTRA_CORE_VERSION}`);
  });

  it('declares what it does: MCP, skills, resume without fork, native steps, three protocols', () => {
    expect(MASTRA_CAPABILITIES).toEqual({
      mcp: true,
      skills: true,
      subagents: true,
      resume: true,
      fork: false,
      interrupt: true,
      streamingText: true,
      reasoning: true,
      maxTurns: 'native',
      maxBudget: 'adapter',
      wireProtocols: ['anthropic-messages', 'openai-responses', 'openai-chat-completions'],
    });
  });

  it('declares structured output in the catalogue', () => {
    expect(ENGINE_CATALOGUE.mastra.structuredOutput).toBe(true);
  });

  it('passes every scenario of the engine conformance kit, MCP as an honoured connector', async () => {
    const verdicts = await expectConformance(subject());
    expect(verdicts).toHaveLength(CONFORMANCE_SCENARIOS.length);
    const mcp = verdicts.find(
      (verdict) => verdict.scenario === 'connectors-are-honoured-or-refused-by-name',
    );
    expect(mcp?.pass).toBe(true);
    expect(mcp?.pass === true ? mcp.detail : '').not.toContain('typed refusal');
  });

  it('reports the thread it keyed the store by as the first frame and as engineSessionId', async () => {
    const store = createFakeSessionStore('accept');
    const connection = createMastraEngine(replayingStarter()).start(request(), {
      sessionStore: store,
    });
    const frames = [];
    for await (const frame of connection.frames) frames.push(frame);
    expect(frames[0]).toMatchObject({
      frame: 'agent.session',
      engine: 'mastra',
      engineSessionId: SESSION,
      model: 'claude-sonnet-4-5',
    });
    expect(await connection.engineSessionId).toBe(SESSION);
    expect(frames.map((frame) => frame.frame)).toEqual([
      'agent.session',
      'agent.native',
      'agent.native',
      'agent.native',
      'agent.tool.call',
      'agent.tool.result',
      'agent.native',
      'agent.native',
      'agent.native',
      'agent.message.delta',
      'agent.message',
      'agent.native',
      'agent.usage',
      'agent.result',
    ]);
    expect(frames.at(-1)).toMatchObject({ stopReason: 'end_turn', turns: 2 });
    expect(connection.sessionDurability()).toEqual({ durable: true, mirroredBatches: 1 });
    expect(store.appended()[0]?.key).toEqual({ projectKey: 'tenant-a', sessionId: SESSION });
  });

  it('ends a run whose error chunk became agent.result as completed, with no second result', async () => {
    const store = createFakeSessionStore('accept');
    const connection = createMastraEngine(
      replayingStarter([chunk('start'), chunk('error', { error: { message: 'upstream 529' } })]),
    ).start(request(), { sessionStore: store });
    const frames = [];
    for await (const frame of connection.frames) frames.push(frame);
    expect(frames.filter((frame) => frame.frame === 'agent.result')).toEqual([
      expect.objectContaining({ stopReason: 'error' }),
    ]);
    expect(connection.sessionDurability().durable).toBe(true);
  });

  it('counts a trailing error chunk as the terminal event for durability', async () => {
    const silent: MastraRunStarter = async function* () {
      await Promise.resolve();
      yield chunk('start');
      yield chunk('error', { error: { message: 'upstream 529' } });
    };
    const connection = createMastraEngine(silent).start(request(), {
      sessionStore: createFakeSessionStore('accept'),
    });
    for await (const frame of connection.frames) void frame;
    expect(connection.sessionDurability()).toEqual({
      durable: false,
      reason: 'the session store accepted no write for this run.',
    });
  });

  it('places skills under .mastra/skills/<name>/, the directories the workspace discovers', () => {
    const placed = createMastraEngine(replayingStarter()).placeSkills(
      request({
        resources: {
          files: [],
          skills: [{ name: 'writer', files: [{ path: 'SKILL.md', contentBase64: 'eA==' }] }],
        },
      }),
    );
    expect(placed).toEqual([
      { skill: 'writer', path: '.mastra/skills/writer/SKILL.md', contentBase64: 'eA==' },
    ]);
  });

  it('refuses to start a request compile refuses', () => {
    expect(() =>
      createMastraEngine(replayingStarter()).start(
        request({ session: { mode: 'fork', engineSessionId: 'other' } }),
      ),
    ).toThrow(/fork: false/u);
  });
});
