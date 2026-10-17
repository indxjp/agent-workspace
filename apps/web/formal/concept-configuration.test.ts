/**
 * Differential conformance for the `concept-configuration` family, server side: the Lean model of
 * model connections, secrets and runtime connections (formal/AgentWorkspace/Concepts/) replayed
 * against the REAL request parsers and stores of `apps/web/server/{models,secrets,runtimes}`.
 *
 *   - the provider config rule and readiness: `parseCreateModelConnection`,
 *     `parseUpdateModelConnection` (with an egress stub that allows every URL, because the model does
 *     not model egress), `isModelConnectionConfigComplete` and `toModelConnectionResource`;
 *   - the model-connection credential name: `modelConnectionSecretName`;
 *   - the secret name shape and value bounds: `parseSecretName`, `parseSecretValue`;
 *   - the runtime-connection name encoding and decoding: the in-memory and the secrets-backed
 *     runtime-connection stores (the encoder and decoder are private to `connections.ts`, so they
 *     are driven through `create` and `list`), and the contract schema the listed resource must pass.
 *
 * Package-level replays (Drizzle tables, contract schemas, closed sets) live in
 * tests/formal/concept-configuration.test.ts.
 */
import { MODEL_PROVIDERS, type ModelProvider } from '@indx-workspace/contracts/runs';
import { RuntimeConnectionResourceSchema } from '@indx-workspace/contracts/runtimes';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';

import {
  isModelConnectionConfigComplete,
  parseCreateModelConnection,
  parseUpdateModelConnection,
  toModelConnectionResource,
  type CheckBaseUrlEgress,
} from '../server/models/contract';
import { modelConnectionSecretName } from '../server/models/store';
import {
  createInMemoryRuntimeConnectionStoreProvider,
  createSecretsRuntimeConnectionStoreProvider,
  parseCreateRuntimeConnectionInput,
  toRuntimeConnectionResource,
  type RuntimeConnectionSecretsPort,
} from '../server/runtimes/connections';
import {
  parseCreateRuntimeProfileInput,
  parseUpdateRuntimeProfilePatch,
} from '../server/runtimes/contract';
import {
  parseCreateSecretBody,
  parseReplaceSecretBody,
  parseSecretName,
  parseSecretValue,
  SECRET_NAME_PATTERN,
} from '../server/secrets/contract';
import { createInMemorySecretsStoreProvider } from '../server/secrets/memory-store';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';

const FAMILY = 'concept-configuration';
const WORKSPACE = 'workspace-a';
const SCOPES = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: WORKSPACE }]);
const allowEveryUrl: CheckBaseUrlEgress = () => Promise.resolve({ ok: true });

function field(value: unknown, key: string, what: string): unknown {
  return asRecord(value, what)[key];
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${what}: expected a boolean`);
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what}: expected a number`);
  return value;
}

function asNullableString(value: unknown, what: string): string | null {
  return value === null ? null : asString(value, what);
}

function asProvider(value: unknown, what: string): ModelProvider {
  const found = MODEL_PROVIDERS.find((p) => p === value);
  if (found === undefined) throw new Error(`${what}: not a provider`);
  return found;
}

function asConfig(value: unknown, what: string): Record<string, string> {
  const record = asRecord(value, what);
  return Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k, asString(v, `${what}.${k}`)]),
  );
}

/** A secrets port holding only names: what `createSecretsRuntimeConnectionStoreProvider` reads. */
function secretsPort(seed: readonly string[]): RuntimeConnectionSecretsPort {
  const rows = seed.map((name, i) => ({ id: String(i + 1), name, createdAt: new Date(0) }));
  return {
    list: () => Promise.resolve([...rows]),
    create: (_scope, input) => {
      if (rows.some((row) => row.name === input.name)) {
        return Promise.resolve({ kind: 'name-conflict', name: input.name });
      }
      const row = { id: String(rows.length + 1), name: input.name, createdAt: new Date(0) };
      rows.push(row);
      return Promise.resolve({ kind: 'created', secret: row });
    },
  };
}

