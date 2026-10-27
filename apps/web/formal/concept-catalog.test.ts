/**
 * Differential conformance for the `concept-catalog` family, application half: the Lean model
 * (formal/AgentWorkspace/Concepts/{Connector,Agent,Grant}.lean) replayed against the REAL
 * application code:
 *
 *   - `Connector.admit` against `connectorKindOfBody` then `parseCreateConnectorBody`, the order
 *     `createConnector` applies them in, error messages and their order included
 *     (`connector-bodies.json`);
 *   - `Agent.parseName`, `parseInstructions` and `parseModel` against the `name`, `instructions`
 *     and `model` fields of `UpdateAgentPatchSchema`: trimming, the UTF-16 length bounds and the
 *     error messages (`agent-fields.json`);
 *   - `Grant.runOwnership` against `resolveAgentRunOwnership`, run through the real agents
 *     runtime registry with the in-memory agent store and a grant store answering `hasGrant` from
 *     the vector's grant rows (`run-ownership.json`).
 */
import { clearApplicationContext } from '../server/application-context';
import { installTestDomains } from '../server/application-context-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { agentRequestIssueMessages, UpdateAgentPatchSchema } from '../contracts/agents';
import { createInMemoryAgentStoreProvider } from '../server/agents/memory-store';
import { resolveAgentRunOwnership } from '../server/agents/run-ownership';
import {
  KIND_ERROR,
  connectorKindOfBody,
  parseCreateConnectorBody,
} from '../server/connectors/contract';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';

const FAMILY = 'concept-catalog';
const bodyVectors = loadVectors(FAMILY, 'connector-bodies.json');
const fieldVectors = loadVectors(FAMILY, 'agent-fields.json');
const ownershipVectors = loadVectors(FAMILY, 'run-ownership.json');

/** Expand the model's long-string encoding (`{ runs: [[text, count], …] }`); other values pass. */
function expand(value: unknown, what: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const runs = asRecord(value, what)['runs'];
  if (!Array.isArray(runs)) return value;
  return runs
    .map((run: unknown, index) => {
      if (!Array.isArray(run) || typeof run[1] !== 'number') {
        throw new Error(`${what}: malformed run ${String(index)}`);
      }
      return asString(run[0], `${what}.runs[${String(index)}]`).repeat(run[1]);
    })
    .join('');
}

/** The create admission as `createConnector` composes it, in the model's outcome shape. */
function admit(body: unknown): unknown {
  const kind = connectorKindOfBody(body);
  if (kind === null) return { ok: false, errors: [KIND_ERROR] };
  if (kind !== 'mcp') return { ok: true, kind };
  const parsed = parseCreateConnectorBody(body);
  return parsed.ok ? { ok: true, kind, value: parsed.value } : parsed;
}

describe('concept-catalog: the connector create admission', () => {
  it('replays both accepted and refused bodies', () => {
    const outcomes = bodyVectors.map((v) => asRecord(v.expected, v.id)['ok']);
    expect(outcomes).toContain(true);
    expect(outcomes).toContain(false);
  });

  it.each(bodyVectors.map((v) => [v.id, v] as const))('%s', (id, vector) => {
    const body = asRecord(vector.input, id)['body'];
    expect(admit(body)).toEqual(vector.expected);
  });
});

/** One field as the patch schema parses it, in the model's outcome shape. */
function parseField(field: 'name' | 'instructions' | 'model') {
  return (value: unknown): unknown => {
    const parsed = UpdateAgentPatchSchema.safeParse({ [field]: value });
    return parsed.success
      ? { ok: true, value: parsed.data[field] }
      : { ok: false, errors: agentRequestIssueMessages(parsed.error.issues) };
  };
}

const fieldParsers = {
  name: parseField('name'),
  instructions: parseField('instructions'),
  model: parseField('model'),
} as const;

function isParsedField(value: string): value is keyof typeof fieldParsers {
  return Object.prototype.hasOwnProperty.call(fieldParsers, value);
}

