/**
 * `engine-mastra`: the Mastra adapter (ENG-10, #309), replayed against the real TypeScript in
 * `@agent-workspace/engine-mastra`.
 *
 * Eight files, one per decision the Lean model makes: `compile.json` (`compileMastraRun`),
 * `tool-plan.json` (`mastraToolPlan`), `connection.json` (`mastraModelConnection` and
 * `mastraProviderSpec`, the provider `boundary.ts#modelFor` builds), `write.json`
 * (`mastraWriteAllowed` and `mastraRemoveAllowed`, the filesystem wrapper's rules), `events.json`
 * (`createMastraFrameMapper`), `memory.json` (`readMastraThread` over journalled entries),
 * `stop.json` (`mastraStopReason`) and `process-env.json` (`mastraInstalledEnvironment`).
 *
 * The model is SDK-free, like the code it mirrors, so nothing here reaches Mastra. What happens
 * inside Mastra — model requests only to the provider's base URL, no telemetry without a `Mastra`
 * instance, writes only through the handed filesystem, `maxSteps` honoured, memory only through
 * the handed storage domain — is the family's declared hypothesis, enforced by the package's own
 * boundary suite (docs/formal/units/engine-mastra.md, "Declared gaps").
 *
 * Under D-012 this file is in `tests/formal/`: every subject is a package export.
 */
import { normaliseGrants, type EngineRunRequest } from '@agent-workspace/engine';
import {
  compileMastraRun,
  createMastraFrameMapper,
  MASTRA_PROTECTED_CONFIG_DIRECTORY,
  mastraInstalledEnvironment,
  mastraModelConnection,
  mastraProviderSpec,
  mastraRemoveAllowed,
  mastraStopReason,
  mastraToolPlan,
  mastraWriteAllowed,
  messageEntry,
  readMastraThread,
  threadEntry,
  type MastraEvent,
  type MastraModelConnection,
  type MastraProviderSpec,
  type MastraWireProtocol,
} from '@agent-workspace/engine-mastra';
import type { AgentPermissions } from '@indx-workspace/contracts/agents';
import type { AgentStopReason } from '@indx-workspace/contracts/run-events';
import type { EngineTranscriptEntry } from '@agent-workspace/engine';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const FAMILY = 'engine-mastra';

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