/**
 * The readiness a resource shows: a connection without a credential is reported as such before its
 * config is looked at (the resource's `hasCredential`), otherwise `ready` decides.
 */
function readinessOf(resource: {
  readonly hasCredential: boolean;
  readonly ready: boolean;
}): string {
  if (!resource.hasCredential) return 'no-credential';
  return resource.ready ? 'ready' : 'incomplete-config';
}

// ---------------------------------------------------------------------------------------------

describe('provider config rules and readiness', () => {
  it.each(loadVectors(FAMILY, 'config-rules.json').map((v) => [v.id, v] as const))(
    '%s',
    async (_id, v) => {
      const provider = asProvider(field(v.input, 'provider', v.id), v.id);
      const config = asConfig(field(v.input, 'config', v.id), v.id);
      const expected = asRecord(v.expected, v.id);
      const accepted = asBoolean(expected['accepted'], 'accepted');

      const created = await parseCreateModelConnection(
        { name: 'Claude', provider, apiKey: 'sk-test', config },
        allowEveryUrl,
      );
      expect(created.ok).toBe(accepted);
      const updated = await parseUpdateModelConnection({ config }, provider, allowEveryUrl);
      expect(updated.ok).toBe(accepted);

      expect(isModelConnectionConfigComplete(provider, config)).toBe(
        asBoolean(expected['complete'], 'complete'),
      );
      const record = {
        id: 'c1',
        workspaceId: WORKSPACE,
        name: 'Claude',
        provider,
        config,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      const withCredential = toModelConnectionResource(record, true);
      const withoutCredential = toModelConnectionResource(record, false);
      expect(withCredential.ready).toBe(asBoolean(expected['readyWithCredential'], 'ready'));
      expect(withoutCredential.ready).toBe(asBoolean(expected['readyWithoutCredential'], 'ready'));
      expect(withCredential.hasCredential && !withoutCredential.hasCredential).toBe(true);
      expect(readinessOf(withCredential)).toBe(asString(expected['readiness'], 'readiness'));
      expect(readinessOf(withoutCredential)).toBe(
        asString(expected['readinessWithoutCredential'], 'readinessWithoutCredential'),
      );
    },
  );
});

describe('the model-connection credential name', () => {
  it.each(loadVectors(FAMILY, 'credential-names.json').map((v) => [v.id, v] as const))(
    '%s',
    (_id, v) => {
      const name = modelConnectionSecretName(asString(v.input, v.id));
      expect(name).toBe(asString(field(v.expected, 'name', v.id), v.id));
      expect(parseSecretName(name).ok).toBe(
        asBoolean(field(v.expected, 'validSecretName', v.id), v.id),
      );
    },
  );
});

describe('secret names and values', () => {
  const nameVectors = loadVectors(FAMILY, 'secret-names.json');

  it.each(nameVectors.map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const name = asString(v.input, v.id);
    const valid = asBoolean(field(v.expected, 'valid', v.id), v.id);
    expect(parseSecretName(name).ok).toBe(valid);
    expect(SECRET_NAME_PATTERN.test(name)).toBe(valid);
  });

  it('a stored name lists as a runtime connection exactly when the model gives it that purpose', async () => {
    const names = nameVectors.map((v) => asString(v.input, v.id));
    const store = createSecretsRuntimeConnectionStoreProvider({
      secrets: secretsPort(names),
      scopes: SCOPES,
    }).forWorkspace(WORKSPACE);
    const listed = new Set((await store.list()).map((c) => c.name));
    for (const v of nameVectors) {
      const purpose = asString(field(v.expected, 'purpose', v.id), v.id);
      expect(listed.has(asString(v.input, v.id))).toBe(purpose === 'runtime-connection');
    }
  });

  it.each(loadVectors(FAMILY, 'secret-values.json').map((v) => [v.id, v] as const))(
    '%s',
    (_id, v) => {
      const length = asNumber(field(v.input, 'length', v.id), v.id);
      expect(parseSecretValue('x'.repeat(length)).ok).toBe(
        asBoolean(field(v.expected, 'accepted', v.id), v.id),
      );
    },
  );
});

