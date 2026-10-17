import { describe, expect, it } from 'vitest';

import {
  mintSessionToken,
  newSessionClaims,
  verifySessionToken,
  type VerifiedSessionClaims,
} from '../auth/session';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { resolverForRow } from './item-ownership';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_ID = '99999999-9999-4999-8999-999999999999';
const OWNER_USER_ID = '22222222-2222-4222-8222-222222222222';
const API_KEY_ID = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL_ID = '44444444-4444-4444-8444-444444444444';
const HUMAN_PRINCIPAL_ID = '77777777-7777-4777-8777-777777777777';
const SESSION_SECRET = 'a-test-session-secret-that-is-long-enough-32';

async function verifiedClaims(): Promise<VerifiedSessionClaims> {
  const token = await mintSessionToken(
    newSessionClaims('owner@example.test', 'workspace'),
    SESSION_SECRET,
  );
  const verified = await verifySessionToken(token, SESSION_SECRET);
  if (!verified.ok)
    throw new Error(`the fixture could not verify its own token: ${verified.reason}`);
  return verified.claims;
}

async function human(): Promise<Principal> {
  const built = Principal.fromSession(
    await verifiedClaims(),
    { id: WORKSPACE_ID, slug: 'workspace' },
    'owner',
    {
      principalId: HUMAN_PRINCIPAL_ID,
      userId: OWNER_USER_ID,
      label: 'Owner',
    },
  );
  if (!built.ok) throw new Error(built.because);
  return built.principal;
}

function machine(workspaceId = WORKSPACE_ID, principalId = PRINCIPAL_ID): Principal {
  return Principal.fromApiKey({
    principalId,
    apiKeyId: API_KEY_ID,
    workspaceId,
    role: 'builder',
    label: 'CI key',
  });
}

const directory = createMemoryDirectory({
  users: [
    {
      id: OWNER_USER_ID,
      email: 'owner@example.test',
      name: 'Owner',
      workspaceId: WORKSPACE_ID,
      role: 'owner',
    },
  ],
}).forWorkspace(WORKSPACE_ID);

const notFound = () => ({
  status: 404,
  body: { error: { code: 'resource_not_found', detail: 'Resource not found.' } },
});

describe('owned-resource WorkspacePrincipal authorization', () => {
  it('keeps exact Membership ownership compatible during the migration window', async () => {
    const exactPrincipal = resolverForRow(
      () =>
        Promise.resolve({
          workspaceId: WORKSPACE_ID,
          ownerPrincipalId: HUMAN_PRINCIPAL_ID,
          createdBy: 'someone-else',
        }),
      notFound,
    );
    const exactLegacyUser = resolverForRow(
      () => Promise.resolve({ workspaceId: WORKSPACE_ID, createdBy: OWNER_USER_ID }),
      notFound,
    );

    await expect(exactPrincipal(await human(), directory)).resolves.toEqual({
      kind: 'ownership',
      ownership: 'own',
    });
    await expect(exactLegacyUser(await human(), directory)).resolves.toEqual({
      kind: 'ownership',
      ownership: 'own',
    });
  });

  it('refuses a machine on a legacy human-only row instead of borrowing the oldest Owner', async () => {
    const resolve = resolverForRow(
      () => Promise.resolve({ workspaceId: WORKSPACE_ID, createdBy: OWNER_USER_ID }),
      notFound,
    );

    await expect(resolve(machine(), directory)).resolves.toEqual({
      kind: 'refuse',
      result: {
        status: 403,
        body: {
          error: {
            code: 'machine_ownership_unsupported',
            message: 'This legacy resource has no machine principal owner.',
            detail: 'This legacy resource has no machine principal owner.',
          },
        },
      },
    });
  });

  it('grants own only when the persisted owner principal is the exact machine principal', async () => {
    const own = resolverForRow(
      () =>
        Promise.resolve({
          workspaceId: WORKSPACE_ID,
          ownerPrincipalId: PRINCIPAL_ID,
          createdBy: OWNER_USER_ID,
        }),
      notFound,
    );
    const other = resolverForRow(
      () =>
        Promise.resolve({
          workspaceId: WORKSPACE_ID,
          ownerPrincipalId: '55555555-5555-4555-8555-555555555555',
          createdBy: OWNER_USER_ID,
        }),
      notFound,
    );

    await expect(own(machine(), directory)).resolves.toEqual({
      kind: 'ownership',
      ownership: 'own',
    });
    await expect(other(machine(), directory)).resolves.toEqual({
      kind: 'ownership',
      ownership: 'other',
    });
  });

  it('does not turn a same-id claim from another tenant into an ownership decision', async () => {
    const resolve = resolverForRow(
      () => Promise.resolve({ workspaceId: WORKSPACE_ID, ownerPrincipalId: PRINCIPAL_ID }),
      notFound,
    );

    await expect(resolve(machine(OTHER_WORKSPACE_ID, PRINCIPAL_ID), directory)).resolves.toEqual({
      kind: 'refuse',
      result: notFound(),
    });
  });
});