function strings(value: unknown, what: string): string[] {
  return array(value, what).map((entry) => asString(entry, what));
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

function fileGrants(value: unknown) {
  return array(value, 'grants').map((entry) => {
    const record = asRecord(entry, 'grant');
    return {
      kind: bool(record['directory'], 'directory') ? ('directory' as const) : ('file' as const),
      path: asString(record['path'], 'path'),
      access: bool(record['readOnly'], 'readOnly') ? ('read' as const) : ('read-write' as const),
    };
  });
}

/** One model connector as the connector record `packages/core` stores. */
function connectorRecord(value: unknown): readonly [string, unknown] {
  const record = asRecord(value, 'connector');
  const name = asString(record['name'], 'name');
  if (!bool(record['readable'], 'readable')) return [name, { type: 'ws', url: 'x' }];
  return [
    name,
    {
      type: 'http',
      url: `https://mcp.example/${name}`,
      ...(bool(record['asksApproval'], 'asksApproval')
        ? { tools: [{ name: 'publish', permission_policy: 'always_ask' }] }
        : {}),
    },
  ];
}

function sessionFrom(value: unknown): EngineRunRequest['session'] {
  const record = asRecord(value, 'session');
  const mode = asString(record['mode'], 'mode');
  if (mode === 'fresh') return { mode: 'fresh' };
  const engineSessionId = asString(record['engineSessionId'], 'engineSessionId');
  return mode === 'resume'
    ? { mode: 'resume', engineSessionId }
    : { mode: 'fork', engineSessionId };
}

/** The model's `Request` as the port's `EngineRunRequest`. */
function requestFrom(input: unknown): EngineRunRequest {
  const record = asRecord(input, 'request');
  const gateway = record['gateway'] === null ? null : asRecord(record['gateway'], 'gateway');
  const skills = strings(record['skills'], 'skills');
  // A variable spelled like a credential passes spec A.11 only when it holds the run token, so
  // every named variable holds it: the database gate, not the credential gate, is what decides.
  const token = gateway === null ? 'no-gateway' : asString(gateway['token'], 'token');
  const env: Record<string, string> = { PATH: '/usr/bin' };
  for (const name of strings(record['envNames'], 'envNames')) env[name] = token;
  if (!bool(record['environmentClean'], 'environmentClean')) {
    env['ANTHROPIC_API_KEY'] = 'sk-ant-a-real-provider-key';
  }
  return {
    runId: 'run-1',
    sessionId: asString(record['sessionId'], 'sessionId'),
    projectKey: asString(record['projectKey'], 'projectKey'),
    cwd: asString(record['cwd'], 'cwd'),
    prompt: 'go',
    engine: 'mastra',
    portable: {
      name: 'Agent',
      instructions: '',
      model: optString(record['model'], 'model'),
      permissions: permissions(record['permissions']),
      skills: { mode: 'allowlist', names: skills },
      mcpServers: Object.fromEntries(
        array(record['connectors'], 'connectors').map(connectorRecord),
      ),
      limits: {
        maxTurns: optNumber(record['maxTurns'], 'maxTurns'),
        maxBudgetUsd: bool(record['budgetCap'], 'budgetCap') ? 5 : null,
      },
    },
    policy: bool(record['policyReadable'], 'policyReadable') ? {} : { toolCallConcurrency: 0 },
    session: sessionFrom(record['session']),
    gateway:
      gateway === null
        ? null
        : {
            baseUrl: asString(gateway['baseUrl'], 'baseUrl'),
            token: asString(gateway['token'], 'token'),
            protocol: asString(gateway['protocol'], 'protocol'),
          },
    resources: {
      files: fileGrants(record['grants']),
      skills: skills.map((name) => ({
        name,
        files: [{ path: 'SKILL.md', contentBase64: 'YQ==' }],
      })),
    },
    env,
  };
}

/** The connection as the model states it: the bearer is compared, the raw token is not repeated. */
function withoutToken(connection: MastraModelConnection) {
  return {
    protocol: connection.protocol,
    api: connection.api,
    baseUrl: connection.baseUrl,
    authorization: connection.authorization,
  };
}

/** A phrase each named refusal's reason carries, so the capability is checked, not only the code. */
const REFUSAL_MARKERS: Readonly<Record<string, string>> = {
  policy: 'policy arm',
  gateway: 'gateway connection',
  wireProtocols: 'speaks',
  database: 'holds no database credential',
  maxBudget: 'provisional price table',
  connector: 'connector record',
  approvals: 'human approval',
  fork: 'fork: false',
};

describe('engine-mastra: compile', () => {
  it.each(loadVectors(FAMILY, 'compile.json'))('$id', (vector) => {
    const result = compileMastraRun(requestFrom(vector.input));
    const expected = asRecord(vector.expected, vector.id);
    if (expected['ok'] === true) {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const compiled = result.compiled;
      const connection = withoutToken(compiled.connection);
      expect({
        cwd: compiled.workspace.cwd,
        tools: compiled.agent.tools,
        skillTools: compiled.agent.skillTools,
        networkEgress: compiled.networkEgress,
        connection,
        model: compiled.agent.model,
        maxSteps: compiled.limits.maxSteps,
        budgetCap: compiled.limits.budget !== null,
        grants: compiled.workspace.grants.map((grant) => ({
          directory: grant.kind === 'directory',
          path: grant.path,
          readOnly: grant.access === 'read',
        })),
        skills: compiled.skills.names,
        connectors: compiled.mcpServers.map((server) => server.name),
        memory: {
          threadId: compiled.memory.threadId,
          resourceId: compiled.memory.resourceId,
          lastMessages: compiled.memory.lastMessages,
          semanticRecall: compiled.memory.semanticRecall,
          workingMemory: compiled.memory.workingMemory,
          generateTitle: compiled.memory.generateTitle,
        },
        observability: compiled.observability,
      }).toEqual(Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'ok')));
      return;
    }
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(expected['code']);
    const marker = REFUSAL_MARKERS[asString(expected['names'], 'names')];
    if (marker !== undefined) expect(result.reason).toContain(marker);
  });
});