describe('concept-catalog: the agent field parsers', () => {
  it('replays every field, accepted and refused', () => {
    const seen = new Set(
      fieldVectors.map(
        (v) =>
          `${String(asRecord(v.input, v.id)['field'])}:${String(asRecord(v.expected, v.id)['ok'])}`,
      ),
    );
    for (const name of Object.keys(fieldParsers)) {
      expect(seen).toContain(`${name}:true`);
      expect(seen).toContain(`${name}:false`);
    }
  });

  it.each(fieldVectors.map((v) => [v.id, v] as const))('%s', (id, vector) => {
    const input = asRecord(vector.input, id);
    const name = asString(input['field'], `${id}.field`);
    if (!isParsedField(name)) throw new Error(`${id}: no parser for ${name}`);
    const expected = asRecord(vector.expected, id);
    const result = fieldParsers[name](expand(input['value'], `${id}.value`));
    if (expected['ok'] === true) {
      expect(result).toEqual({ ok: true, value: expand(expected['value'], `${id}.expected`) });
    } else {
      expect(result).toEqual({ ok: false, errors: expected['errors'] });
    }
  });
});

const WORKSPACE_ID = '00000000-0000-4000-8000-00000000aaaa';
const MISSING_AGENT_ID = '00000000-0000-4000-8000-00000000ffff';

function optionalString(value: unknown, what: string): string | null {
  return value === null ? null : asString(value, what);
}

function stringList(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value.map((item, index) => asString(item, `${what}[${String(index)}]`));
}

describe('concept-catalog: resolveAgentRunOwnership', () => {
  afterEach(() => {
    clearApplicationContext();
  });

  it('replays every ownership answer the resolver gives', () => {
    const answers = new Set(
      ownershipVectors.map((v) => asString(asRecord(v.expected, v.id)['ownership'], v.id)),
    );
    expect([...answers].sort()).toEqual(['other', 'own', 'permitted', 'unknown']);
  });

  it.each(ownershipVectors.map((v) => [v.id, v] as const))('%s', async (id, vector) => {
    const input = asRecord(vector.input, id);
    const owner = optionalString(input['agentOwnerPrincipalId'], `${id}.agentOwnerPrincipalId`);
    const callerPrincipalId = asString(input['callerPrincipalId'], `${id}.callerPrincipalId`);
    const callerUserId = optionalString(input['callerUserId'], `${id}.callerUserId`);
    const grantUserIds = stringList(input['grantUserIds'], `${id}.grantUserIds`);

    const agents = createInMemoryAgentStoreProvider();
    let agentId = MISSING_AGENT_ID;
    if (owner !== null) {
      const created = await agents.forWorkspace(WORKSPACE_ID).create(
        {
          name: 'Formal',
          instructions: '',
          modelConnectionId: null,
          model: null,
          permissions: {
            readFiles: true,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
        },
        { principalId: owner, userId: null },
      );
      if (created.kind !== 'created') throw new Error(`${id}: fixture failed: ${created.kind}`);
      agentId = created.agent.id;
    }
    const grantedAgentId = agentId;
    if (input['configured'] === true) {
      installTestDomains({
        agents: {
          agents,
          resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_ID }),
          ...(input['grantsWired'] === true
            ? {
                agentGrants: {
                  forWorkspace: () => ({
                    hasGrant: (candidateAgentId: string, userId: string) =>
                      Promise.resolve(
                        candidateAgentId === grantedAgentId && grantUserIds.includes(userId),
                      ),
                    listPrincipalIds: () => Promise.resolve([]),
                    replacePrincipalIds: () =>
                      Promise.resolve({ kind: 'agent-not-found' as const }),
                  }),
                },
              }
            : {}),
        },
      });
    }

    const ownership = await resolveAgentRunOwnership(
      {
        workspaceId: WORKSPACE_ID,
        principalId: callerPrincipalId,
        ownerPrincipalId: callerPrincipalId,
        userId: callerUserId,
      },
      agentId,
    );
    expect(ownership).toBe(asRecord(vector.expected, id)['ownership']);
  });
});
