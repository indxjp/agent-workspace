/**
 * `engine-pi`: the pi coding agent adapter (ENG-08, #307), replayed against the real TypeScript in
 * `@agent-workspace/engine-pi`.
 *
 * Six files, one per decision the Lean model makes: `compile.json` (`compilePiRun`),
 * `tool-plan.json` (`piToolPlan`), `connection.json` (`piModelConnection`), `guard.json`
 * (`piToolCallVerdict`, the `beforeToolCall` guard), `events.json` (`createPiFrameMapper`) and
 * `session.json` (`PiSessionMirror` and `readPiStream` over a list store).
 *
 * The model is SDK-free, like the code it mirrors, so nothing here reaches pi. What happens inside
 * pi — model requests only to the model's base URL, resources only through the pinned loader,
 * `beforeToolCall` before every tool, `terminate` honoured — is the family's declared hypothesis,
 * enforced by the package's own boundary suite (docs/formal/units/engine-pi.md, "Declared gaps").
 *
 * Under D-012 this file is in `tests/formal/`: every subject is a package export.
 */
import {
  normaliseGrants,
  type EngineRunRequest,
  type EngineSessionStore,
  type EngineTranscriptEntry,
} from '@agent-workspace/engine';
import {
  compilePiRun,
  createPiFrameMapper,
  PI_PROTECTED_CONFIG_DIRECTORY,
  piModelConnection,
  piToolCallVerdict,
  piToolPlan,
  PiSessionMirror,
  readPiStream,
  type PiEvent,
  type PiFileEntry,
} from '@agent-workspace/engine-pi/testing';
import type { AgentPermissions, PiToolName } from '@indx-workspace/contracts/agents';
import type { AgentStopReason } from '@indx-workspace/contracts/run-events';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const FAMILY = 'engine-pi';
const SESSION_ID = 'session-1';

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