describe('engine-mastra: the tool plan', () => {
  it.each(loadVectors(FAMILY, 'tool-plan.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const plan = mastraToolPlan(
      permissions(input['permissions']),
      bool(input['hasReadOnlyGrant'], 'ro'),
      false,
    );
    expect(plan.tools).toEqual(vector.expected);
  });
});

/**
 * The path the AI SDK provider appends to its base URL for each method: the model's `methodPath`,
 * a declared hypothesis about the provider that `boundary.test.ts` enforces against real requests.
 */
const METHOD_PATH: Readonly<Record<MastraProviderSpec['method'], string>> = {
  messages: '/messages',
  responses: '/responses',
  chat: '/chat/completions',
};

describe('engine-mastra: the model connection and the provider built from it', () => {
  it.each(loadVectors(FAMILY, 'connection.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const protocol = asString(input['protocol'], 'protocol') as MastraWireProtocol;
    const compiled = mastraModelConnection(
      {
        baseUrl: asString(input['baseUrl'], 'baseUrl'),
        token: asString(input['token'], 'token'),
      },
      protocol,
    );
    // The decision `./boundary.ts#modelFor` switches on, not a shape built here.
    const spec = mastraProviderSpec(compiled);
    expect({
      connection: withoutToken(compiled),
      requests: [
        {
          url: `${spec.baseURL}${METHOD_PATH[spec.method]}`,
          authorization: compiled.authorization,
        },
      ],
      model: { kind: 'provider', ...spec },
    }).toEqual(vector.expected);
  });
});

describe('engine-mastra: the filesystem wrapper', () => {
  it.each(loadVectors(FAMILY, 'write.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const normalised = normaliseGrants(
      fileGrants(input['grants']),
      MASTRA_PROTECTED_CONFIG_DIRECTORY,
    );
    expect(normalised.ok).toBe(true);
    if (!normalised.ok) return;
    const workspace = {
      cwd: asString(input['cwd'], 'cwd'),
      grants: normalised.grants,
      protectedDirectory: MASTRA_PROTECTED_CONFIG_DIRECTORY,
    };
    const candidate = asString(input['path'], 'path');
    expect({
      allowed: mastraWriteAllowed(workspace, candidate),
      removeAllowed: mastraRemoveAllowed(workspace, candidate),
    }).toEqual(vector.expected);
  });
});

function chunk(type: string, payload: Record<string, unknown>): MastraEvent {
  return { kind: 'mastra', chunk: { type, from: 'AGENT', payload } };
}

/** The model's chunk as the plain event `./boundary.ts` hands the mapper. */
function eventFrom(value: unknown): MastraEvent {
  const record = asRecord(value, 'chunk');
  const optional = (key: string, field: string) => {
    const found = optString(record[field], field);
    return found === null ? {} : { [key]: found };
  };
  const kind = asString(record['kind'], 'kind');
  switch (kind) {
    case 'textDelta':
    case 'reasoningDelta':
      return chunk(kind === 'textDelta' ? 'text-delta' : 'reasoning-delta', {
        ...optional('id', 'id'),
        ...optional('text', 'text'),
      });
    case 'textEnd':
    case 'reasoningEnd':
      return chunk(kind === 'textEnd' ? 'text-end' : 'reasoning-end', optional('id', 'id'));
    case 'toolCall':
      return chunk('tool-call', {
        ...optional('toolCallId', 'callId'),
        ...optional('toolName', 'name'),
        args: {},
      });
    case 'toolResult':
      return chunk('tool-result', {
        ...optional('toolCallId', 'callId'),
        result: asString(record['output'], 'output'),
        isError: bool(record['isError'], 'isError'),
      });
    case 'toolError':
      return chunk('tool-error', {
        ...optional('toolCallId', 'callId'),
        error: { message: asString(record['message'], 'message') },
      });
    case 'error':
      return chunk('error', { error: 'upstream failure' });
    case 'stepFinish':
      return chunk('step-finish', { stepResult: { reason: 'tool-calls' } });
    case 'other':
      return chunk(asString(record['type'], 'type'), {});
    case 'notAnObject':
      return { kind: 'mastra', chunk: 7 };
    case 'untyped':
      return { kind: 'mastra', chunk: { payload: {} } };
    case 'completed': {
      const usage = record['usage'] === null ? null : asRecord(record['usage'], 'usage');
      return {
        kind: 'run_completed',
        stopReason: asString(record['stopReason'], 'stopReason') as AgentStopReason,
        steps: optNumber(record['steps'], 'steps') ?? 0,
        usage:
          usage === null
            ? null
            : {
                inputTokens: optNumber(usage['inputTokens'], 'inputTokens') ?? 0,
                outputTokens: optNumber(usage['outputTokens'], 'outputTokens') ?? 0,
                cacheReadInputTokens: optNumber(usage['cacheReadInputTokens'], 'cacheRead') ?? 0,
                cacheWriteInputTokens:
                  optNumber(usage['cacheCreationInputTokens'], 'cacheCreation') ?? 0,
                reasoningTokens: optNumber(usage['reasoningTokens'], 'reasoningTokens'),
                costUsd: 0,
              },
        finish: null,
      };
    }
    default:
      throw new Error(`unknown chunk kind in ${JSON.stringify(value)}`);
  }
}

