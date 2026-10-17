/**
 * The pi adapter, behind the port (ENG-08, #307).
 *
 *  1. **The restated version is held to its source.** `PI_CODING_AGENT_VERSION` against this
 *     package's manifest, which pins pi exactly (the issue's "pi moves quickly" risk).
 *  2. **The whole conformance kit reports PASS**, against recorded pi events replayed through the
 *     adapter's own compile, frame mapping, session mirror and durability code — the MCP scenario
 *     as a typed refusal. `boundary.test.ts` drives real pi against a fake gateway.
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
import { describe, expect, it } from 'vitest';

import { PI_CODING_AGENT_VERSION, type PiRunStarter } from './boundary.js';
import type { PiCompiled } from './compile.js';
import { PI_ADAPTER_VERSION, PI_CAPABILITIES, createPiEngine } from './engine.js';
import type { PiEvent } from './frames.js';
import { PI_SESSION_HEADER_TYPE, type PiFileEntry } from './session.js';
import { piPlanAllowsPermission } from './tools.js';
import { workspaceWriteAllowed } from './workspace.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One recorded pi run, as `session.subscribe` delivered it: a read of `a.md`, the tool's answer,
 * a streamed reply and the terminal event the boundary synthesises.
 */
export const RECORDED_PI_RUN: readonly PiEvent[] = [
  { kind: 'pi', event: { type: 'agent_start' } },
  { kind: 'pi', event: { type: 'turn_start' } },
  {
    kind: 'pi',
    event: {
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: 1 },
    },
  },
  {
    kind: 'pi',
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 },
    },
  },
  {
    kind: 'pi',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'toolu_1', name: 'read', arguments: { path: 'a.md' } }],
        responseId: 'msg_1',
        stopReason: 'toolUse',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } },
      },
    },
  },
  {
    kind: 'pi',
    event: {
      type: 'tool_execution_start',
      toolCallId: 'toolu_1',
      toolName: 'read',
      args: { path: 'a.md' },
    },
  },
  {
    kind: 'pi',
    event: {
      type: 'tool_execution_end',
      toolCallId: 'toolu_1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'the document' }] },
      isError: false,
    },
  },
  { kind: 'pi', event: { type: 'turn_end', toolResults: [{}] } },
  {
    kind: 'pi',
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Done.' },
    },
  },
  {
    kind: 'pi',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        responseId: 'msg_2',
        stopReason: 'stop',
        usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } },
      },
    },
  },
  { kind: 'pi', event: { type: 'agent_end', messages: [] } },
  {
    kind: 'run_completed',
    stopReason: 'end_turn',
    turns: 2,
    usage: {
      inputTokens: 22,
      outputTokens: 8,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      costUsd: 0.0002,
    },
  },
];

/**
 * A starter that replays {@link RECORDED_PI_RUN} instead of running pi. It reproduces the two
 * behaviours of the real one the kit asks about: the session is mirrored (pi's header and one
 * entry), and an abort ends the stream.
 */
export function replayingStarter(events: readonly PiEvent[] = RECORDED_PI_RUN): PiRunStarter {
  return async function* (compiled, prompt, deps) {
    if (deps.mirror !== null) {
      const lines: PiFileEntry[] = [
        {
          type: PI_SESSION_HEADER_TYPE,
          version: 3,
          id: compiled.session.engineSessionId,
          timestamp: '2026-09-29T00:00:00.000Z',
          cwd: compiled.workspace.cwd,
        },
        {
          type: 'message',
          id: 'a1b2c3d4',
          parentId: null,
          timestamp: '2026-09-29T00:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: prompt }] },
        },
      ];
      await deps.mirror.persist(lines);
    }
    for (const event of events) {
      if (deps.signal.aborted) {
        yield { kind: 'run_completed', stopReason: 'cancelled', turns: 0, usage: null };
        return;
      }
      yield event;
    }
  };
}

