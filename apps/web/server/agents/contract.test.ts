import { describe, expect, it } from 'vitest';

import { AgentPermissions as StoredAgentPermissions } from '@agent-workspace/core';

import {
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_MODEL_MAX_LENGTH,
  AGENT_MUTABLE_FIELDS,
  AGENT_NAME_MAX_LENGTH,
  AGENT_PERMISSION_KEYS,
  type AgentPermissions,
} from '../../contracts/agents';
import {
  isUuid,
  parseAgentInstructions,
  parseAgentModel,
  parseAgentName,
  parseAgentPermissions,
  parseCreateAgentInput,
  parseModelConnectionId,
  parseUpdateAgentPatch,
  toAgentResource,
  type AgentRecord,
} from './contract';

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

describe('parseAgentName', () => {
  it('trims, because the unique index and the §19.5 picker both key on the stored string', () => {
    const parsed = parseAgentName('  Support  ');
    expect(parsed).toEqual({ ok: true, value: 'Support' });
  });

  it('rejects a name that is blank once trimmed (agents_name_not_blank)', () => {
    for (const value of ['', '   ', '\t\n']) {
      const parsed = parseAgentName(value);
      expect(parsed.ok).toBe(false);
    }
  });

  it('rejects a non-string rather than coercing it', () => {
    for (const value of [null, undefined, 7, {}, ['a']]) {
      expect(parseAgentName(value).ok).toBe(false);
    }
  });

  it('applies the length bound to the trimmed value', () => {
    const atLimit = 'x'.repeat(AGENT_NAME_MAX_LENGTH);
    expect(parseAgentName(`  ${atLimit}  `)).toEqual({ ok: true, value: atLimit });
    expect(parseAgentName('x'.repeat(AGENT_NAME_MAX_LENGTH + 1)).ok).toBe(false);
  });
});

describe('parseAgentInstructions', () => {
  it('accepts the empty string — the built-in General agent depends on it', () => {
    expect(parseAgentInstructions('')).toEqual({ ok: true, value: '' });
  });

  it('does not trim, because leading whitespace in a prompt can be deliberate', () => {
    expect(parseAgentInstructions('  keep me  ')).toEqual({ ok: true, value: '  keep me  ' });
  });

  it('rejects a non-string and an over-long string', () => {
    expect(parseAgentInstructions(null).ok).toBe(false);
    expect(parseAgentInstructions('x'.repeat(AGENT_INSTRUCTIONS_MAX_LENGTH)).ok).toBe(true);
    expect(parseAgentInstructions('x'.repeat(AGENT_INSTRUCTIONS_MAX_LENGTH + 1)).ok).toBe(false);
  });
});

describe('parseModelConnectionId', () => {
  it('accepts null, meaning the workspace default model', () => {
    expect(parseModelConnectionId(null)).toEqual({ ok: true, value: null });
  });

  it('accepts a UUID and rejects anything else, undefined included', () => {
    expect(parseModelConnectionId('9f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f607').ok).toBe(true);
    expect(parseModelConnectionId(undefined).ok).toBe(false);
    expect(parseModelConnectionId('not-a-uuid').ok).toBe(false);
    expect(parseModelConnectionId(0).ok).toBe(false);
  });
});

describe('parseAgentModel', () => {
  it('accepts null and a trimmed non-blank string', () => {
    expect(parseAgentModel(null)).toEqual({ ok: true, value: null });
    expect(parseAgentModel('  claude-sonnet-4-5 ')).toEqual({
      ok: true,
      value: 'claude-sonnet-4-5',
    });
  });

  it('rejects a blank string, so "" cannot silently mean "default"', () => {
    expect(parseAgentModel('   ').ok).toBe(false);
  });

  it('rejects an over-long model id', () => {
    expect(parseAgentModel('m'.repeat(AGENT_MODEL_MAX_LENGTH + 1)).ok).toBe(false);
  });
});

