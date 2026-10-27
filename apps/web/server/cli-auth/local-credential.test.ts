/**
 * S1-21 (issue #500): `issueLocalApiKey` over an in-memory `api_keys` table behind a typed fake of
 * the database directory. `local-credential.integration.test.ts` proves the same flow against
 * PostgreSQL and the real control-plane routes.
 *
 * S1-24 (issue #509): the fake records every directory call in order, so the tests pin that the
 * ownership repair runs before the sweep and the create, and that the key acts for the issuer.
 */
import { captureLog } from '../telemetry/capture-log';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { API_KEY_PATTERN } from '@indx-workspace/contracts/api-keys';
import { CLI_TOKEN_TTL_SECONDS } from '@indx-workspace/contracts/cli-auth';
import type {
  DatabaseDirectoryRoot,
  DatabaseWorkspaceDirectory,
  DirectoryApiKeyRecord,
} from '@agent-workspace/core/db';

import type { Role } from '../rbac/roles';

import { conferRole } from '../rbac/conferral';
import { ROLES } from '../rbac/roles';
import {
  issueLocalApiKey,
  LOCAL_RUNTIME_API_KEY_NAME_PREFIX,
  LocalCredentialError,
  mayHoldLocalApiKey,
} from './local-credential';

const WORKSPACE_ID = '5a000000-0000-4000-8000-000000000001';
const USER_ID = '5a000000-0000-4000-8000-000000000002';
const OTHER_USER_ID = '5a000000-0000-4000-8000-000000000003';
const NOW = new Date(Date.UTC(2026, 9, 2, 12));

interface FakeDirectory {
  readonly root: DatabaseDirectoryRoot;
  readonly keys: DirectoryApiKeyRecord[];
  /** The stored role of each member of {@link WORKSPACE_ID}, by user id. */
  readonly members: Map<string, Role>;
  /** Names the next `createApiKey` calls answer `name-taken` for, in order. */
  readonly takenOnce: { count: number };
  readonly failWith: { error: Error | undefined };
  /** Fails only `reassignLocalRuntimeKeyOwnership`, after the membership read succeeded. */
  readonly failRepairWith: { error: Error | undefined };
  /** Every directory call, in order, with the arguments the S1-24 tests pin. */
  readonly calls: string[];
  readonly repairs: { toPrincipalId: string }[];
  readonly actsFor: (string | undefined)[];
}

function unused(): Promise<never> {
  return Promise.reject(new Error('not used by the local credential'));
}

/**
 * Only the API-key methods and `listMemberships` of one workspace are live; every other method
 * rejects. {@link USER_ID} is an `admin` member of {@link WORKSPACE_ID} unless a test changes it.
 */
