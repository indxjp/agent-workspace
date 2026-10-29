/**
 * `GET`/`PUT /api/workspaces/:id/features` (ADR-0160 D6–D8, issue #1496), driven with real
 * `Request` objects: who may read, who may write, what a refusal answers, and the audit row a
 * change leaves.
 */
import { FEATURE_IDS, type FeatureId } from '@indx-workspace/contracts/features';
import { afterEach, describe, expect, it } from 'vitest';

import { clearApplicationContext } from '../../../../../server/application-context';
import { installTestDomains } from '../../../../../server/application-context-fixtures';
import { conferredBy } from '../../../../../server/rbac/conferral';
import { installRbacHarness } from '../../../../../server/rbac/testing';
import type { WorkspaceFeaturesAuditEvent } from '../../../../../server/workspaces/features-runtime';
import { createMemoryWorkspaceRepository } from '../../../../../server/workspaces/testing';
import { GET, PUT } from './route';

/** The session workspace every caller below signs in to. */
const WORKSPACE = '7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff';
/** A second workspace: `CROSS` is its Owner, and no other caller belongs to it. */
const SECOND = 'c75a16a5-ab05-4309-9cbb-449baf33c4c1';
const FOREIGN = '6b41fd4a-7bcb-4068-8a76-a59530ec35a6';
const OWNER = { id: 'user-owner', email: 'owner@example.com', name: 'Owner' };
const ADMIN = { id: 'user-admin', email: 'admin@example.com', name: 'Admin' };
const BUILDER = { id: 'user-builder', email: 'builder@example.com', name: 'Builder' };
const VIEWER = { id: 'user-viewer', email: 'viewer@example.com', name: 'Viewer' };
/** A Viewer of the session workspace who owns {@link SECOND}. */
const CROSS = { id: 'user-cross', email: 'cross@example.com', name: 'Cross Owner' };

afterEach(() => {
  clearApplicationContext();
});

function seed(deployment: readonly FeatureId[] = FEATURE_IDS) {
  const harness = installRbacHarness(
    [
      { ...OWNER, workspaceId: WORKSPACE, role: 'owner' },
      { ...ADMIN, workspaceId: WORKSPACE, role: 'admin' },
      { ...BUILDER, workspaceId: WORKSPACE, role: 'builder' },
      { ...VIEWER, workspaceId: WORKSPACE, role: 'viewer' },
      { ...CROSS, workspaceId: WORKSPACE, role: 'viewer' },
      { ...CROSS, workspaceId: SECOND, role: 'owner' },
    ],
    { workspaceId: WORKSPACE, workspaceSlug: 'alpha' },
  );
  const disabled = new Map<string, readonly FeatureId[]>([
    [WORKSPACE, []],
    [SECOND, []],
  ]);
  const audit: WorkspaceFeaturesAuditEvent[] = [];
  installTestDomains({
    workspaces: {
      repository: createMemoryWorkspaceRepository({
        workspaces: [
          {
            id: WORKSPACE,
            slug: WORKSPACE,
            name: 'Alpha',
            members: [
              { userId: OWNER.id, role: 'owner' },
              { userId: ADMIN.id, role: 'admin' },
              { userId: BUILDER.id, role: 'builder' },
              { userId: VIEWER.id, role: 'viewer' },
              { userId: CROSS.id, role: 'viewer' },
            ],
          },
          {
            id: SECOND,
            slug: SECOND,
            name: 'Beta',
            members: [{ userId: CROSS.id, role: 'owner' }],
          },
          { id: FOREIGN, slug: FOREIGN, name: 'Gamma', members: [] },
        ],
      }),
    },
    workspaceFeatures: {
      deployment,
      repositoryFor: (workspaceId) => {
        const current = disabled.get(workspaceId);
        if (current === undefined) return Promise.resolve(null);
        return Promise.resolve({
          listDisabled: () => Promise.resolve(disabled.get(workspaceId) ?? []),
          replaceDisabled: (next) => {
            const before = disabled.get(workspaceId) ?? [];
            const after = FEATURE_IDS.filter((id) => next.includes(id));
            disabled.set(workspaceId, after);
            return Promise.resolve({ before, after });
          },
        });
      },
      recordAuditEvent: (event) => {
        audit.push(event);
        return Promise.resolve();
      },
      provisionBuilder: () => Promise.resolve(),
    },
  });
  return { harness, audit, disabled };
}

