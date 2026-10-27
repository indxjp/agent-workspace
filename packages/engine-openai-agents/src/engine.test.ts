/**
 * The OpenAI Agents adapter, behind the port (ENG-09, #308).
 *
 *  1. **The restated version is held to its source.** `OPENAI_AGENTS_SDK_VERSION` against this
 *     package's manifest, which pins the SDK exactly (the issue's "pre-1.0: pin exactly" risk).
 *  2. **The whole conformance kit reports PASS**, against recorded SDK events replayed through the
 *     adapter's own compile, frame mapping, session and durability code. The kit is the same list
 *     the Claude adapter and the scripted double pass, negative scenarios included.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import type { EngineRunRequest } from '@agent-workspace/engine';
import {
  CONFORMANCE_SCENARIOS,
  createFakeSessionStore,
  createScriptedGateway,
  expectConformance,
  type EngineConformanceSubject,
} from '@agent-workspace/engine/testing';
import { describe, expect, it } from 'vitest';

import { OPENAI_AGENTS_SDK_VERSION, type OpenAiAgentsRunStarter } from './boundary.js';
import type { OpenAiAgentsCompiled } from './compile.js';
import {
  OPENAI_AGENTS_ADAPTER_VERSION,
  OPENAI_AGENTS_CAPABILITIES,
  createOpenAiAgentsEngine,
} from './engine.js';
import type { OpenAiAgentsEvent } from './frames.js';
import { openAiAgentsPlanAllowsPermission } from './tools.js';
import { workspaceWriteAllowed } from './workspace.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One recorded run, as `./boundary.ts` turns the SDK's `RunStreamEvent`s into plain events: a
 * text delta, the assistant message, a tool call and its output, the response usage and the
 * terminal event. The raw items are the SDK's own shapes.
 */
export const RECORDED_OPENAI_AGENTS_RUN: readonly OpenAiAgentsEvent[] = [
  {
    kind: 'raw_model_stream_event',
    data: { type: 'response_started', providerData: {} },
  },
  {
    kind: 'raw_model_stream_event',
    data: { type: 'output_text_delta', itemId: 'msg_01', delta: 'Reading.' },
  },
  {
    kind: 'run_item_stream_event',
    name: 'tool_called',
    item: {
      type: 'tool_call_item',
      rawItem: {
        type: 'function_call',
        callId: 'call_01',
        name: 'read_file',
        arguments: '{"path":"a.md"}',
      },
    },
  },
  {
    kind: 'run_item_stream_event',
    name: 'tool_output',
    item: {
      type: 'tool_call_output_item',
      rawItem: {
        type: 'function_call_result',
        callId: 'call_01',
        name: 'read_file',
        status: 'completed',
        output: { type: 'text', text: 'the document' },
      },
      output: 'the document',
    },
  },
  {
    kind: 'run_item_stream_event',
    name: 'message_output_created',
    item: {
      type: 'message_output_item',
      rawItem: {
        type: 'message',
        role: 'assistant',
        id: 'msg_01',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Reading. Done.' }],
      },
    },
  },
  {
    kind: 'raw_model_stream_event',
    data: {
      type: 'response_done',
      response: { id: 'resp_01', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
    },
  },
  { kind: 'agent_updated_stream_event', agentName: 'Conformance agent' },
  {
    kind: 'run_completed',
    stopReason: 'end_turn',
    turns: 1,
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: null, reasoningTokens: null },
  },
];

/**
 * A starter that replays {@link RECORDED_OPENAI_AGENTS_RUN} instead of calling the SDK.
 *
 * It reproduces the two behaviours of the real one the kit asks about: the session is written
 * (the SDK's runner calls `addItems` with the turn's items), and an abort ends the stream.
 */
