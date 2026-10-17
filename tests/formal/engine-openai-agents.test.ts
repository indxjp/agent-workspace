/**
 * `engine-openai-agents`: the OpenAI Agents SDK adapter (ENG-09, #308), replayed against the real
 * TypeScript in `@agent-workspace/engine-openai-agents`.
 *
 * Six files, one per decision the Lean model makes: `compile.json` (`compileOpenAiAgentsRun`),
 * `tool-plan.json` (`openAiAgentsToolPlan`), `connection.json` (`openAiAgentsModelConnection`),
 * `write.json` (`workspaceWriteAllowed`), `events.json` (`createOpenAiAgentsFrameMapper`) and
 * `session.json` (`EngineStoreSession` over a list store), and `engine-switch.json`
 * (`translatePolicyForEngineSwitch` from the contracts, with `policyNarrowedPermissions` and
 * `openAiAgentsToolPlan` under the carried arm — ADR-0074 D12).
 *
 * The model is SDK-free, like the code it mirrors, so nothing here reaches the SDK. What happens
 * inside it — model requests only through the compiled client, `setTracingDisabled(true)` before
 * `run`, native `maxTurns` — is the family's declared hypothesis, enforced by the package's own
 * boundary suite (docs/formal/units/engine-openai-agents.md, "Declared gaps").
 *
 * Under D-012 this file is in `tests/formal/`: every subject is a package export.
 */
import {
  normaliseGrants,
  type EngineRunRequest,
  type EngineSessionKey,
  type EngineSessionStore,
  type EngineTranscriptEntry,
} from '@agent-workspace/engine';
import {
  compileOpenAiAgentsRun,
  createOpenAiAgentsFrameMapper,
  EngineStoreSession,
  OPENAI_AGENTS_PROTECTED_CONFIG_DIRECTORY,
  openAiAgentsModelConnection,
  openAiAgentsToolPlan,
  workspaceWriteAllowed,
  type OpenAiAgentsEvent,
  type OpenAiAgentsWireProtocol,
} from '@agent-workspace/engine-openai-agents';
import {
  AgentPolicySchema,
  policyNarrowedPermissions,
  translatePolicyForEngineSwitch,
  type AgentPermissions,
  type AgentPolicy,
} from '@indx-workspace/contracts/agents';
import type { AgentStopReason } from '@indx-workspace/contracts/run-events';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const FAMILY = 'engine-openai-agents';