/** The principal id of `user`'s Membership in `workspaceId`, as the directory holds it. */
async function principalOf(
  harness: ReturnType<typeof seed>['harness'],
  workspaceId: string,
  user: { id: string },
): Promise<string> {
  const memberships = await harness.directory.forWorkspace(workspaceId).listMemberships();
  const found = memberships.find((member) => member.userId === user.id);
  if (found === undefined) throw new Error(`no membership of ${user.id} in ${workspaceId}`);
  return found.principalId;
}

const asOwner = { email: OWNER.email };
const asBuilder = { email: BUILDER.email };

describe('GET /api/workspaces/:id/features', () => {
  it('answers a member one row per feature', async () => {
    const { harness } = seed();
    for (const as of [asOwner, asBuilder]) {
      const response = await harness.call(GET, {
        method: 'GET',
        path: `/api/workspaces/${WORKSPACE}/features`,
        id: WORKSPACE,
        as,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        features: FEATURE_IDS.map((id) => ({ id, installed: true, enabled: true })),
      });
    }
  });

  it('answers a non-member and a non-UUID id with the same 404 workspace_not_found', async () => {
    const { harness } = seed();
    const foreign = await harness.call(GET, {
      method: 'GET',
      path: `/api/workspaces/${FOREIGN}/features`,
      id: FOREIGN,
      as: asOwner,
    });
    const malformed = await harness.call(GET, {
      method: 'GET',
      path: '/api/workspaces/nope/features',
      id: 'nope',
      as: asOwner,
    });
    expect(foreign.status).toBe(404);
    expect(foreign.text).toContain('workspace_not_found');
    expect(malformed.status).toBe(404);
    expect(malformed.text).toBe(foreign.text);
  });

  it('refuses an API key with 403 api_key_not_permitted', async () => {
    const { harness } = seed();
    const key = await harness.directory.forWorkspace(WORKSPACE).createApiKey({
      name: 'features-test',
      role: conferredBy('owner', 'admin', 'features route test'),
      expiresAt: null,
    });
    if (key.kind !== 'created') throw new Error('key setup failed');
    const response = await harness.call(GET, {
      method: 'GET',
      path: `/api/workspaces/${WORKSPACE}/features`,
      id: WORKSPACE,
      as: null,
      bearer: key.presented,
    });
    expect(response.status).toBe(403);
    expect(response.text).toContain('api_key_not_permitted');
  });

  it('answers 503 once no application context is installed', async () => {
    const { harness } = seed();
    harness.teardown();
    const response = await GET(
      new Request(`https://control-plane.test/api/workspaces/${WORKSPACE}/features`),
      { params: Promise.resolve({ id: WORKSPACE }) },
    );
    expect(response.status).toBe(503);
  });
});