function fakeDirectory(seed: readonly DirectoryApiKeyRecord[] = []): FakeDirectory {
  const keys: DirectoryApiKeyRecord[] = [...seed];
  const members = new Map<string, Role>([[USER_ID, 'admin']]);
  const takenOnce = { count: 0 };
  const failWith: { error: Error | undefined } = { error: undefined };
  const failRepairWith: { error: Error | undefined } = { error: undefined };
  const calls: string[] = [];
  const repairs: { toPrincipalId: string }[] = [];
  const actsFor: (string | undefined)[] = [];
  let sequence = 0;

  const workspace = (workspaceId: string): DatabaseWorkspaceDirectory => ({
    listUsers: unused,
    createUser: unused,
    listMemberships: () => {
      if (failWith.error !== undefined) return Promise.reject(failWith.error);
      if (workspaceId !== WORKSPACE_ID) return Promise.resolve([]);
      return Promise.resolve(
        [...members].map(([userId, role], index) => ({
          id: `membership-${String(index)}`,
          principalId: `member-principal-${String(index)}`,
          userId,
          email: `${String(index)}@local.test`,
          name: `Member ${String(index)}`,
          role,
          createdAt: NOW,
        })),
      );
    },
    createMembership: unused,
    changeMembershipRole: unused,
    deleteMembership: unused,
    listApiKeys: () => {
      calls.push('listApiKeys');
      if (failWith.error !== undefined) return Promise.reject(failWith.error);
      return Promise.resolve(keys.filter((key) => key.workspaceId === workspaceId));
    },
    createApiKey: (input) => {
      calls.push('createApiKey');
      actsFor.push(input.actsForPrincipalId);
      if (takenOnce.count > 0) {
        takenOnce.count -= 1;
        return Promise.resolve({ kind: 'name-taken', name: input.name });
      }
      sequence += 1;
      const key: DirectoryApiKeyRecord = {
        id: `key-${String(sequence)}`,
        principalId: `principal-${String(sequence)}`,
        workspaceId,
        name: input.name,
        role: input.role,
        keyPrefix: input.keyPrefix,
        keyHash: input.keyHash,
        lastUsedAt: null,
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdAt: NOW,
        actsForPrincipalId: input.actsForPrincipalId ?? null,
        endpointScope: null,
      };
      keys.push(key);
      return Promise.resolve({ kind: 'created', key });
    },
    createEndpointApiKey: unused,
    revokeApiKey: (id, now) => {
      calls.push('revokeApiKey');
      const index = keys.findIndex((key) => key.id === id && key.workspaceId === workspaceId);
      const key = keys[index];
      if (key === undefined) return Promise.resolve({ kind: 'no-such-key', id });
      if (key.revokedAt !== null) return Promise.resolve({ kind: 'already-revoked', key });
      const revoked = { ...key, revokedAt: now };
      keys[index] = revoked;
      return Promise.resolve({ kind: 'revoked', key: revoked });
    },
    readApiKey: unused,
    reassignLocalRuntimeKeyOwnership: (repair) => {
      calls.push('reassignLocalRuntimeKeyOwnership');
      repairs.push({ ...repair });
      if (failRepairWith.error !== undefined) return Promise.reject(failRepairWith.error);
      return Promise.resolve({ reassigned: 0 });
    },
    listInvitations: unused,
    createInvitation: unused,
    resendInvitation: unused,
    revokeInvitation: unused,
  });

  const root: DatabaseDirectoryRoot = {
    forWorkspace: workspace,
    authenticateApiKeyHash: unused,
    resolveRole: unused,
    principalById: unused,
    findUserByEmail: unused,
    findIdentity: unused,
    linkIdentity: unused,
    membershipsForUser: unused,
    acceptInvitation: unused,
  };
  return { root, keys, members, takenOnce, failWith, failRepairWith, calls, repairs, actsFor };
}

function storedKey(overrides: Partial<DirectoryApiKeyRecord>): DirectoryApiKeyRecord {
  return {
    id: 'stale',
    principalId: 'principal-stale',
    workspaceId: WORKSPACE_ID,
    name: `${LOCAL_RUNTIME_API_KEY_NAME_PREFIX}AAAAAAAA`,
    role: 'admin',
    keyPrefix: `ak_live_${'a'.repeat(22)}`,
    keyHash: 'f'.repeat(64),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: NOW,
    actsForPrincipalId: null,
    endpointScope: null,
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<LocalCredentialError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof LocalCredentialError)) throw new Error('expected a LocalCredentialError');
  return error;
}

const input = { workspaceId: WORKSPACE_ID, userId: USER_ID } as const;

describe('mayHoldLocalApiKey', () => {
  it.each(ROLES)('answers for %s exactly what conferRole(role, admin) answers', (role) => {
    expect(mayHoldLocalApiKey(role)).toBe(conferRole(role, 'admin').effect === 'allow');
  });

  it('allows an owner and an admin and nobody else', () => {
    expect(ROLES.filter((role) => mayHoldLocalApiKey(role))).toEqual(['owner', 'admin']);
  });
});

