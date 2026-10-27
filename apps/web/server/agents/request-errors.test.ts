/**
 * Characterization of the `400 invalid_body` answers of `POST /api/agents` and
 * `PATCH /api/agents/:id`: status, code, message and every `details` line, in order.
 *
 * These are locked as they were answered when the hand-written parsers were replaced by the Zod
 * request schemas in `@indx-workspace/contracts/agents` (W2-7), so the move cannot change a byte a
 * client sees. A change here is a wire change and needs a CHANGELOG entry.
 */
import { describe, expect, it } from 'vitest';

import { createAgent, updateAgent } from './handlers';
import type { ApiResult } from '../http/result';
import { createInMemoryAgentStoreProvider } from './memory-store';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OWNER = {
  principalId: '66666666-6666-4666-8666-666666666666',
  userId: '88888888-8888-4888-8888-888888888888',
} as const;
const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};
const VALID = {
  name: 'Support',
  instructions: '',
  modelConnectionId: null,
  model: null,
  permissions: PERMISSIONS,
};

function store() {
  return createInMemoryAgentStoreProvider({ knownModelConnectionIds: new Set() }).forWorkspace(
    WORKSPACE,
  );
}

const CREATE_BODIES: readonly (readonly [string, unknown])[] = [
  ['null body', null],
  ['array body', []],
  ['string body', 'name=x'],
  ['number body', 5],
  ['empty object', {}],
  [
    'every field wrong',
    {
      name: '',
      instructions: 42,
      modelConnectionId: 'nope',
      model: '',
      runtimeProfileId: 7,
      permissions: {},
    },
  ],
  ['unknown keys first', { zeta: 1, ...VALID, alpha: 2 }],
  ['blank name, unknown key', { ...VALID, name: '   ', nmae: 'typo' }],
  ['name too long after trim', { ...VALID, name: `  ${'x'.repeat(201)}  ` }],
  ['name not a string', { ...VALID, name: ['a'] }],
  ['instructions too long', { ...VALID, instructions: 'x'.repeat(100_001) }],
  ['instructions null', { ...VALID, instructions: null }],
  ['model blank', { ...VALID, model: '  ' }],
  ['model too long', { ...VALID, model: 'm'.repeat(201) }],
  ['model a number', { ...VALID, model: 3 }],
  ['model and connection missing', { name: 'A', instructions: '', permissions: PERMISSIONS }],
  ['connection an object', { ...VALID, modelConnectionId: {} }],
  ['runtime profile not a uuid', { ...VALID, runtimeProfileId: 'x' }],
  ['permissions null', { ...VALID, permissions: null }],
  ['permissions array', { ...VALID, permissions: [] }],
  [
    'permissions unknown, missing and wrong',
    { ...VALID, permissions: { becomeRoot: true, readFiles: 'yes', runCommands: false, z: 1 } },
  ],
];

const PATCH_BODIES: readonly (readonly [string, unknown])[] = [
  ['null body', null],
  ['array body', []],
  ['empty object', {}],
  ['only unknown keys', { nmae: 'typo', other: 1 }],
  ['blank name', { name: '   ' }],
  ['unknown key and bad field', { model: '', zz: true }],
  ['partial permissions', { permissions: { readFiles: true } }],
  ['connection not a uuid', { modelConnectionId: 'nope' }],
  ['runtime profile a number', { runtimeProfileId: 1 }],
  ['instructions an object', { instructions: {} }],
];

/** The `details` lines of a refusal, after asserting the status, code and message around them. */
function detailsOf(result: ApiResult, message: string): unknown {
  expect(result.status).toBe(400);
  const { error } = result.body as { error: { code: string; message: string; details: unknown } };
  expect(error.code).toBe('invalid_body');
  expect(error.message).toBe(message);
  return error.details;
}

async function createDetails(body: unknown): Promise<unknown> {
  const result = await createAgent(store(), body, OWNER);
  return detailsOf(result, 'The agent could not be created from this body.');
}

async function patchDetails(body: unknown): Promise<unknown> {
  const s = store();
  const created = await s.create(VALID, OWNER);
  if (created.kind !== 'created') throw new Error('fixture agent was not created');
  const result = await updateAgent(s, created.agent.id, body);
  return detailsOf(result, 'The agent could not be updated from this body.');
}