describe('runtime-connection names', () => {
  it.each(loadVectors(FAMILY, 'runtime-connection-encode.json').map((v) => [v.id, v] as const))(
    '%s',
    async (_id, v) => {
      const driver = asString(field(v.input, 'driver', v.id), v.id);
      const label = asString(field(v.input, 'label', v.id), v.id);
      const name = asNullableString(field(v.expected, 'name', v.id), v.id);
      const input = { name: label, driver, endpoint: 'https://cluster.example', credential: 'k' };

      const memory = await createInMemoryRuntimeConnectionStoreProvider()
        .forWorkspace(WORKSPACE)
        .create(input);
      const secretsStore = createSecretsRuntimeConnectionStoreProvider({
        secrets: secretsPort([]),
        scopes: SCOPES,
      }).forWorkspace(WORKSPACE);
      const sealed = await secretsStore.create(input);
      for (const outcome of [memory, sealed]) {
        if (name === null) expect(outcome.kind).toBe('name-conflict');
        else {
          expect(outcome.kind).toBe('created');
          if (outcome.kind === 'created') expect(outcome.connection.name).toBe(name);
        }
      }
      const listed = await secretsStore.list();
      expect(listed.map((c) => c.driver)).toEqual(
        name === null ? [] : [asString(field(v.expected, 'decodedDriver', v.id), v.id)],
      );
    },
  );

  it.each(loadVectors(FAMILY, 'runtime-connection-decode.json').map((v) => [v.id, v] as const))(
    '%s',
    async (_id, v) => {
      const name = asString(v.input, v.id);
      const driver = asNullableString(field(v.expected, 'driver', v.id), v.id);
      const listed = await createSecretsRuntimeConnectionStoreProvider({
        secrets: secretsPort([name]),
        scopes: SCOPES,
      })
        .forWorkspace(WORKSPACE)
        .list();
      expect(listed.map((c) => c.driver)).toEqual(driver === null ? [] : [driver]);
      for (const connection of listed) {
        expect(
          RuntimeConnectionResourceSchema.safeParse(toRuntimeConnectionResource(connection))
            .success,
        ).toBe(asBoolean(field(v.expected, 'known', v.id), v.id));
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Request field lists: the model's accepted, required and refused keys against the real parsers.

type BodyParser = (body: Record<string, unknown>) => Promise<boolean>;

const VALID_PROFILE: Record<string, unknown> = {
  name: 'default',
  driver: 'docker',
  runtimeConnectionId: 's1',
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  networkPolicy: 'none',
  allowedDomains: ['example.com'],
  filesystem: 'read-write',
  persistPaths: ['/work'],
  timeoutSeconds: 60,
  idleTimeoutSeconds: 30,
  driverConfig: {},
};

/** A valid body for each server-side request the model lists, and the parser that reads it. */
const REQUESTS: Readonly<
  Record<string, { readonly valid: Record<string, unknown>; readonly parse: BodyParser }>
> = {
  'model-connection-create': {
    valid: { name: 'Claude', provider: 'anthropic', apiKey: 'sk-test', config: {} },
    parse: async (body) => (await parseCreateModelConnection(body, allowEveryUrl)).ok,
  },
  'model-connection-update': {
    valid: { name: 'Claude', config: {}, apiKey: 'sk-ant-test' },
    parse: async (body) => (await parseUpdateModelConnection(body, 'anthropic', allowEveryUrl)).ok,
  },
  'secret-create': {
    valid: { name: 'GITHUB_TOKEN', value: 'ghp-test' },
    parse: (body) => Promise.resolve(parseCreateSecretBody(body).ok),
  },
  'secret-replace': {
    valid: { value: 'ghp-test' },
    parse: (body) => Promise.resolve(parseReplaceSecretBody(body).ok),
  },
  'runtime-profile-create': {
    valid: VALID_PROFILE,
    parse: (body) => Promise.resolve(parseCreateRuntimeProfileInput(body).ok),
  },
  'runtime-profile-update': {
    valid: VALID_PROFILE,
    parse: (body) => Promise.resolve(parseUpdateRuntimeProfilePatch(body).ok),
  },
  'runtime-connection-create': {
    valid: {
      name: 'primary',
      driver: 'docker',
      endpoint: 'https://cluster.example',
      credential: 'k',
    },
    parse: (body) => Promise.resolve(parseCreateRuntimeConnectionInput(body).ok),
  },
};

function asStringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value.map((item, index) => asString(item, `${what}[${String(index)}]`));
}

function without(body: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([k]) => k !== key));
}

describe('request field lists against the real parsers', () => {
  const vectors = loadVectors(FAMILY, 'request-fields.json').filter((v) =>
    Object.keys(REQUESTS).includes(asString(field(v.input, 'request', v.id), v.id)),
  );

  it('replays every server-side request the model lists', () => {
    expect(vectors.map((v) => asString(field(v.input, 'request', v.id), v.id)).sort()).toEqual(
      Object.keys(REQUESTS).sort(),
    );
  });

  it.each(vectors.map((v) => [v.id, v] as const))('%s', async (_id, v) => {
    const request = REQUESTS[asString(field(v.input, 'request', v.id), v.id)];
    if (request === undefined) throw new Error(`${v.id}: no request`);
    const fields = asStringList(field(v.expected, 'fields', v.id), 'fields');
    const required = asStringList(field(v.expected, 'required', v.id), 'required');
    expect(Object.keys(request.valid).sort()).toEqual([...fields].sort());
    expect(await request.parse(request.valid)).toBe(
      asBoolean(field(v.expected, 'fullBodyAccepted', v.id), v.id),
    );
    expect(await request.parse({})).toBe(
      asBoolean(field(v.expected, 'emptyBodyAccepted', v.id), v.id),
    );
    expect(await request.parse({ ...request.valid, bogus: 'x' })).toBe(
      !asBoolean(field(v.expected, 'refusesUnknown', v.id), v.id),
    );
    for (const key of fields) {
      expect([key, await request.parse(without(request.valid, key))]).toEqual([
        key,
        !required.includes(key),
      ]);
    }
    for (const key of asStringList(field(v.expected, 'refused', v.id), 'refused')) {
      expect([key, await request.parse({ ...request.valid, [key]: 'x' })]).toEqual([key, false]);
    }
    for (const key of asStringList(field(v.expected, 'ignored', v.id), 'ignored')) {
      expect([key, await request.parse({ ...request.valid, [key]: 'x' })]).toEqual([key, true]);
    }
  });
});

describe('secret operations', () => {
  it.each(loadVectors(FAMILY, 'secret-operations.json').map((v) => [v.id, v] as const))(
    '%s',
    (_id, v) => {
      const store = createInMemorySecretsStoreProvider().forWorkspace(WORKSPACE);
      const current = asStringList(field(v.expected, 'current', v.id), 'current');
      const target = asStringList(field(v.expected, 'target', v.id), 'target');
      expect(Object.keys(store).sort()).toEqual([...current].sort());
      for (const operation of target.filter((op) => !current.includes(op))) {
        expect(operation in store).toBe(false);
      }
    },
  );
});

describe('non-ASCII runtime-connection labels: the recorded divergence', () => {
  it.each(loadVectors(FAMILY, 'runtime-connection-unicode.json').map((v) => [v.id, v] as const))(
    '%s',
    async (_id, v) => {
      const label = asString(field(v.input, 'label', v.id), v.id);
      const driver = asString(field(v.input, 'driver', v.id), v.id);
      const modelName = asNullableString(field(v.expected, 'modelName', v.id), v.id);
      const codeName = asNullableString(field(v.expected, 'codeName', v.id), v.id);
      expect(asBoolean(field(v.expected, 'asciiLabel', v.id), v.id)).toBe(false);
      expect(modelName).not.toBe(codeName);
      const outcome = await createInMemoryRuntimeConnectionStoreProvider()
        .forWorkspace(WORKSPACE)
        .create({ name: label, driver, endpoint: 'https://cluster.example', credential: 'k' });
      expect(outcome.kind === 'created' ? outcome.connection.name : null).toBe(codeName);
    },
  );
});

// ---------------------------------------------------------------------------------------------

describe('runtime-profile PATCH with null against parseUpdateRuntimeProfilePatch', () => {
  it.each(loadVectors(FAMILY, 'profile-patch.json').map((v) => [v.id, v] as const))(
    '%s',
    (_id, v) => {
      const key = asString(field(v.input, 'field', v.id), v.id);
      const kind = asString(field(v.input, 'value', v.id), v.id);
      const value = kind === 'null' ? null : VALID_PROFILE[key];
      expect(value).not.toBeUndefined();
      expect(parseUpdateRuntimeProfilePatch({ [key]: value }).ok).toBe(
        asBoolean(field(v.expected, 'acceptedToday', v.id), v.id),
      );
    },
  );
});

function imageConfig(image: unknown, what: string): Record<string, unknown> {
  const kind = asString(field(image, 'kind', what), what);
  if (kind === 'absent') return {};
  if (kind === 'non-text') return { driverConfig: { image: 42 } };
  return { driverConfig: { image: asString(field(image, 'value', what), what) } };
}

describe('driverConfig.image on create against parseCreateRuntimeProfileInput', () => {
  it.each(loadVectors(FAMILY, 'images.json').map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const body = {
      name: 'default',
      driver: asString(field(v.input, 'driver', v.id), v.id),
      networkPolicy: 'none',
      filesystem: 'read-write',
      ...imageConfig(field(v.input, 'image', v.id), v.id),
    };
    expect(parseCreateRuntimeProfileInput(body).ok).toBe(
      asBoolean(field(v.expected, 'acceptedOnCreate', v.id), v.id),
    );
  });
});

describe('value rules against the real parsers', () => {
  it.each(loadVectors(FAMILY, 'value-rules.json').map((v) => [v.id, v] as const))(
    '%s',
    async (_id, v) => {
      const value = asString(v.input, v.id);
      const expected = asRecord(v.expected, v.id);
      const name = asBoolean(expected['modelConnectionName'], 'modelConnectionName');
      const apiKey = asBoolean(expected['modelConnectionApiKey'], 'modelConnectionApiKey');
      const text = asBoolean(expected['runtimeConnectionText'], 'runtimeConnectionText');
      const credential = asBoolean(
        expected['runtimeConnectionCredential'],
        'runtimeConnectionCredential',
      );
      const mc = { name: 'Claude', provider: 'anthropic', apiKey: 'sk-test' };
      expect((await parseCreateModelConnection({ ...mc, name: value }, allowEveryUrl)).ok).toBe(
        name,
      );
      expect(
        (await parseUpdateModelConnection({ name: value }, 'anthropic', allowEveryUrl)).ok,
      ).toBe(name);
      expect((await parseCreateModelConnection({ ...mc, apiKey: value }, allowEveryUrl)).ok).toBe(
        apiKey,
      );
      const rc = {
        name: 'primary',
        driver: 'docker',
        endpoint: 'https://cluster.example',
        credential: 'k',
      };
      expect(parseCreateRuntimeConnectionInput({ ...rc, name: value }).ok).toBe(text);
      expect(parseCreateRuntimeConnectionInput({ ...rc, endpoint: value }).ok).toBe(text);
      expect(parseCreateRuntimeConnectionInput({ ...rc, credential: value }).ok).toBe(credential);
    },
  );
});