/** The kit's subject. The kit's portable core names no model: pi's own default is compiled. */
function subject(starter: PiRunStarter = replayingStarter()): EngineConformanceSubject<PiCompiled> {
  return {
    engine: createPiEngine(starter),
    gateway: createScriptedGateway({ protocol: 'anthropic-messages' }),
    policy: {},
    unreadablePolicy: { tools: null, fileGrantDeny: [] },
    compiledEnv: (compiled) => compiled.env,
    writeAllowed: (compiled, candidate) => workspaceWriteAllowed(compiled.workspace, candidate),
    permissionAllowed: (compiled, permission) =>
      piPlanAllowsPermission(
        { tools: compiled.agent.tools, networkEgress: compiled.networkEgress },
        permission,
      ),
  };
}

function request(overrides: Partial<EngineRunRequest> = {}): EngineRunRequest {
  return {
    runId: 'r',
    sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
    projectKey: 'tenant-a',
    cwd: '/workspace',
    prompt: 'go',
    engine: 'pi',
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

describe('the pi adapter', () => {
  it('pins the pi version its manifest pins, exactly', () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      version: string;
      dependencies: Record<string, string>;
      agentWorkspace: { engineSdk: string };
    };
    expect(manifest.agentWorkspace.engineSdk).toBe('@earendil-works/pi-coding-agent');
    expect(manifest.dependencies['@earendil-works/pi-coding-agent']).toBe(PI_CODING_AGENT_VERSION);
    expect(PI_ADAPTER_VERSION).toBe(`${manifest.version}+${PI_CODING_AGENT_VERSION}`);
  });

  it('declares what it does: no MCP, skills, resume and fork, adapter-enforced limits, Anthropic Messages', () => {
    expect(PI_CAPABILITIES).toEqual({
      mcp: false,
      skills: true,
      subagents: false,
      resume: true,
      fork: true,
      interrupt: true,
      streamingText: true,
      reasoning: true,
      maxTurns: 'adapter',
      maxBudget: 'adapter',
      wireProtocols: ['anthropic-messages'],
    });
  });

  it('passes every scenario of the engine conformance kit, MCP as a typed refusal', async () => {
    const verdicts = await expectConformance(subject());
    expect(verdicts).toHaveLength(CONFORMANCE_SCENARIOS.length);
    const mcp = verdicts.find(
      (verdict) => verdict.scenario === 'connectors-are-honoured-or-refused-by-name',
    );
    expect(mcp?.pass ? mcp.detail : '').toContain('typed refusal');
  });

  it('reports the session it keyed the store by as the first frame and as engineSessionId', async () => {
    const store = createFakeSessionStore('accept');
    const connection = createPiEngine(replayingStarter()).start(request(), { sessionStore: store });
    const frames = [];
    for await (const frame of connection.frames) frames.push(frame);
    expect(frames[0]).toMatchObject({
      frame: 'agent.session',
      engine: 'pi',
      engineSessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
      model: 'claude-sonnet-4-5',
    });
    expect(await connection.engineSessionId).toBe('2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e');
    expect(frames.map((frame) => frame.frame)).toEqual([
      'agent.session',
      'agent.native',
      'agent.native',
      'agent.native',
      'agent.native',
      'agent.message',
      'agent.tool.call',
      'agent.tool.result',
      'agent.native',
      'agent.message.delta',
      'agent.message',
      'agent.native',
      'agent.usage',
      'agent.result',
    ]);
    expect(connection.sessionDurability()).toEqual({ durable: true, mirroredBatches: 1 });
    expect(store.appended()[0]?.key).toEqual({
      projectKey: 'tenant-a',
      sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
    });
  });

  it('places skills under .pi/skills/<name>/, the one directory the pinned loader reads', () => {
    const placed = createPiEngine(replayingStarter()).placeSkills(
      request({
        resources: {
          files: [],
          skills: [{ name: 'writer', files: [{ path: 'SKILL.md', contentBase64: 'eA==' }] }],
        },
      }),
    );
    expect(placed).toEqual([
      { skill: 'writer', path: '.pi/skills/writer/SKILL.md', contentBase64: 'eA==' },
    ]);
  });

  it('refuses to start a request compile refuses', () => {
    expect(() =>
      createPiEngine(replayingStarter()).start(
        request({
          portable: {
            ...request().portable,
            mcpServers: { docs: { type: 'http', url: 'https://x.test' } },
          },
        }),
      ),
    ).toThrow(/mcp: false/u);
  });
});