describe('PUT /api/workspaces/:id/features', () => {
  const put = (harness: ReturnType<typeof seed>['harness'], as: { email: string }, body: unknown) =>
    harness.call(PUT, {
      method: 'PUT',
      path: `/api/workspaces/${WORKSPACE}/features`,
      id: WORKSPACE,
      as,
      body,
    });

  it('lets the Owner replace the off set, and audits the change as that Owner', async () => {
    const { harness, audit } = seed();
    const ownerPrincipal = await principalOf(harness, WORKSPACE, OWNER);
    const response = await put(harness, asOwner, { disabled: ['evaluations'] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      features: FEATURE_IDS.map((id) => ({
        id,
        installed: true,
        enabled: id !== 'evaluations',
      })),
    });
    const read = await harness.call(GET, {
      method: 'GET',
      path: `/api/workspaces/${WORKSPACE}/features`,
      id: WORKSPACE,
      as: asBuilder,
    });
    expect(read.body).toEqual(response.body);
    expect(audit).toHaveLength(1);
    // The label is the member's display name, as `setPublicSharingPolicy` records it; not the email.
    expect(audit).toEqual([
      {
        workspaceId: WORKSPACE,
        actorPrincipalId: ownerPrincipal,
        actorUserId: OWNER.id,
        actorLabel: OWNER.name,
        action: 'workspace-features-changed',
        subjectId: null,
        subjectLabel: 'Features off: evaluations',
      },
    ]);
  });

  it.each([
    ['an Admin', ADMIN],
    ['a Builder', BUILDER],
    ['a Viewer', VIEWER],
  ])('refuses %s with 403 and writes nothing', async (_name, member) => {
    const { harness, audit, disabled } = seed();
    const response = await put(harness, { email: member.email }, { disabled: ['evaluations'] });
    expect(response.status).toBe(403);
    expect(audit).toEqual([]);
    expect(disabled.get(WORKSPACE)).toEqual([]);
    const read = await harness.call(GET, {
      method: 'GET',
      path: `/api/workspaces/${WORKSPACE}/features`,
      id: WORKSPACE,
      as: asOwner,
    });
    expect(JSON.stringify(read.body)).not.toContain('"enabled":false');
  });

  it('lets the Owner of a workspace other than the session’s switch its features, audited as that workspace’s member', async () => {
    const { harness, audit, disabled } = seed();
    const secondPrincipal = await principalOf(harness, SECOND, CROSS);
    expect(secondPrincipal).not.toBe(await principalOf(harness, WORKSPACE, CROSS));
    const response = await harness.call(PUT, {
      method: 'PUT',
      path: `/api/workspaces/${SECOND}/features`,
      id: SECOND,
      as: { email: CROSS.email },
      body: { disabled: ['files'] },
    });
    expect(response.status).toBe(200);
    expect(disabled.get(SECOND)).toEqual(['files']);
    expect(disabled.get(WORKSPACE)).toEqual([]);
    expect(audit).toEqual([
      {
        workspaceId: SECOND,
        actorPrincipalId: secondPrincipal,
        actorUserId: CROSS.id,
        actorLabel: CROSS.name,
        action: 'workspace-features-changed',
        subjectId: null,
        subjectLabel: 'Features off: files',
      },
    ]);
  });

  it('answers a member of the session workspace who is not a member of the path one with 404 workspace_not_found', async () => {
    const { harness, audit, disabled } = seed();
    for (const method of ['GET', 'PUT'] as const) {
      const response = await harness.call(method === 'GET' ? GET : PUT, {
        method,
        path: `/api/workspaces/${SECOND}/features`,
        id: SECOND,
        as: asOwner,
        ...(method === 'PUT' ? { body: { disabled: ['files'] } } : {}),
      });
      expect(response.status, method).toBe(404);
      expect(response.text, method).toContain('workspace_not_found');
    }
    expect(disabled.get(SECOND)).toEqual([]);
    expect(audit).toEqual([]);
  });

  it('answers a non-member with 404 workspace_not_found', async () => {
    const { harness } = seed();
    const response = await harness.call(PUT, {
      method: 'PUT',
      path: `/api/workspaces/${FOREIGN}/features`,
      id: FOREIGN,
      as: asOwner,
      body: { disabled: [] },
    });
    expect(response.status).toBe(404);
    expect(response.text).toContain('workspace_not_found');
  });

  it('refuses an API key with 403 api_key_not_permitted', async () => {
    const { harness } = seed();
    const key = await harness.directory.forWorkspace(WORKSPACE).createApiKey({
      name: 'features-test',
      role: conferredBy('owner', 'admin', 'features route test'),
      expiresAt: null,
    });
    if (key.kind !== 'created') throw new Error('key setup failed');
    const response = await harness.call(PUT, {
      method: 'PUT',
      path: `/api/workspaces/${WORKSPACE}/features`,
      id: WORKSPACE,
      as: null,
      bearer: key.presented,
      body: { disabled: [] },
    });
    expect(response.status).toBe(403);
    expect(response.text).toContain('api_key_not_permitted');
  });

  it.each([
    ['an unknown feature id', { disabled: ['nope'] }],
    ['a duplicate feature id', { disabled: ['files', 'files'] }],
  ])('answers 400 invalid_body for %s', async (_name, body) => {
    const { harness, audit, disabled } = seed();
    const response = await put(harness, asOwner, body);
    expect(response.status).toBe(400);
    expect(response.text).toContain('invalid_body');
    expect(disabled.get(WORKSPACE)).toEqual([]);
    expect(audit).toEqual([]);
  });

  it('answers 409 feature_in_use when a kept feature needs a switched-off one', async () => {
    const { harness } = seed();
    const response = await put(harness, asOwner, { disabled: ['runs'] });
    expect(response.status).toBe(409);
    expect(response.text).toContain('feature_in_use');
  });

  it('answers 409 feature_not_installed when the body would switch on an uninstalled feature', async () => {
    const { harness } = seed(FEATURE_IDS.filter((id) => id !== 'files'));
    const response = await put(harness, asOwner, { disabled: [] });
    expect(response.status).toBe(409);
    expect(response.text).toContain('feature_not_installed');
  });
});