/** The model's `Request` as the port's `EngineRunRequest`. */
function requestFrom(input: unknown): EngineRunRequest {
  const record = asRecord(input, 'request');
  const connectors: Record<string, unknown> = {};
  for (const name of strings(record['connectors'], 'connectors')) {
    connectors[name] = { type: 'http', url: `https://mcp.example/${name}` };
  }
  const session = asString(record['session'], 'session');
  const gateway = record['gateway'] === null ? null : asRecord(record['gateway'], 'gateway');
  const skills = strings(record['skills'], 'skills');
  const forkParent = bool(record['forksIntoItself'], 'forksIntoItself') ? SESSION_ID : 'parent-1';
  return {
    runId: 'run-1',
    sessionId: SESSION_ID,
    projectKey: 'tenant-a',
    cwd: asString(record['cwd'], 'cwd'),
    prompt: 'go',
    engine: 'pi',
    portable: {
      name: 'Agent',
      instructions: '',
      model: optString(record['model'], 'model'),
      permissions: permissions(record['permissions']),
      skills: { mode: 'allowlist', names: skills },
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
          ? { mode: 'resume', engineSessionId: SESSION_ID }
          : { mode: 'fork', engineSessionId: forkParent },
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
    env: bool(record['environmentClean'], 'environmentClean')
      ? { PATH: '/usr/bin' }
      : { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-a-real-provider-key' },
  };
}

/** A phrase each named refusal's reason carries, so the capability is checked, not only the code. */
const REFUSAL_MARKERS: Readonly<Record<string, string>> = {
  policy: 'policy arm',
  mcp: 'mcp: false',
  maxBudget: 'provisional price table',
  gateway: 'gateway connection',
  wireProtocols: 'speaks',
  fork: 'fork',
};

describe('engine-pi: compile', () => {
  it.each(loadVectors(FAMILY, 'compile.json'))('$id', (vector) => {
    const result = compilePiRun(requestFrom(vector.input));
    const expected = asRecord(vector.expected, vector.id);
    if (expected['ok'] === true) {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const compiled = result.compiled;
      expect({
        cwd: compiled.workspace.cwd,
        tools: compiled.agent.tools,
        networkEgress: compiled.networkEgress,
        connection: compiled.connection,
        model: compiled.agent.model,
        maxTurns: compiled.limits.maxTurns,
        budgetCap: compiled.limits.budget !== null,
        grants: compiled.workspace.grants.map((grant) => ({
          directory: grant.kind === 'directory',
          path: grant.path,
          readOnly: grant.access === 'read',
        })),
        skills: compiled.resources.skills,
      }).toEqual({
        cwd: expected['cwd'],
        tools: expected['tools'],
        networkEgress: expected['networkEgress'],
        connection: expected['connection'],
        model: expected['model'],
        maxTurns: expected['maxTurns'],
        budgetCap: expected['budgetCap'],
        grants: expected['grants'],
        skills: expected['skills'],
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

describe('engine-pi: the tool plan', () => {
  it.each(loadVectors(FAMILY, 'tool-plan.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    expect(
      piToolPlan(permissions(input['permissions']), bool(input['hasReadOnlyGrant'], 'ro')),
    ).toEqual(vector.expected);
  });
});

describe('engine-pi: the model connection', () => {
  it.each(loadVectors(FAMILY, 'connection.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const connection = piModelConnection({
      baseUrl: asString(input['baseUrl'], 'baseUrl'),
      token: asString(input['token'], 'token'),
    });
    expect({
      connection,
      requests: [
        {
          url: `${connection.baseUrl}/v1/messages`,
          authorization: connection.headers.authorization,
        },
      ],
    }).toEqual(vector.expected);
  });
});

describe('engine-pi: the beforeToolCall guard', () => {
  it.each(loadVectors(FAMILY, 'guard.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const normalised = normaliseGrants(fileGrants(input['grants']), PI_PROTECTED_CONFIG_DIRECTORY);
    expect(normalised.ok).toBe(true);
    if (!normalised.ok) return;
    const path = optString(input['path'], 'path');
    const verdict = piToolCallVerdict(
      {
        cwd: asString(input['cwd'], 'cwd'),
        grants: normalised.grants,
        protectedDirectory: PI_PROTECTED_CONFIG_DIRECTORY,
      },
      strings(input['tools'], 'tools') as PiToolName[],
      asString(input['toolName'], 'toolName'),
      path === null ? {} : { path },
    );
    expect({ allow: verdict.allow }).toEqual(vector.expected);
  });
});

/** The model's event as the plain event `./boundary.ts` hands the mapper. */
function eventFrom(value: unknown): PiEvent {
  const record = asRecord(value, 'event');
  const optional = (key: string, field: string) => {
    const found = optString(record[field], field);
    return found === null ? {} : { [key]: found };
  };
  switch (asString(record['kind'], 'kind')) {
    case 'textDelta':
      return {
        kind: 'pi',
        event: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: record['delta'] },
        },
      };
    case 'thinkingDelta':
      return {
        kind: 'pi',
        event: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: record['delta'] },
        },
      };
    case 'updateOther':
      return {
        kind: 'pi',
        event: { type: 'message_update', assistantMessageEvent: { type: record['type'] } },
      };
    case 'updateUnreadable':
      return { kind: 'pi', event: { type: 'message_update' } };
    case 'assistantEnd':
      return {
        kind: 'pi',
        event: {
          type: 'message_end',
          message: {
            role: 'assistant',
            ...optional('responseId', 'responseId'),
            content: record['blocks'] === null ? 'not a list of parts' : record['blocks'],
          },
        },
      };
    case 'messageEndOther':
      return {
        kind: 'pi',
        event: { type: 'message_end', message: { role: record['role'], content: [] } },
      };
    case 'messageEndUnreadable':
      return { kind: 'pi', event: { type: 'message_end' } };
    case 'toolStart':
      return {
        kind: 'pi',
        event: {
          type: 'tool_execution_start',
          ...optional('toolCallId', 'callId'),
          ...optional('toolName', 'name'),
          args: {},
        },
      };
    case 'toolEnd': {
      const output = optString(record['output'], 'output');
      return {
        kind: 'pi',
        event: {
          type: 'tool_execution_end',
          ...optional('toolCallId', 'callId'),
          result: { content: output === null ? 7 : [{ type: 'text', text: output }] },
          isError: bool(record['isError'], 'isError'),
        },
      };
    }
    case 'lifecycle':
      return { kind: 'pi', event: { type: record['type'] } };
    case 'untyped':
      return { kind: 'pi', event: {} };
    case 'completed': {
      const usage = record['usage'] === null ? null : asRecord(record['usage'], 'usage');
      return {
        kind: 'run_completed',
        stopReason: asString(record['stopReason'], 'stopReason') as AgentStopReason,
        turns: optNumber(record['turns'], 'turns') ?? 0,
        usage:
          usage === null
            ? null
            : {
                inputTokens: optNumber(usage['inputTokens'], 'inputTokens') ?? 0,
                outputTokens: optNumber(usage['outputTokens'], 'outputTokens') ?? 0,
                cacheReadInputTokens: optNumber(usage['cacheReadInputTokens'], 'cacheRead') ?? 0,
                cacheWriteInputTokens:
                  optNumber(usage['cacheCreationInputTokens'], 'cacheCreation') ?? 0,
                costUsd: 0,
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

describe('engine-pi: the event mapping', () => {
  it.each(loadVectors(FAMILY, 'events.json'))('$id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const mapper = createPiFrameMapper();
    const frames = array(input['events'], 'events').flatMap((event) => [
      ...mapper.map(eventFrom(event)),
    ]);
    const expected = array(asRecord(vector.expected, vector.id)['frames'], 'frames');
    expect(frames.map(neutral)).toEqual(expected.map(neutral));
  });
});

/** A list store: every append is kept, whatever the key. */
function listStore(): EngineSessionStore {
  let entries: EngineTranscriptEntry[] = [];
  return {
    append: (_key, batch) => {
      entries = [...entries, ...batch];
      return Promise.resolve();
    },
    load: () => Promise.resolve(entries.length === 0 ? null : [...entries]),
  };
}

function linesFrom(value: unknown): PiFileEntry[] {
  return array(value, 'lines').map((entry) => {
    const record = asRecord(entry, 'line');
    return {
      type: asString(record['type'], 'type'),
      id: asString(record['id'], 'id'),
      parentId: optString(record['parentId'], 'parentId'),
    };
  });
}

describe('engine-pi: the session over the store', () => {
  it.each(loadVectors(FAMILY, 'session.json'))('$id', async (vector) => {
    const input = asRecord(vector.input, vector.id);
    const sessionId = asString(input['sessionId'], 'sessionId');
    const store = listStore();
    const mirror = new PiSessionMirror(store, { projectKey: 'tenant-a', sessionId });
    await mirror.persist(linesFrom(input['first']));
    await mirror.persist(linesFrom(input['second']));
    const stream = (await store.load({ projectKey: 'tenant-a', sessionId })) ?? [];
    const read = readPiStream(stream, sessionId);
    expect({ stream, read: read.ok ? read.entries : null }).toEqual(vector.expected);
  });
});