describe('POST /api/agents refusals are unchanged', () => {
  it('answers every invalid body with the locked details', async () => {
    const answers: Record<string, unknown> = {};
    for (const [label, body] of CREATE_BODIES) answers[label] = await createDetails(body);
    expect(answers).toMatchInlineSnapshot(`
      {
        "array body": [
          "the request body must be a JSON object; received an array.",
        ],
        "blank name, unknown key": [
          "nmae is not a field of an agent; expected some of name, instructions, modelConnectionId, model, runtimeProfileId, permissions.",
          "name must not be blank.",
        ],
        "connection an object": [
          "modelConnectionId must be a UUID string or null; received an object.",
        ],
        "empty object": [
          "name must be a string; received a undefined.",
          "instructions must be a string; received a undefined.",
          "modelConnectionId must be a UUID string or null; received a undefined.",
          "model must be a string or null; received a undefined.",
          "permissions must be an object; received a undefined.",
        ],
        "every field wrong": [
          "name must not be blank.",
          "instructions must be a string; received a number.",
          "modelConnectionId must be a UUID string or null; received a string.",
          "model must not be blank; use null to mean "the workspace default model".",
          "runtimeProfileId must be a UUID string or null; received a number.",
          "permissions.readFiles is required; it has no default.",
          "permissions.writeFiles is required; it has no default.",
          "permissions.runCommands is required; it has no default.",
          "permissions.unrestrictedNetwork is required; it has no default.",
        ],
        "instructions null": [
          "instructions must be a string; received null.",
        ],
        "instructions too long": [
          "instructions must be at most 100000 characters; received 100001.",
        ],
        "model a number": [
          "model must be a string or null; received a number.",
        ],
        "model and connection missing": [
          "modelConnectionId must be a UUID string or null; received a undefined.",
          "model must be a string or null; received a undefined.",
        ],
        "model blank": [
          "model must not be blank; use null to mean "the workspace default model".",
        ],
        "model too long": [
          "model must be at most 200 characters; received 201.",
        ],
        "name not a string": [
          "name must be a string; received an array.",
        ],
        "name too long after trim": [
          "name must be at most 200 characters; received 201.",
        ],
        "null body": [
          "the request body must be a JSON object; received null.",
        ],
        "number body": [
          "the request body must be a JSON object; received a number.",
        ],
        "permissions array": [
          "permissions must be an object; received an array.",
        ],
        "permissions null": [
          "permissions must be an object; received null.",
        ],
        "permissions unknown, missing and wrong": [
          "permissions.becomeRoot is not a permission this platform knows; expected exactly readFiles, writeFiles, runCommands, unrestrictedNetwork.",
          "permissions.z is not a permission this platform knows; expected exactly readFiles, writeFiles, runCommands, unrestrictedNetwork.",
          "permissions.readFiles must be a boolean; received a string.",
          "permissions.writeFiles is required; it has no default.",
          "permissions.unrestrictedNetwork is required; it has no default.",
        ],
        "runtime profile not a uuid": [
          "runtimeProfileId must be a UUID string or null; received a string.",
        ],
        "string body": [
          "the request body must be a JSON object; received a string.",
        ],
        "unknown keys first": [
          "zeta is not a field of an agent; expected some of name, instructions, modelConnectionId, model, runtimeProfileId, permissions.",
          "alpha is not a field of an agent; expected some of name, instructions, modelConnectionId, model, runtimeProfileId, permissions.",
        ],
      }
    `);
  });
});

describe('PATCH /api/agents/:id refusals are unchanged', () => {
  it('answers every invalid body with the locked details', async () => {
    const answers: Record<string, unknown> = {};
    for (const [label, body] of PATCH_BODIES) answers[label] = await patchDetails(body);
    expect(answers).toMatchInlineSnapshot(`
      {
        "array body": [
          "the request body must be a JSON object; received an array.",
        ],
        "blank name": [
          "name must not be blank.",
        ],
        "connection not a uuid": [
          "modelConnectionId must be a UUID string or null; received a string.",
        ],
        "empty object": [
          "the request body changed nothing; supply at least one of name, instructions, modelConnectionId, model, runtimeProfileId, permissions.",
        ],
        "instructions an object": [
          "instructions must be a string; received an object.",
        ],
        "null body": [
          "the request body must be a JSON object; received null.",
        ],
        "only unknown keys": [
          "nmae is not a field of an agent; expected some of name, instructions, modelConnectionId, model, runtimeProfileId, permissions.",
          "other is not a field of an agent; expected some of name, instructions, modelConnectionId, model, runtimeProfileId, permissions.",
          "the request body changed nothing; supply at least one of name, instructions, modelConnectionId, model, runtimeProfileId, permissions.",
        ],
        "partial permissions": [
          "permissions.writeFiles is required; it has no default.",
          "permissions.runCommands is required; it has no default.",
          "permissions.unrestrictedNetwork is required; it has no default.",
        ],
        "runtime profile a number": [
          "runtimeProfileId must be a UUID string or null; received a number.",
        ],
        "unknown key and bad field": [
          "zz is not a field of an agent; expected some of name, instructions, modelConnectionId, model, runtimeProfileId, permissions.",
          "model must not be blank; use null to mean "the workspace default model".",
        ],
      }
    `);
  });
});