function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${what}: expected a boolean`);
  return value;
}

function optString(value: unknown, what: string): string | null {
  return value === null ? null : asString(value, what);
}

function optNumber(value: unknown, what: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number') throw new Error(`${what}: expected a number`);
  return value;
}

function array(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value as readonly unknown[];
}

function permissions(value: unknown): AgentPermissions {
  const record = asRecord(value, 'permissions');
  return {
    readFiles: bool(record['readFiles'], 'readFiles'),
    writeFiles: bool(record['writeFiles'], 'writeFiles'),
    runCommands: bool(record['runCommands'], 'runCommands'),
    unrestrictedNetwork: bool(record['unrestrictedNetwork'], 'unrestrictedNetwork'),
  };
}

type VectorGrant = { directory: boolean; path: string; readOnly: boolean };

function grants(value: unknown): VectorGrant[] {
  return array(value, 'grants').map((entry) => {
    const record = asRecord(entry, 'grant');
    return {
      directory: bool(record['directory'], 'directory'),
      path: asString(record['path'], 'path'),
      readOnly: bool(record['readOnly'], 'readOnly'),
    };
  });
}

function fileGrants(list: readonly VectorGrant[]) {
  return list.map((grant) => ({
    kind: grant.directory ? ('directory' as const) : ('file' as const),
    path: grant.path,
    access: grant.readOnly ? ('read' as const) : ('read-write' as const),
  }));
}

/** The model's `Request` as the port's `EngineRunRequest`. */
function requestFrom(input: unknown): EngineRunRequest {
  const record = asRecord(input, 'request');
  const connectors: Record<string, unknown> = {};
  for (const entry of array(record['connectors'], 'connectors')) {
    const connector = asRecord(entry, 'connector');
    const name = asString(connector['name'], 'name');
    connectors[name] = bool(connector['remote'], 'remote')
      ? {
          type: 'http',
          url: `https://mcp.example/${name}`,
          ...(bool(connector['asksApproval'], 'asksApproval')
            ? { tools: [{ name: 'danger', permission_policy: 'always_ask' }] }
            : {}),
        }
      : { command: 'node', args: ['server.mjs'] };
  }
  const session = asString(record['session'], 'session');
  const gateway = record['gateway'] === null ? null : asRecord(record['gateway'], 'gateway');
  const skills = array(record['skills'], 'skills').map((name) => asString(name, 'skill'));
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    projectKey: 'tenant-a',
    cwd: '/workspace',
    prompt: 'go',
    engine: 'openai-agents',
    portable: {
      name: 'Agent',
      instructions: '',
      model: optString(record['model'], 'model'),
      permissions: permissions(record['permissions']),
      skills: { mode: 'allowlist', names: [] },
      mcpServers: connectors,
      limits: {
        maxTurns: optNumber(record['maxTurns'], 'maxTurns'),
        maxBudgetUsd: bool(record['budgetCap'], 'budgetCap') ? 5 : null,
      },
    },
    policy: bool(record['policyReadable'], 'policyReadable') ? {} : { tools: null },
    session:
      session === 'fresh'
        ? { mode: 'fresh' }
        : session === 'resume'
          ? { mode: 'resume', engineSessionId: 'session-1' }
          : { mode: 'fork', engineSessionId: 'session-1' },
    gateway:
      gateway === null
        ? null
        : {
            baseUrl: asString(gateway['baseUrl'], 'baseUrl'),
            token: asString(gateway['token'], 'token'),
            protocol: asString(gateway['protocol'], 'protocol'),
          },
    resources: {
      files: fileGrants(grants(record['grants'])),
      skills: skills.map((name) => ({
        name,
        files: [{ path: 'SKILL.md', contentBase64: 'YQ==' }],
      })),
    },
    env: bool(record['environmentClean'], 'environmentClean')
      ? { PATH: '/usr/bin' }
      : { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-a-real-provider-key' },
  };
}

/** A sentence each named refusal's reason carries, so the capability is checked, not only the code. */
const REFUSAL_MARKERS: Readonly<Record<string, string>> = {
  policy: 'policy arm',
  skills: 'skills: false',
  fork: 'fork: false',
  maxBudget: 'maxBudget from a provisional price table',
  gateway: 'gateway connection',
  wireProtocols: 'speaks',
  model: 'no default model',
  approvals: 'approval',
};

describe('engine-openai-agents: compile', () => {
  it.each(loadVectors(FAMILY, 'compile.json'))('$id', (vector) => {
    const result = compileOpenAiAgentsRun(requestFrom(vector.input));
    const expected = asRecord(vector.expected, vector.id);
    if (expected['ok'] === true) {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const compiled = result.compiled;
      expect({
        tools: compiled.agent.tools,
        networkEgress: compiled.networkEgress,
        connection: compiled.connection,
        connectors: compiled.mcpServers.map((server) => server.name),
        maxTurns: compiled.limits.maxTurns,
        budgetCap: compiled.limits.budget !== null,
        grants: compiled.workspace.grants.map((grant) => ({
          directory: grant.kind === 'directory',
          path: grant.path,
          readOnly: grant.access === 'read',
        })),
        tracingDisabled: compiled.tracingDisabled,
      }).toEqual({
        tools: expected['tools'],
        networkEgress: expected['networkEgress'],
        connection: expected['connection'],
        connectors: expected['connectors'],
        maxTurns: expected['maxTurns'],
        budgetCap: expected['budgetCap'],
        grants: expected['grants'],
        tracingDisabled: expected['tracingDisabled'],
      });
      return;
    }
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(expected['code']);
    const marker = REFUSAL_MARKERS[asString(expected['names'], 'names')];
    if (marker !== undefined) expect(result.reason).toContain(marker);
  });
});

