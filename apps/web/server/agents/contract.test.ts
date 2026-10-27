import { describe, expect, it } from 'vitest';

import { AgentPermissions as StoredAgentPermissions } from '@agent-workspace/run-protocol';

import {
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_MODEL_MAX_LENGTH,
  AGENT_MUTABLE_FIELDS,
  AGENT_NAME_MAX_LENGTH,
  AGENT_PERMISSION_KEYS,
  agentRequestIssueMessages,
  CreateAgentInputSchema,
  UpdateAgentPatchSchema,
  type AgentPermissions,
} from '../../contracts/agents';
import { isUuid, toAgentResource, type AgentRecord } from './contract';

type Parsed = { ok: true; value: unknown } | { ok: false; errors: readonly string[] };

function outcome(
  parsed: ReturnType<
    typeof CreateAgentInputSchema.safeParse | typeof UpdateAgentPatchSchema.safeParse
  >,
): Parsed {
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: agentRequestIssueMessages(parsed.error.issues) };
}

const parseCreate = (raw: unknown): Parsed => outcome(CreateAgentInputSchema.safeParse(raw));
const parsePatch = (raw: unknown): Parsed => outcome(UpdateAgentPatchSchema.safeParse(raw));

/** One field as the request schemas parse it: the patch with only that key present. */
function field(name: (typeof AGENT_MUTABLE_FIELDS)[number]) {
  return (raw: unknown): Parsed => {
    const parsed = parsePatch({ [name]: raw });
    return parsed.ok
      ? { ok: true, value: (parsed.value as Record<string, unknown>)[name] }
      : parsed;
  };
}
const parseName = field('name');
const parseInstructions = field('instructions');
const parseConnection = field('modelConnectionId');
const parseModel = field('model');
const parsePermissions = field('permissions');

const ALL_PERMISSIONS: AgentPermissions = {
  readFiles: true,
  writeFiles: true,
  runCommands: false,
  unrestrictedNetwork: false,
};

/**
 * A copy of `body` with `key` genuinely absent — not present with an `undefined` value.
 *
 * The parsers treat those two as different cases on purpose, so a test for the "absent" case has
 * to produce a real absence. `delete` on a fresh copy is the only way to get one.
 */
function without(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...body };
  delete copy[key];
  return copy;
}

function validCreateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Customer Support Agent',
    instructions: 'You help employees answer questions...',
    modelConnectionId: null,
    model: null,
    permissions: { ...ALL_PERMISSIONS },
    ...overrides,
  };
}

/**
 * `packages/core`'s `AgentPermissions` is the contracts schema itself, so the stored column and the
 * wire contract cannot disagree. This pins that behaviourally: the stored schema accepts exactly
 * the contracts' keys and refuses any other.
 */
describe('the permission list tracks packages/core/src/db/schema/agents.ts', () => {
  it('names exactly the keys the AgentPermissions schema declares', () => {
    const allTrue = Object.fromEntries(AGENT_PERMISSION_KEYS.map((key) => [key, true]));
    expect(StoredAgentPermissions.safeParse(allTrue).success).toBe(true);
    expect(StoredAgentPermissions.safeParse({ ...allTrue, fifthPermission: true }).success).toBe(
      false,
    );
    for (const key of AGENT_PERMISSION_KEYS) {
      const withoutKey = Object.fromEntries(
        Object.entries(allTrue).filter(([name]) => name !== key),
      );
      expect(StoredAgentPermissions.safeParse(withoutKey).success, key).toBe(false);
    }
  });

  it('is spec §17 Step 4, in the specification’s order', () => {
    expect([...AGENT_PERMISSION_KEYS]).toEqual([
      'readFiles',
      'writeFiles',
      'runCommands',
      'unrestrictedNetwork',
    ]);
  });
});

describe('isUuid', () => {
  it('accepts a canonical UUID in either case', () => {
    expect(isUuid('9f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f607')).toBe(true);
    expect(isUuid('9F1C2B3A-4D5E-4F60-8A71-B2C3D4E5F607')).toBe(true);
  });

  it('rejects everything that is not one, including non-strings', () => {
    for (const value of [
      '',
      'banana',
      '9f1c2b3a4d5e4f608a71b2c3d4e5f607',
      '9f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f60',
      ' 9f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f607',
      null,
      undefined,
      42,
      {},
      ['9f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f607'],
    ]) {
      expect(isUuid(value), `${JSON.stringify(value)} must not be a UUID`).toBe(false);
    }
  });
});

describe('name', () => {
  it('trims, because the unique index and the §19.5 picker both key on the stored string', () => {
    const parsed = parseName('  Support  ');
    expect(parsed).toEqual({ ok: true, value: 'Support' });
  });

  it('rejects a name that is blank once trimmed (agents_name_not_blank)', () => {
    for (const value of ['', '   ', '\t\n']) {
      const parsed = parseName(value);
      expect(parsed.ok).toBe(false);
    }
  });

  it('rejects a non-string rather than coercing it', () => {
    for (const value of [null, undefined, 7, {}, ['a']]) {
      expect(parseName(value).ok).toBe(false);
    }
  });

  it('applies the length bound to the trimmed value', () => {
    const atLimit = 'x'.repeat(AGENT_NAME_MAX_LENGTH);
    expect(parseName(`  ${atLimit}  `)).toEqual({ ok: true, value: atLimit });
    expect(parseName('x'.repeat(AGENT_NAME_MAX_LENGTH + 1)).ok).toBe(false);
  });
});