/** The fields the model states: everything but `raw`, `payload`, the parsed `input` and a reason. */
function neutral(frame: unknown): Record<string, unknown> {
  const unmodelled = new Set(['raw', 'payload', 'input', 'reason']);
  return Object.fromEntries(
    Object.entries(asRecord(frame, 'frame')).filter(([key]) => !unmodelled.has(key)),
  );
}

describe('engine-mastra: the event mapping', () => {
  it.each(loadVectors(FAMILY, 'events.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const mapper = createMastraFrameMapper(strings(input['connectors'], 'connectors'));
    const frames = array(input['chunks'], 'chunks').flatMap((entry) => [
      ...mapper.map(eventFrom(entry)),
    ]);
    const expected = array(asRecord(vector.expected, vector.id)['frames'], 'frames');
    expect(frames.map(neutral)).toEqual(expected.map(neutral));
  });
});

const AT = new Date('2026-09-29T10:00:00.000Z');

function entryFrom(value: unknown): EngineTranscriptEntry {
  const record = asRecord(value, 'entry');
  switch (asString(record['kind'], 'kind')) {
    case 'thread':
      return threadEntry({
        id: asString(record['id'], 'id'),
        resourceId: 'tenant-a',
        createdAt: AT,
        updatedAt: AT,
      });
    case 'message': {
      const message = asRecord(record['message'], 'message');
      return messageEntry({
        id: asString(message['id'], 'id'),
        threadId: asString(message['threadId'], 'threadId'),
        body: asString(message['body'], 'body'),
      });
    }
    default:
      return { type: 'user', uuid: 'an-entry-this-adapter-does-not-write' };
  }
}

describe('engine-mastra: memory over the store', () => {
  it.each(loadVectors(FAMILY, 'memory.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const verdict = readMastraThread(
      array(input['entries'], 'entries').map(entryFrom),
      asString(input['threadId'], 'threadId'),
    );
    expect({
      messages: verdict.ok
        ? verdict.state.messages.map((message) => ({
            id: message['id'],
            threadId: message['threadId'],
            body: message['body'],
          }))
        : null,
    }).toEqual(vector.expected);
  });
});

describe('engine-mastra: the stop reason', () => {
  it.each(loadVectors(FAMILY, 'stop.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const stopReason = mastraStopReason({
      steps: optNumber(input['steps'], 'steps') ?? 0,
      lastStepReason: optString(input['lastStepReason'], 'lastStepReason'),
      maxSteps: optNumber(input['maxSteps'], 'maxSteps'),
      limit: bool(input['overBudget'], 'overBudget') ? 'max_budget' : null,
      interrupted: bool(input['interrupted'], 'interrupted'),
    });
    expect({ stopReason }).toEqual(vector.expected);
  });
});

describe('engine-mastra: the process environment Mastra loads under', () => {
  it.each(loadVectors(FAMILY, 'process-env.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const env = Object.fromEntries(
      Object.entries(asRecord(input['env'], 'env')).map(([name, value]) => [
        name,
        asString(value, name),
      ]),
    );
    expect({ installed: mastraInstalledEnvironment(env) }).toEqual(vector.expected);
  });
});