describe('parseAgentPermissions', () => {
  it('accepts exactly the four booleans', () => {
    expect(parseAgentPermissions({ ...ALL_PERMISSIONS })).toEqual({
      ok: true,
      value: ALL_PERMISSIONS,
    });
  });

  it('rejects a missing key — the column has no default', () => {
    const missing = without({ ...ALL_PERMISSIONS }, 'runCommands');
    const parsed = parseAgentPermissions(missing);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.errors.join(' ')).toContain(
      'permissions.runCommands is required',
    );
  });

  it('rejects an unknown key rather than dropping it', () => {
    const parsed = parseAgentPermissions({ ...ALL_PERMISSIONS, becomeRoot: true });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.errors.join(' ')).toContain('permissions.becomeRoot');
  });

  it('rejects a truthy non-boolean rather than coercing it', () => {
    const parsed = parseAgentPermissions({ ...ALL_PERMISSIONS, runCommands: 'yes' });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a non-object, an array and null', () => {
    for (const value of [null, undefined, [], 'true', 1]) {
      expect(parseAgentPermissions(value).ok).toBe(false);
    }
  });

  it('copies rather than aliases, so a later mutation of the body cannot change the parsed value', () => {
    const body = { ...ALL_PERMISSIONS };
    const parsed = parseAgentPermissions(body);
    body.readFiles = false;
    expect(parsed.ok && parsed.value.readFiles).toBe(true);
  });
});

describe('parseCreateAgentInput', () => {
  it('accepts a complete body', () => {
    const parsed = parseCreateAgentInput(validCreateBody());
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: 'Customer Support Agent',
        instructions: 'You help employees answer questions...',
        modelConnectionId: null,
        model: null,
        runtimeProfileId: null,
        permissions: ALL_PERMISSIONS,
      },
    });
  });

  it('requires modelConnectionId and model as keys, not merely as values', () => {
    const parsed = parseCreateAgentInput(
      without(without(validCreateBody(), 'modelConnectionId'), 'model'),
    );
    expect(parsed.ok).toBe(false);
    const message = parsed.ok ? '' : parsed.errors.join(' ');
    expect(message).toContain('modelConnectionId');
    expect(message).toContain('model must be a string or null');
  });

  it('reports every bad field at once rather than one per round trip', () => {
    const parsed = parseCreateAgentInput({
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
    const parsed = parseCreateAgentInput(validCreateBody({ runtimeProfileId: 'x' }));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.errors.join(' ')).toContain('runtimeProfileId');
  });

  it('rejects a non-object body, an array included', () => {
    for (const value of [null, undefined, [], 'name=x', 5]) {
      expect(parseCreateAgentInput(value).ok).toBe(false);
    }
  });
});

describe('parseUpdateAgentPatch', () => {
  it('keeps only the keys the body carried', () => {
    expect(parseUpdateAgentPatch({ name: ' Renamed ' })).toEqual({
      ok: true,
      value: { name: 'Renamed' },
    });
  });

  it('lets a nullable field be set back to null', () => {
    expect(parseUpdateAgentPatch({ model: null, modelConnectionId: null })).toEqual({
      ok: true,
      value: { model: null, modelConnectionId: null },
    });
  });

  it('rejects a body with no recognised field, rather than answering 200 for a no-op', () => {
    const parsed = parseUpdateAgentPatch({});
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.errors.join(' ')).toContain('changed nothing');
  });

  it('rejects a present key whose value is undefined instead of treating it as absent', () => {
    const parsed = parseUpdateAgentPatch({ name: undefined });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.errors.join(' ')).toContain('omit the key');
  });

  it('rejects an unknown field', () => {
    expect(parseUpdateAgentPatch({ nmae: 'typo' }).ok).toBe(false);
  });

  it('validates each present field with the same rules as create', () => {
    expect(parseUpdateAgentPatch({ name: '   ' }).ok).toBe(false);
    expect(parseUpdateAgentPatch({ permissions: { readFiles: true } }).ok).toBe(false);
    expect(parseUpdateAgentPatch({ modelConnectionId: 'nope' }).ok).toBe(false);
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
      const parsed = parseUpdateAgentPatch({ [field]: bodies[field] });
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
});
