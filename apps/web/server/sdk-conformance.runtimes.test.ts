/**
 * SDK conformance, runtimes: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { describe, expect, it } from 'vitest';
import {
  type CreateRuntimeConnectionInput,
  type CreateRuntimeProfileInput,
  RUNTIME_DRIVERS,
  RUNTIME_FILESYSTEM_MODES,
  RUNTIME_NETWORK_POLICIES,
  RUNTIME_PROFILE_BOUNDS,
  RuntimeConnectionListResponseSchema,
  RuntimeConnectionResourceSchema,
  RuntimeProfileListResponseSchema,
  RuntimeProfileResourceSchema,
  type UpdateRuntimeProfilePatch,
} from '@indx-workspace/contracts/runtimes';
import {
  SECRET_NAME_MAX_LENGTH,
  SECRET_NAME_PATTERN,
  SECRET_VALUE_MAX_LENGTH,
  SecretListResponseSchema,
  SecretResourceSchema,
} from '@indx-workspace/contracts/secrets';
import {
  CreateRuntimeProfileInput as CoreCreateRuntimeProfileInputSchema,
  runtimeDriverIds,
} from '@agent-workspace/run-protocol';
import {
  createInMemoryRuntimeConnectionStoreProvider,
  createRuntimeConnection,
  listRuntimeConnections,
  toRuntimeConnectionResource,
} from './runtimes/connections';
import {
  parseCreateRuntimeProfileInput,
  parseUpdateRuntimeProfilePatch,
  toRuntimeProfileResource,
} from './runtimes/contract';
import { createRuntimeProfile, listRuntimeProfiles } from './runtimes/handlers';
import { createInMemoryRuntimeProfileStoreProvider } from './runtimes/memory-store';
import { type RuntimeProfileRecord } from './runtimes/store';
import {
  parseCreateSecretBody,
  parseReplaceSecretBody,
  SECRET_NAME_PATTERN as SERVER_SECRET_NAME_PATTERN,
  SECRET_VALUE_MAX_LENGTH as SERVER_SECRET_VALUE_MAX_LENGTH,
  toSecretResource,
} from './secrets/contract';
import { createSecret, listSecrets, replaceSecret } from './secrets/handlers';
import { createInMemorySecretsStoreProvider } from './secrets/memory-store';

const RUNTIME_WORKSPACE = '44444444-4444-4444-8444-444444444444';

const RUNTIME_CONNECTION = '22222222-2222-4222-8222-222222222222';

const unrestricted = () => Promise.resolve(null);

const minimalProfile: RuntimeProfileRecord = {
  id: '88888888-8888-4888-8888-888888888888',
  workspaceId: RUNTIME_WORKSPACE,
  name: 'Standard',
  driver: 'docker',
  runtimeConnectionId: null,
  cpu: null,
  memoryMb: null,
  diskMb: null,
  networkPolicy: 'restricted',
  allowedDomains: null,
  filesystem: 'read-write',
  persistPaths: null,
  timeoutSeconds: null,
  idleTimeoutSeconds: null,
  driverConfig: null,
  createdAt: new Date('2026-09-21T10:00:00.000Z'),
  updatedAt: new Date('2026-09-21T10:00:00.000Z'),
};

const createProfileBody: CreateRuntimeProfileInput = {
  name: 'Pinned',
  driver: 'kubernetes',
  networkPolicy: 'restricted',
  allowedDomains: ['api.anthropic.com'],
  filesystem: 'read-only',
  persistPaths: ['/workspace/.cache'],
  cpu: 0.5,
  memoryMb: 2048,
  diskMb: 10_240,
  timeoutSeconds: 3600,
  idleTimeoutSeconds: 600,
  driverConfig: { image: `ghcr.io/x/runner@sha256:${'a'.repeat(64)}`, namespace: 'agents' },
};

const SECRETS_WORKSPACE = '99999999-9999-4999-8999-999999999999';

const SECRET_PLAINTEXT = 'sk-ant-conformance-plaintext-never-on-the-wire';

describe('runtimes', () => {
  it('renders a minimal record and a fully pinned one into the published shape', () => {
    expect(
      RuntimeProfileResourceSchema.safeParse(toRuntimeProfileResource(minimalProfile)).success,
    ).toBe(true);
    const pinned: RuntimeProfileRecord = {
      ...minimalProfile,
      driver: 'kubernetes',
      runtimeConnectionId: RUNTIME_CONNECTION,
      cpu: 0.5,
      memoryMb: 2048,
      diskMb: 10_240,
      networkPolicy: 'none',
      allowedDomains: ['api.anthropic.com'],
      filesystem: 'read-only',
      persistPaths: ['/workspace/.cache'],
      timeoutSeconds: 3600,
      idleTimeoutSeconds: 600,
      driverConfig: { image: `ghcr.io/x/runner@sha256:${'a'.repeat(64)}` },
    };
    const parsed = RuntimeProfileResourceSchema.parse(toRuntimeProfileResource(pinned));
    expect(parsed.createdAt).toBe('2026-09-21T10:00:00.000Z');
    expect(parsed.runtimeConnectionId).toBe(RUNTIME_CONNECTION);
  });

  it('answers create with a bare item and list with the published envelope', async () => {
    const store = createInMemoryRuntimeProfileStoreProvider().forWorkspace(RUNTIME_WORKSPACE);
    const created = await createRuntimeProfile(store, createProfileBody, unrestricted);
    expect(created.status).toBe(201);
    expect(RuntimeProfileResourceSchema.safeParse(created.body).success).toBe(true);
    const listed = await listRuntimeProfiles(store);
    expect(listed.status).toBe(200);
    expect(RuntimeProfileListResponseSchema.safeParse(listed.body).success).toBe(true);
  });

  it('restates the same drivers, network policies and filesystem modes as the contract', () => {
    expect([...runtimeDriverIds]).toEqual([...RUNTIME_DRIVERS]);
    expect(CoreCreateRuntimeProfileInputSchema.shape.driver.options).toEqual([...RUNTIME_DRIVERS]);
    expect(CoreCreateRuntimeProfileInputSchema.shape.networkPolicy.options).toEqual([
      ...RUNTIME_NETWORK_POLICIES,
    ]);
    expect(CoreCreateRuntimeProfileInputSchema.shape.filesystem.options).toEqual([
      ...RUNTIME_FILESYSTEM_MODES,
    ]);
  });
});

describe('runtimes', () => {
  it('accepts the sizing values the contract accepts and refuses the ones it refuses', () => {
    const probes: readonly (readonly [keyof typeof RUNTIME_PROFILE_BOUNDS, number])[] = [
      ['cpu', RUNTIME_PROFILE_BOUNDS.cpu.exclusiveMin],
      ['cpu', 0.25],
      ['memoryMb', RUNTIME_PROFILE_BOUNDS.memoryMb.min - 1],
      ['memoryMb', RUNTIME_PROFILE_BOUNDS.memoryMb.min],
      ['memoryMb', 1.5],
      ['diskMb', RUNTIME_PROFILE_BOUNDS.diskMb.max],
      ['diskMb', RUNTIME_PROFILE_BOUNDS.diskMb.max + 2],
      ['timeoutSeconds', -1],
      ['idleTimeoutSeconds', RUNTIME_PROFILE_BOUNDS.idleTimeoutSeconds.min],
    ];
    for (const [field, value] of probes) {
      const server = parseCreateRuntimeProfileInput({ ...createProfileBody, [field]: value }).ok;
      const contract = RuntimeProfileResourceSchema.safeParse({
        ...toRuntimeProfileResource(minimalProfile),
        [field]: value,
      }).success;
      expect(server, `server and contract disagree on ${field}=${String(value)}`).toBe(contract);
    }
  });

  it('parses the bodies the SDK types as create and patch inputs', () => {
    expect(parseCreateRuntimeProfileInput(createProfileBody).ok).toBe(true);
    const patch: UpdateRuntimeProfilePatch = { networkPolicy: 'none', memoryMb: 512 };
    expect(parseUpdateRuntimeProfilePatch(patch).ok).toBe(true);
    // A patch cannot clear a sizing field: the route refuses `null`, as the contract documents.
    expect(parseUpdateRuntimeProfilePatch({ memoryMb: null }).ok).toBe(false);
  });
});

describe('runtimes', () => {
  it('renders a connection without its endpoint or credential, bare and in the list envelope', async () => {
    expect(
      RuntimeConnectionResourceSchema.safeParse(
        toRuntimeConnectionResource({
          id: RUNTIME_CONNECTION,
          name: 'RUNTIME_CONNECTION__DOCKER__PRIMARY',
          driver: 'docker',
          createdAt: new Date('2026-09-21T10:00:00.000Z'),
        }),
      ).success,
    ).toBe(true);
    const store = createInMemoryRuntimeConnectionStoreProvider().forWorkspace(RUNTIME_WORKSPACE);
    const body: CreateRuntimeConnectionInput = {
      name: 'Primary',
      driver: 'docker',
      endpoint: 'tcp://docker.internal:2376',
      credential: 'cert-and-key',
    };
    const created = await createRuntimeConnection(store, body);
    expect(created.status).toBe(201);
    // `.strict()` is the proof: a `credential` or `endpoint` key in the body would fail here.
    expect(RuntimeConnectionResourceSchema.safeParse(created.body).success).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain('cert-and-key');
    const listed = await listRuntimeConnections(store);
    expect(RuntimeConnectionListResponseSchema.safeParse(listed.body).success).toBe(true);
  });
});

describe('secrets', () => {
  it('renders a store record into the published shape', () => {
    const resource = toSecretResource({
      id: '88888888-8888-4888-8888-888888888888',
      name: 'ANTHROPIC_API_KEY',
      algorithm: 'aes-256-gcm',
      masterKeyId: 'local-dev-key-1',
      createdAt: new Date('2026-09-21T10:00:00.000Z'),
      updatedAt: new Date('2026-09-21T10:05:00.000Z'),
    });
    expect(SecretResourceSchema.safeParse(resource).success).toBe(true);
  });

  it('answers create, list and replace through the real handlers with bodies the contract accepts, and no body carries the value', async () => {
    const store = createInMemorySecretsStoreProvider().forWorkspace(SECRETS_WORKSPACE);

    const created = await createSecret(store, { name: 'GITHUB_TOKEN', value: SECRET_PLAINTEXT });
    expect(created.status).toBe(201);
    const createdParsed = SecretResourceSchema.safeParse(created.body);
    expect(createdParsed.success, JSON.stringify(createdParsed)).toBe(true);
    if (!createdParsed.success) return;

    const listed = await listSecrets(store);
    expect(listed.status).toBe(200);
    expect(SecretListResponseSchema.safeParse(listed.body).success).toBe(true);

    const rotated = 'sk-ant-conformance-rotated-value';
    const replaced = await replaceSecret(store, createdParsed.data.id, { value: rotated });
    expect(replaced.status).toBe(200);
    expect(SecretResourceSchema.safeParse(replaced.body).success).toBe(true);

    for (const body of [created.body, listed.body, replaced.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(SECRET_PLAINTEXT);
      expect(text).not.toContain(rotated);
      expect(text).not.toContain('"value"');
    }
  });

  it('restates the same name shape and value bound as the contract', () => {
    expect(SERVER_SECRET_NAME_PATTERN.source).toBe(SECRET_NAME_PATTERN.source);
    expect(SERVER_SECRET_NAME_PATTERN.flags).toBe(SECRET_NAME_PATTERN.flags);
    expect(SERVER_SECRET_VALUE_MAX_LENGTH).toBe(SECRET_VALUE_MAX_LENGTH);

    const longestName = `A${'B'.repeat(SECRET_NAME_MAX_LENGTH - 1)}`;
    expect(parseCreateSecretBody({ name: longestName, value: 'v' }).ok).toBe(true);
    expect(parseCreateSecretBody({ name: `${longestName}C`, value: 'v' }).ok).toBe(false);
    expect(
      parseCreateSecretBody({ name: 'TOKEN', value: 'x'.repeat(SECRET_VALUE_MAX_LENGTH) }).ok,
    ).toBe(true);
    expect(
      parseCreateSecretBody({ name: 'TOKEN', value: 'x'.repeat(SECRET_VALUE_MAX_LENGTH + 1) }).ok,
    ).toBe(false);
  });
});

describe('secrets', () => {
  it('accepts exactly the request bodies the SDK sends', () => {
    expect(parseCreateSecretBody({ name: 'TOKEN', value: 'v' }).ok).toBe(true);
    expect(parseCreateSecretBody({ name: 'TOKEN', value: 'v', extra: 1 }).ok).toBe(false);
    expect(parseReplaceSecretBody({ value: 'v' }).ok).toBe(true);
    expect(parseReplaceSecretBody({ name: 'RENAMED', value: 'v' }).ok).toBe(false);
  });
});