describe('instructions', () => {
  it('accepts the empty string — the built-in General agent depends on it', () => {
    expect(parseInstructions('')).toEqual({ ok: true, value: '' });
  });

  it('does not trim, because leading whitespace in a prompt can be deliberate', () => {
    expect(parseInstructions('  keep me  ')).toEqual({ ok: true, value: '  keep me  ' });
  });

  it('rejects a non-string and an over-long string', () => {
    expect(parseInstructions(null).ok).toBe(false);
    expect(parseInstructions('x'.repeat(AGENT_INSTRUCTIONS_MAX_LENGTH)).ok).toBe(true);
    expect(parseInstructions('x'.repeat(AGENT_INSTRUCTIONS_MAX_LENGTH + 1)).ok).toBe(false);
  });
});

describe('modelConnectionId', () => {
  it('accepts null, meaning the workspace default model', () => {
    expect(parseConnection(null)).toEqual({ ok: true, value: null });
  });

  it('accepts a UUID and rejects anything else, undefined included', () => {
    expect(parseConnection('9f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f607').ok).toBe(true);
    expect(parseConnection(undefined).ok).toBe(false);
    expect(parseConnection('not-a-uuid').ok).toBe(false);
    expect(parseConnection(0).ok).toBe(false);
  });
});

describe('model', () => {
  it('accepts null and a trimmed non-blank string', () => {
    expect(parseModel(null)).toEqual({ ok: true, value: null });
    expect(parseModel('  claude-sonnet-4-5 ')).toEqual({
      ok: true,
      value: 'claude-sonnet-4-5',
    });
  });

  it('rejects a blank string, so "" cannot silently mean "default"', () => {
    expect(parseModel('   ').ok).toBe(false);
  });

  it('rejects an over-long model id', () => {
    expect(parseModel('m'.repeat(AGENT_MODEL_MAX_LENGTH + 1)).ok).toBe(false);
  });
});

describe('permissions', () => {
  it('accepts exactly the four booleans', () => {
    expect(parsePermissions({ ...ALL_PERMISSIONS })).toEqual({
      ok: true,
      value: ALL_PERMISSIONS,
    });
  });

  it('returns an object whose keys are AGENT_PERMISSION_KEYS', () => {
    const parsed = parsePermissions({ ...ALL_PERMISSIONS });
    expect(parsed.ok && Object.keys(parsed.value as AgentPermissions)).toEqual([
      ...AGENT_PERMISSION_KEYS,
    ]);
  });

  it('rejects a missing key — the column has no default', () => {
    const missing = without({ ...ALL_PERMISSIONS }, 'runCommands');
    const parsed = parsePermissions(missing);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.errors.join(' ')).toContain(
      'permissions.runCommands is required',
    );
  });

  it('rejects an unknown key rather than dropping it', () => {
    const parsed = parsePermissions({ ...ALL_PERMISSIONS, becomeRoot: true });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.errors.join(' ')).toContain('permissions.becomeRoot');
  });

  it('rejects a truthy non-boolean rather than coercing it', () => {
    const parsed = parsePermissions({ ...ALL_PERMISSIONS, runCommands: 'yes' });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a non-object, an array and null', () => {
    for (const value of [null, undefined, [], 'true', 1]) {
      expect(parsePermissions(value).ok).toBe(false);
    }
  });

  it('copies rather than aliases, so a later mutation of the body cannot change the parsed value', () => {
    const body = { ...ALL_PERMISSIONS };
    const parsed = parsePermissions(body);
    body.readFiles = false;
    expect(parsed.ok && (parsed.value as AgentPermissions).readFiles).toBe(true);
  });
});

describe('CreateAgentInputSchema', () => {
  it('accepts a complete body', () => {
    const parsed = parseCreate(validCreateBody());
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: 'Customer Support Agent',
        instructions: 'You help employees answer questions...',
        modelConnectionId: null,
        model: null,
        permissions: ALL_PERMISSIONS,
      },
    });
  });

  it('requires modelConnectionId and model as keys, not merely as values', () => {
    const parsed = parseCreate(without(without(validCreateBody(), 'modelConnectionId'), 'model'));
    expect(parsed.ok).toBe(false);
    const message = parsed.ok ? '' : parsed.errors.join(' ');
    expect(message).toContain('modelConnectionId');
    expect(message).toContain('model must be a string or null');
  });

  it('reports every bad field at once rather than one per round trip', () => {
    const parsed = parseCreate({
      name: '',
      instructions: 42,
      modelConnectionId: 'nope',
      model: '',
      permissions: {},
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? 0 : parsed.errors.length).toBeGreaterThanOrEqual(5);
  });

  it('rejects an unknown top-level field', () => {
    const parsed = parseCreate(validCreateBody({ runtimeProfileId: 'x' }));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.errors.join(' ')).toContain('runtimeProfileId');
  });

  it('rejects a non-object body, an array included', () => {
    for (const value of [null, undefined, [], 'name=x', 5]) {
      expect(parseCreate(value).ok).toBe(false);
    }
  });
});