describe('engine-openai-agents: the tool plan', () => {
  it.each(loadVectors(FAMILY, 'tool-plan.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const plan = openAiAgentsToolPlan(
      permissions(input['permissions']),
      bool(input['hasReadOnlyGrant'], 'hasReadOnlyGrant'),
    );
    expect(plan).toEqual(vector.expected);
  });
});

describe('engine-openai-agents: the model connection', () => {
  it.each(loadVectors(FAMILY, 'connection.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const connection = openAiAgentsModelConnection(
      asString(input['protocol'], 'protocol') as OpenAiAgentsWireProtocol,
      { baseUrl: asString(input['baseUrl'], 'baseUrl'), token: asString(input['token'], 'token') },
    );
    const paths: Record<OpenAiAgentsWireProtocol, string> = {
      'openai-responses': '/responses',
      'openai-chat-completions': '/chat/completions',
      'anthropic-messages': '/messages',
    };
    expect({
      connection,
      requests: [
        {
          url: `${connection.endpoint}${paths[connection.protocol]}`,
          authorization: connection.authorization,
        },
      ],
    }).toEqual(vector.expected);
  });
});

describe('engine-openai-agents: the Editor write rule', () => {
  it.each(loadVectors(FAMILY, 'write.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const normalised = normaliseGrants(
      fileGrants(grants(input['grants'])),
      OPENAI_AGENTS_PROTECTED_CONFIG_DIRECTORY,
    );
    expect(normalised.ok).toBe(true);
    if (!normalised.ok) return;
    const allowed = workspaceWriteAllowed(
      {
        cwd: '/workspace',
        grants: normalised.grants,
        protectedDirectory: OPENAI_AGENTS_PROTECTED_CONFIG_DIRECTORY,
      },
      asString(input['candidate'], 'candidate'),
    );
    expect({ allowed }).toEqual(vector.expected);
  });
});

