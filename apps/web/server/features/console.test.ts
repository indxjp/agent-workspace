import { FEATURE_IDS, type FeatureId } from '@indx-workspace/contracts/features';
import { afterEach, describe, expect, it } from 'vitest';

import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { mintSessionToken, newSessionClaims, verifySessionToken } from '../auth';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { currentWorkspaceFeatures, featureGateFor, resolveIdentity } from './console';
import { clearFeatureSwitches, configureFeatureSwitches } from './runtime';

const SECRET = 'b'.repeat(32);

async function sessionFor(email: string, workspaceSlug: string) {
  const token = await mintSessionToken(newSessionClaims(email, workspaceSlug), SECRET);
  const result = await verifySessionToken(token, SECRET);
  if (!result.ok) throw new Error('unreachable: mint then verify with the same secret');
  return result.claims;
}

function installDirectory(role: 'owner' | 'viewer') {
  const directory = createMemoryDirectory({
    workspaces: [
      { id: 'ws-a', slug: 'acme', name: 'Acme Corp' },
      { id: 'ws-b', slug: 'beta', name: 'Beta Inc' },
    ],
    users: [
      { email: 'aya@example.test', name: 'Aya Ito', workspaceId: 'ws-a', role },
      { email: 'aya@example.test', name: 'Aya Ito', workspaceId: 'ws-b', role: 'owner' },
    ],
  });
  installTestDomains({ rbac: { directory, identify: () => Promise.resolve(null) } });
}

/** Switches that turn files off in `ws-a` only. */
function filesOffInAcme() {
  configureFeatureSwitches({
    enabledFor: (workspaceId): Promise<readonly FeatureId[]> =>
      Promise.resolve(
        workspaceId === 'ws-a' ? FEATURE_IDS.filter((id) => id !== 'files') : FEATURE_IDS,
      ),
  });
}

afterEach(() => {
  clearFeatureSwitches();
  clearApplicationContext();
});

describe('currentWorkspaceFeatures', () => {
  it('answers every feature with no session, even when switches are wired', async () => {
    filesOffInAcme();
    await expect(currentWorkspaceFeatures(null)).resolves.toEqual(FEATURE_IDS);
  });

  it('answers every feature when no RBAC runtime resolves the session', async () => {
    filesOffInAcme();
    const identity = await resolveIdentity(await sessionFor('aya@example.test', 'acme'));
    expect(identity).toBeNull();
    await expect(currentWorkspaceFeatures(identity)).resolves.toEqual(FEATURE_IDS);
  });

  it("answers the session workspace's own set, not another workspace's", async () => {
    installDirectory('owner');
    filesOffInAcme();
    const acme = await resolveIdentity(await sessionFor('aya@example.test', 'acme'));
    const beta = await resolveIdentity(await sessionFor('aya@example.test', 'beta'));
    expect(await currentWorkspaceFeatures(acme)).not.toContain('files');
    expect(await currentWorkspaceFeatures(beta)).toEqual(FEATURE_IDS);
  });
});

describe('featureGateFor', () => {
  it('lets the page render with no session', async () => {
    filesOffInAcme();
    await expect(featureGateFor(null, 'files')).resolves.toEqual({ enabled: true });
  });

  it('lets the page render when the feature is on', async () => {
    installDirectory('owner');
    filesOffInAcme();
    const session = await sessionFor('aya@example.test', 'acme');
    await expect(featureGateFor(session, 'skills')).resolves.toEqual({ enabled: true });
  });

  it('names the workspace and whether the caller is its Owner when the feature is off', async () => {
    installDirectory('owner');
    filesOffInAcme();
    await expect(
      featureGateFor(await sessionFor('aya@example.test', 'acme'), 'files'),
    ).resolves.toEqual({
      enabled: false,
      installed: true,
      isOwner: true,
      workspaceName: 'Acme Corp',
    });
  });

  it('says a Viewer is not the Owner, reading the directory role rather than the token claim', async () => {
    installDirectory('viewer');
    filesOffInAcme();
    const session = await sessionFor('aya@example.test', 'acme');
    expect(session.role).toBe('owner');
    await expect(featureGateFor(session, 'files')).resolves.toEqual({
      enabled: false,
      installed: true,
      isOwner: false,
      workspaceName: 'Acme Corp',
    });
  });

  it('says a feature the deployment does not install is not installed, not switched off', async () => {
    installDirectory('owner');
    const deployment: readonly FeatureId[] = ['chat', 'files', 'runs'];
    configureFeatureSwitches({
      deployment,
      enabledFor: () => Promise.resolve(deployment),
    });
    const session = await sessionFor('aya@example.test', 'acme');
    await expect(featureGateFor(session, 'skills')).resolves.toEqual({
      enabled: false,
      installed: false,
    });
    await expect(featureGateFor(session, 'files')).resolves.toEqual({ enabled: true });
  });
});