describe('issueLocalApiKey', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['owner', 'admin'] as const)(
    'mints an admin ak_live_ key with a 12 h expiry for an %s, and revoke() answers revoked then already-revoked',
    async (role) => {
      const directory = fakeDirectory();
      directory.members.set(USER_ID, role);
      const credential = await issueLocalApiKey(input, {
        directory: directory.root,
        now: () => NOW,
      });

      expect(credential.token).toMatch(API_KEY_PATTERN);
      expect(credential.workspaceId).toBe(WORKSPACE_ID);
      expect(credential.expiresAt.getTime()).toBe(NOW.getTime() + CLI_TOKEN_TTL_SECONDS * 1000);
      expect(directory.keys).toHaveLength(1);
      const [stored] = directory.keys;
      expect(stored?.role).toBe('admin');
      expect(stored?.expiresAt?.getTime()).toBe(credential.expiresAt.getTime());
      expect(stored?.name).toMatch(/^aw dev local runtime [A-Za-z0-9_-]{8}$/u);
      expect(stored?.name.startsWith(LOCAL_RUNTIME_API_KEY_NAME_PREFIX)).toBe(true);
      expect(JSON.stringify(stored)).not.toContain(credential.token);

      await expect(credential.revoke()).resolves.toBe('revoked');
      expect(directory.keys[0]?.revokedAt).toEqual(NOW);
      await expect(credential.revoke()).resolves.toBe('already-revoked');
    },
  );

  it('answers missing when the key row no longer exists', async () => {
    const directory = fakeDirectory();
    const credential = await issueLocalApiKey(input, { directory: directory.root });
    directory.keys.length = 0;
    await expect(credential.revoke()).resolves.toBe('missing');
  });

  it.each(['builder', 'viewer'] as const)(
    'refuses a member whose stored role is %s with not_issued: the key would exceed them',
    async (role) => {
      const directory = fakeDirectory();
      directory.members.set(USER_ID, role);
      const error = await rejection(issueLocalApiKey(input, { directory: directory.root }));
      expect(error.code).toBe('not_issued');
      expect(directory.keys).toHaveLength(0);
    },
  );

  it('refuses a user who is not a member of the workspace with not_issued', async () => {
    const directory = fakeDirectory();
    const error = await rejection(
      issueLocalApiKey({ ...input, userId: OTHER_USER_ID }, { directory: directory.root }),
    );
    expect(error.code).toBe('not_issued');
    expect(directory.keys).toHaveLength(0);
  });

  it('takes no role from its caller: a claimed admin role is invalid input', async () => {
    const directory = fakeDirectory();
    directory.members.set(USER_ID, 'builder');
    const error = await rejection(
      issueLocalApiKey({ ...input, role: 'admin' }, { directory: directory.root }),
    );
    expect(error.code).toBe('invalid_input');
    expect(directory.keys).toHaveLength(0);
  });

  it('revokes unrevoked keys with the reserved prefix and leaves every other key alone', async () => {
    const directory = fakeDirectory([
      storedKey({ id: 'stale-1' }),
      storedKey({ id: 'stale-2', name: `${LOCAL_RUNTIME_API_KEY_NAME_PREFIX}BBBBBBBB` }),
      storedKey({
        id: 'already',
        name: `${LOCAL_RUNTIME_API_KEY_NAME_PREFIX}CCCCCCCC`,
        revokedAt: NOW,
      }),
      storedKey({ id: 'ci', name: 'ci deploy key' }),
      storedKey({ id: 'other-workspace', workspaceId: '5a000000-0000-4000-8000-000000000009' }),
    ]);
    const later = new Date(NOW.getTime() + 1000);
    const credential = await issueLocalApiKey(input, {
      directory: directory.root,
      now: () => later,
    });

    const byId = new Map(directory.keys.map((key) => [key.id, key]));
    expect(byId.get('stale-1')?.revokedAt).toEqual(later);
    expect(byId.get('stale-2')?.revokedAt).toEqual(later);
    expect(byId.get('already')?.revokedAt).toEqual(NOW);
    expect(byId.get('ci')?.revokedAt).toBeNull();
    expect(byId.get('other-workspace')?.revokedAt).toBeNull();
    const live = directory.keys.filter(
      (key) =>
        key.workspaceId === WORKSPACE_ID &&
        key.revokedAt === null &&
        key.name.startsWith(LOCAL_RUNTIME_API_KEY_NAME_PREFIX),
    );
    expect(live).toHaveLength(1);
    await credential.revoke();
  });

  it('tries a second name once when the first is taken', async () => {
    const directory = fakeDirectory();
    directory.takenOnce.count = 1;
    const credential = await issueLocalApiKey(input, { directory: directory.root });
    expect(credential.token).toMatch(API_KEY_PATTERN);
    expect(directory.keys).toHaveLength(1);
  });

  it('gives up with not_issued when both names are taken', async () => {
    const directory = fakeDirectory();
    directory.takenOnce.count = 2;
    const error = await rejection(issueLocalApiKey(input, { directory: directory.root }));
    expect(error.code).toBe('not_issued');
    expect(directory.keys).toHaveLength(0);
  });

  it.each([
    { workspaceId: 'not-a-uuid', userId: USER_ID },
    { workspaceId: WORKSPACE_ID, userId: '' },
    { workspaceId: WORKSPACE_ID },
    { workspaceId: WORKSPACE_ID, userId: USER_ID, name: 'mine' },
  ])('refuses invalid input %j before touching the directory', async (bad) => {
    const directory = fakeDirectory();
    const error = await rejection(issueLocalApiKey(bad, { directory: directory.root }));
    expect(error.code).toBe('invalid_input');
    expect(directory.keys).toHaveLength(0);
  });

  it('turns a database failure into not_issued, keeping the database error off the message', async () => {
    const directory = fakeDirectory();
    const databaseError = Object.assign(new Error('relation api_keys is unavailable'), {
      code: '57P01',
    });
    directory.failWith.error = databaseError;
    const error = await rejection(issueLocalApiKey(input, { directory: directory.root }));
    expect(error.code).toBe('not_issued');
    expect(error.message).not.toContain('api_keys');
    expect(error.cause).toBe(databaseError);
  });

  it('repairs ownership before the sweep and creates the key acting for the issuer (S1-24)', async () => {
    const directory = fakeDirectory([storedKey({ id: 'stale-1' })]);
    const credential = await issueLocalApiKey(input, { directory: directory.root });

    // `listMemberships` answers USER_ID as the first member, whose principal is this one.
    const issuerPrincipalId = 'member-principal-0';
    expect(directory.calls).toEqual([
      'reassignLocalRuntimeKeyOwnership',
      'listApiKeys',
      'revokeApiKey',
      'createApiKey',
    ]);
    expect(directory.repairs).toEqual([{ toPrincipalId: issuerPrincipalId }]);
    expect(directory.actsFor).toEqual([issuerPrincipalId]);
    const created = directory.keys.find((key) => key.id !== 'stale-1');
    expect(created?.actsForPrincipalId).toBe(issuerPrincipalId);
    await credential.revoke();
  });

  it('gives up with not_issued when the repair fails, sweeping and minting nothing', async () => {
    const directory = fakeDirectory([storedKey({ id: 'stale-1' })]);
    const repairError = new Error('relation agents is unavailable');
    directory.failRepairWith.error = repairError;
    const error = await rejection(issueLocalApiKey(input, { directory: directory.root }));
    expect(error.code).toBe('not_issued');
    expect(error.message).not.toContain('agents');
    expect(error.cause).toBe(repairError);
    expect(directory.calls).toEqual(['reassignLocalRuntimeKeyOwnership']);
    expect(directory.keys.map((key) => [key.id, key.revokedAt])).toEqual([['stale-1', null]]);
  });

  it('runs no repair for a member who may not hold the key', async () => {
    const directory = fakeDirectory();
    directory.members.set(USER_ID, 'builder');
    await rejection(issueLocalApiKey(input, { directory: directory.root }));
    expect(directory.calls).toEqual([]);
  });

  it('writes neither the key nor its hash to the console or an error message', async () => {
    const capture = captureLog();
    const directory = fakeDirectory();
    const credential = await issueLocalApiKey(input, { directory: directory.root });
    await credential.revoke();
    directory.takenOnce.count = 2;
    const failure = await rejection(issueLocalApiKey(input, { directory: directory.root }));

    const written = capture.text();
    expect(written).not.toContain('ak_live_');
    const [stored] = directory.keys;
    expect(stored).toBeDefined();
    expect(written).not.toContain(String(stored?.keyHash));
    expect(failure.message).not.toContain('ak_live_');
    expect(String(failure.cause)).not.toContain('ak_live_');
  });
});