/** The model's event as the plain event `./boundary.ts` hands the mapper. */
function eventFrom(value: unknown): OpenAiAgentsEvent {
  const record = asRecord(value, 'event');
  const id = (key: string) => optString(record[key], key);
  const maybe = (key: string, field: string) => {
    const found = id(field);
    return found === null ? {} : { [key]: found };
  };
  switch (asString(record['kind'], 'kind')) {
    case 'textDelta':
      return {
        kind: 'raw_model_stream_event',
        data: { type: 'output_text_delta', delta: record['delta'], ...maybe('itemId', 'itemId') },
      };
    case 'reasoningDelta':
      return {
        kind: 'raw_model_stream_event',
        data: {
          type: 'model',
          event: {
            type: 'response.reasoning_summary_text.delta',
            delta: record['delta'],
            ...maybe('item_id', 'itemId'),
          },
        },
      };
    case 'rawOther':
      return { kind: 'raw_model_stream_event', data: { type: record['type'] } };
    case 'rawUntyped':
      return { kind: 'raw_model_stream_event', data: {} };
    case 'messageCreated': {
      const texts = record['texts'];
      return {
        kind: 'run_item_stream_event',
        name: 'message_output_created',
        item: {
          type: 'message_output_item',
          rawItem: {
            type: 'message',
            role: 'assistant',
            ...maybe('id', 'id'),
            content:
              texts === null
                ? 'not a list of parts'
                : array(texts, 'texts').map((text) => ({ type: 'output_text', text })),
          },
        },
      };
    }
    case 'reasoningCreated':
      return {
        kind: 'run_item_stream_event',
        name: 'reasoning_item_created',
        item: {
          type: 'reasoning_item',
          rawItem: {
            type: 'reasoning',
            ...maybe('id', 'id'),
            content: [{ type: 'input_text', text: record['text'] === null ? 5 : record['text'] }],
          },
        },
      };
    case 'toolCalled':
      return {
        kind: 'run_item_stream_event',
        name: 'tool_called',
        item: {
          type: 'tool_call_item',
          rawItem: {
            type: bool(record['isFunction'], 'isFunction') ? 'function_call' : 'hosted_tool_call',
            ...maybe('callId', 'callId'),
            ...maybe('name', 'name'),
            arguments: '{}',
          },
        },
      };
    case 'toolOutput': {
      const output = asString(record['output'], 'output');
      return {
        kind: 'run_item_stream_event',
        name: 'tool_output',
        item: {
          type: 'tool_call_output_item',
          rawItem: {
            type: bool(record['isFunctionResult'], 'isFunctionResult')
              ? 'function_call_result'
              : 'hosted_tool_call_output',
            ...maybe('callId', 'callId'),
            status: bool(record['incomplete'], 'incomplete') ? 'incomplete' : 'completed',
            output: { type: 'text', text: output },
          },
          output,
        },
      };
    }
    case 'otherItem':
      return {
        kind: 'run_item_stream_event',
        name: asString(record['name'], 'name'),
        item: { type: 'other_item', rawItem: {} },
      };
    case 'agentUpdated':
      return { kind: 'agent_updated_stream_event', agentName: 'Agent' };
    case 'completed': {
      const usage = record['usage'] === null ? null : asRecord(record['usage'], 'usage');
      return {
        kind: 'run_completed',
        stopReason: asString(record['stopReason'], 'stopReason') as AgentStopReason,
        turns: optNumber(record['turns'], 'turns'),
        usage:
          usage === null
            ? null
            : {
                inputTokens: optNumber(usage['inputTokens'], 'inputTokens') ?? 0,
                outputTokens: optNumber(usage['outputTokens'], 'outputTokens') ?? 0,
                cachedInputTokens: optNumber(usage['cachedInputTokens'], 'cachedInputTokens'),
                reasoningTokens: optNumber(usage['reasoningTokens'], 'reasoningTokens'),
              },
      };
    }
    default:
      throw new Error(`unknown event kind in ${JSON.stringify(value)}`);
  }
}

/** The fields the model states: everything but `raw`, `payload`, the parsed `input` and a reason. */
function neutral(frame: unknown): Record<string, unknown> {
  const unmodelled = new Set(['raw', 'payload', 'input', 'reason']);
  return Object.fromEntries(
    Object.entries(asRecord(frame, 'frame')).filter(([key]) => !unmodelled.has(key)),
  );
}

describe('engine-openai-agents: the event mapping', () => {
  it.each(loadVectors(FAMILY, 'events.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const mapper = createOpenAiAgentsFrameMapper({
      localTools: array(input['localTools'], 'localTools').map((name) => asString(name, 'tool')),
      hasMcp: bool(input['hasMcp'], 'hasMcp'),
    });
    const frames = array(input['events'], 'events').flatMap((event) => [
      ...mapper.map(eventFrom(event)),
    ]);
    const expected = array(asRecord(vector.expected, vector.id)['frames'], 'frames');
    expect(frames.map(neutral)).toEqual(expected.map(neutral));
  });
});

/** A list store with every optional operation the session uses. */
function listStore(): EngineSessionStore {
  let entries: EngineTranscriptEntry[] = [];
  return {
    append: (_key: EngineSessionKey, batch) => {
      entries = [...entries, ...batch];
      return Promise.resolve();
    },
    load: () => Promise.resolve(entries.length === 0 ? null : [...entries]),
    deleteLast: () => {
      entries = entries.slice(0, -1);
      return Promise.resolve();
    },
    replaceAll: (_key, next) => {
      entries = [...next];
      return Promise.resolve();
    },
  };
}