describe('UpdateAgentPatchSchema', () => {
  it('keeps only the keys the body carried', () => {
    expect(parsePatch({ name: ' Renamed ' })).toEqual({
      ok: true,
      value: { name: 'Renamed' },
    });
  });

  it('lets a nullable field be set back to null', () => {
    expect(parsePatch({ model: null, modelConnectionId: null })).toEqual({
      ok: true,
      value: { model: null, modelConnectionId: null },
    });
  });

  it('rejects a body with no recognised field, rather than answering 200 for a no-op', () => {
    const parsed = parsePatch({});
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.errors.join(' ')).toContain('changed nothing');
  });

  it('rejects a present key whose value is undefined instead of treating it as absent', () => {
    const parsed = parsePatch({ name: undefined });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.errors.join(' ')).toContain('name must be a string');
  });

  it('rejects an unknown field', () => {
    expect(parsePatch({ nmae: 'typo' }).ok).toBe(false);
  });

  it('validates each present field with the same rules as create', () => {
    expect(parsePatch({ name: '   ' }).ok).toBe(false);
    expect(parsePatch({ permissions: { readFiles: true } }).ok).toBe(false);
    expect(parsePatch({ modelConnectionId: 'nope' }).ok).toBe(false);
  });

  it('covers every mutable field, so the list and the parser cannot drift', () => {
    const bodies: Record<(typeof AGENT_MUTABLE_FIELDS)[number], unknown> = {
      name: 'A',
      instructions: '',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: { ...ALL_PERMISSIONS },
    };
    for (const field of AGENT_MUTABLE_FIELDS) {
      const parsed = parsePatch({ [field]: bodies[field] });
      expect(parsed.ok, `${field} should be patchable`).toBe(true);
    }
  });
});

describe('toAgentResource', () => {
  it('renders timestamps as ISO-8601 and copies the permissions', () => {
    const record: AgentRecord = {
      id: '9f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f607',
      workspaceId: '0d0e0f10-1112-4131-9415-161718191a1b',
      name: 'General',
      instructions: '',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: ALL_PERMISSIONS,
      policy: null,
      ownerPrincipalId: '1b2c3d4e-5f60-4718-92a3-b4c5d6e7f809',
      createdBy: '2c3d4e5f-6071-4283-94a5-b6c7d8e9f0a1',
      createdAt: new Date('2026-01-02T03:04:05.006Z'),
      updatedAt: new Date('2026-01-02T03:04:05.007Z'),
    };
    const resource = toAgentResource(record);
    expect(resource.createdAt).toBe('2026-01-02T03:04:05.006Z');
    expect(resource.updatedAt).toBe('2026-01-02T03:04:05.007Z');
    expect(resource.permissions).not.toBe(record.permissions);
    expect(JSON.parse(JSON.stringify(resource))).toEqual(resource);
  });

  describe('lineage and archive (issue #1851)', () => {
    const base: AgentRecord = {
      id: '9f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f607',
      workspaceId: '0d0e0f10-1112-4131-9415-161718191a1b',
      name: 'General',
      instructions: '',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: ALL_PERMISSIONS,
      policy: null,
      ownerPrincipalId: '1b2c3d4e-5f60-4718-92a3-b4c5d6e7f809',
      createdBy: '2c3d4e5f-6071-4283-94a5-b6c7d8e9f0a1',
      createdAt: new Date('2026-01-02T03:04:05.006Z'),
      updatedAt: new Date('2026-01-02T03:04:05.007Z'),
    };

    it('shows no lineage and no archivedAt for a person-made agent', () => {
      const resource = toAgentResource(base);
      expect(resource).not.toHaveProperty('createdByAgent');
      expect(resource).not.toHaveProperty('archivedAt');
    });

    it('shows the creating agent, version and run, and the archive time as ISO-8601', () => {
      const resource = toAgentResource({
        ...base,
        createdByAgent: {
          agentId: '3d4e5f60-7182-4394-85b6-c7d8e9f0a1b2',
          version: 3,
          runId: 'run_abc',
        },
        archivedAt: new Date('2026-02-03T04:05:06.007Z'),
      });
      expect(resource.createdByAgent).toEqual({
        agentId: '3d4e5f60-7182-4394-85b6-c7d8e9f0a1b2',
        version: 3,
        runId: 'run_abc',
      });
      expect(resource.archivedAt).toBe('2026-02-03T04:05:06.007Z');
    });

    it('keeps the lineage version and run when the creating agent was deleted', () => {
      const resource = toAgentResource({
        ...base,
        createdByAgent: { agentId: null, version: 1, runId: 'run_abc' },
      });
      expect(resource.createdByAgent).toEqual({ agentId: null, version: 1, runId: 'run_abc' });
    });
  });
});