export function replayingStarter(
  events: readonly OpenAiAgentsEvent[] = RECORDED_OPENAI_AGENTS_RUN,
): OpenAiAgentsRunStarter {
  return async function* (_compiled, prompt, deps) {
    if (deps.session !== null) {
      await deps.session.addItems([{ role: 'user', content: prompt }]);
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

/**
 * The kit's subject. The kit's portable core names no model, which is the SDK's default model on
 * an OpenAI-family connection and a refusal on an Anthropic-family one (the AI SDK adapter has no
 * default), so the kit is run over each OpenAI dialect; `compile.test.ts` covers Messages.
 */
function subject(
  protocol: 'openai-responses' | 'openai-chat-completions' = 'openai-responses',
  starter: OpenAiAgentsRunStarter = replayingStarter(),
): EngineConformanceSubject<OpenAiAgentsCompiled> {
  return {
    engine: createOpenAiAgentsEngine(starter),
    gateway: createScriptedGateway({ protocol }),
    policy: {},
    unreadablePolicy: { tools: null, fileGrantDeny: [] },
    compiledEnv: (compiled) => compiled.env,
    writeAllowed: (compiled, candidate) => workspaceWriteAllowed(compiled.workspace, candidate),
    permissionAllowed: (compiled, permission) =>
      openAiAgentsPlanAllowsPermission(
        { tools: compiled.agent.tools, networkEgress: compiled.networkEgress },
        permission,
      ),
    connectorsCompiled: (compiled) => compiled.mcpServers.map((server) => server.name),
    subagentsCompiled: (compiled) => compiled.subagents.map((subagent) => subagent.name),
    outputSchemaCompiled: (compiled) => compiled.outputSchema ?? undefined,
  };
}

const REQUEST: EngineRunRequest = {
  runId: 'r',
  sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
  projectKey: 'tenant-a',
  cwd: '/workspace',
  prompt: 'go',
  engine: 'openai-agents',
  portable: {
    name: 'A',
    instructions: '',
    model: 'gpt-5',
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
  gateway: { baseUrl: 'http://gateway.invalid', token: 't', protocol: 'openai-responses' },
  resources: { files: [], skills: [] },
  env: {},
};

describe('the OpenAI Agents adapter', () => {
  it('pins the SDK version its manifest pins, exactly', () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      version: string;
      dependencies: Record<string, string>;
      agentWorkspace: { engineSdk: string };
    };
    expect(manifest.agentWorkspace.engineSdk).toBe('@openai/agents');
    expect(manifest.dependencies['@openai/agents']).toBe(OPENAI_AGENTS_SDK_VERSION);
    expect(OPENAI_AGENTS_ADAPTER_VERSION).toBe(`${manifest.version}+${OPENAI_AGENTS_SDK_VERSION}`);
  });

  it('declares what it does: no skills, no fork, an adapter-enforced (provisional) budget, three protocols with Responses first', () => {
    expect(OPENAI_AGENTS_CAPABILITIES).toEqual({
      mcp: true,
      skills: false,
      subagents: true,
      resume: true,
      fork: false,
      interrupt: true,
      streamingText: true,
      reasoning: true,
      maxTurns: 'native',
      maxBudget: 'adapter',
      wireProtocols: ['openai-responses', 'openai-chat-completions', 'anthropic-messages'],
    });
  });

  it('declares structured output in the catalogue', () => {
    expect(ENGINE_CATALOGUE['openai-agents'].structuredOutput).toBe(true);
  });

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'passes every scenario of the engine conformance kit over %s',
    async (protocol) => {
      const verdicts = await expectConformance(subject(protocol));
      expect(verdicts).toHaveLength(CONFORMANCE_SCENARIOS.length);
      const skills = verdicts.find(
        (verdict) => verdict.scenario === 'skills-are-placed-inside-the-declared-config-directory',
      );
      expect(skills?.pass ? skills.detail : '').toContain('skills: false declared');
    },
  );

  it('reports the session it keyed the store by as the first frame and as engineSessionId', async () => {
    const engine = createOpenAiAgentsEngine(replayingStarter());
    const connection = engine.start({
      runId: 'r',
      sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
      projectKey: 'tenant-a',
      cwd: '/workspace',
      prompt: 'go',
      engine: 'openai-agents',
      portable: {
        name: 'A',
        instructions: '',
        model: 'gpt-5',
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
      session: { mode: 'resume', engineSessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e' },
      gateway: { baseUrl: 'http://gateway.invalid', token: 't', protocol: 'openai-responses' },
      resources: { files: [], skills: [] },
      env: {},
    });
    const frames = [];
    for await (const frame of connection.frames) frames.push(frame);
    expect(frames[0]).toMatchObject({
      frame: 'agent.session',
      engine: 'openai-agents',
      engineSessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
    });
    expect(await connection.engineSessionId).toBe('2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e');
    expect(frames.map((frame) => frame.frame)).toEqual([
      'agent.session',
      'agent.native',
      'agent.message.delta',
      'agent.tool.call',
      'agent.tool.result',
      'agent.message',
      'agent.native',
      'agent.native',
      'agent.usage',
      'agent.result',
    ]);
  });

  it('yields one agent.session frame, then the cancelled result, for a run interrupted before it started', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const connection = createOpenAiAgentsEngine(replayingStarter()).start(REQUEST, {
      abortController,
    });
    const frames = [];
    for await (const frame of connection.frames) frames.push(frame);
    expect(frames.map((frame) => frame.frame)).toEqual(['agent.session', 'agent.result']);
    expect(frames[1]).toMatchObject({ frame: 'agent.result', stopReason: 'cancelled' });
  });

  it('reports a completed run whose store accepted no write as not durable, in the kit wording', async () => {
    const silent: OpenAiAgentsRunStarter = async function* () {
      await Promise.resolve();
      yield { kind: 'run_completed', stopReason: 'end_turn', turns: 1, usage: null };
    };
    const connection = createOpenAiAgentsEngine(silent).start(REQUEST, {
      sessionStore: createFakeSessionStore('accept'),
    });
    for await (const frame of connection.frames) void frame;
    expect(connection.sessionDurability()).toEqual({
      durable: false,
      reason: 'the session store accepted no write for this run.',
    });
  });
});