describe('engine-openai-agents: the session over the store', () => {
  it.each(loadVectors(FAMILY, 'session.json'))('$id', async (vector) => {
    const session = new EngineStoreSession(listStore(), {
      projectKey: 'tenant-a',
      sessionId: 'session-1',
    });
    const results: unknown[] = [];
    for (const raw of array(asRecord(vector.input, vector.id)['ops'], 'ops')) {
      const op = asRecord(raw, 'op');
      switch (asString(op['op'], 'op')) {
        case 'add':
          await session.addItems(
            array(op['items'], 'items').map((item) => ({ value: asString(item, 'item') })),
          );
          results.push(null);
          break;
        case 'get': {
          const limit = optNumber(op['limit'], 'limit');
          const items = await session.getItems(limit ?? undefined);
          results.push(items.map((item) => item['value']));
          break;
        }
        case 'pop': {
          const last = await session.popItem();
          results.push(last === undefined ? null : last['value']);
          break;
        }
        case 'clear':
          await session.clearSession();
          results.push(null);
          break;
        default:
          throw new Error(`unknown op ${JSON.stringify(raw)}`);
      }
    }
    expect({ results }).toEqual(vector.expected);
  });
});

describe('engine-openai-agents: an engine switch carries the narrowing (ADR-0074 D12)', () => {
  const portable = {
    skills: { mode: 'allowlist', names: [] },
    limits: { maxTurns: null, maxBudgetUsd: null },
  } as const;

  function strings(value: unknown, what: string): string[] {
    return array(value, what).map((entry) => asString(entry, what));
  }

  it.each(loadVectors(FAMILY, 'engine-switch.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    if (input['kind'] === 'openai-to-claude') {
      const previous = AgentPolicySchema.parse({
        engine: 'openai-agents',
        withheldPermissions: strings(input['withheld'], 'withheld'),
        ...portable,
      });
      const next = AgentPolicySchema.parse({
        engine: 'claude-agent-sdk',
        tools: {
          base: 'claude_code_preset',
          autoApprove: [],
          deny: strings(input['deny'], 'deny'),
          permissionMode: 'default',
        },
        ...portable,
      });
      const translation = translatePolicyForEngineSwitch(previous, next);
      expect(translation.ok).toBe(true);
      if (!translation.ok || translation.policy.engine !== 'claude-agent-sdk') return;
      expect(translation.policy.tools.deny).toEqual(expected['deny']);
      return;
    }
    const claude = asRecord(input['claude'], 'claude');
    const previous = AgentPolicySchema.parse({
      engine: 'claude-agent-sdk',
      tools: { ...claude, allowDangerouslySkipPermissions: false },
      ...portable,
    });
    const existing = strings(input['existing'], 'existing');
    const next: AgentPolicy = AgentPolicySchema.parse({
      engine: 'openai-agents',
      ...(existing.length === 0 ? {} : { withheldPermissions: existing }),
      ...portable,
    });
    const translation = translatePolicyForEngineSwitch(previous, next);
    expect(translation.ok).toBe(expected['ok']);
    if (!translation.ok) {
      expect(translation.refused).toEqual(expected['refused']);
      return;
    }
    const policy = translation.policy;
    expect(policy.engine === 'openai-agents' && (policy.withheldPermissions ?? [])).toEqual(
      expected['withheld'],
    );
    // The carried arm is one the route stores: it parses against the published schema.
    expect(AgentPolicySchema.parse(policy)).toEqual(policy);
    for (const entry of array(expected['plans'], 'plans')) {
      const plan = asRecord(entry, 'plan');
      const narrowed = policyNarrowedPermissions(permissions(plan['permissions']), policy);
      expect(openAiAgentsToolPlan(narrowed, false).tools).toEqual(plan['tools']);
    }
  });
});
