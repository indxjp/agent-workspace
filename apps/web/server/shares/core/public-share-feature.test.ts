/**
 * An anonymous `/p/<token>` link conceals (ADR-0160 D7) when its workspace has sharing off: it
 * answers the not-found an unknown link answers, never `feature_disabled`.
 */
import { FEATURE_IDS } from '@indx-workspace/contracts/features';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearApplicationContext } from '../../application-context';
import { installTestDomains } from '../../application-context-fixtures';
import { clearFeatureSwitches, configureFeatureSwitches } from '../../features/runtime';
import { resolvePublicShare, withPublicShare } from './http';
import type { SharesRuntime, WorkspaceSharing } from './runtime';

const WORKSPACE = '00000000-0000-4000-8000-000000000002';
const TOKEN = 'a-public-link-token';

const sharing = {} as WorkspaceSharing;
const resolvePublic = vi.fn(() => Promise.resolve({ workspaceId: WORKSPACE, sharing }));

const runtime: SharesRuntime = {
  resolveActor: () => Promise.reject(new Error('not used')),
  forWorkspace: () => Promise.reject(new Error('not used')),
  resolvePublic,
  sharingMaterials: () => Promise.reject(new Error('not used')),
  sessionRuns: () => Promise.reject(new Error('not used')),
  subjectOwnership: () => Promise.reject(new Error('not used')),
  runPublic: () => Promise.reject(new Error('not used')),
};

function install(): void {
  installTestDomains({ shares: runtime });
}

function switchSharing(on: boolean): void {
  configureFeatureSwitches({
    enabledFor: () =>
      Promise.resolve(on ? FEATURE_IDS : FEATURE_IDS.filter((id) => id !== 'sharing')),
  });
}

describe('a public share link and a workspace with sharing switched off', () => {
  afterEach(() => {
    clearFeatureSwitches();
    clearApplicationContext();
    resolvePublic.mockClear();
  });

  it('resolves while sharing is on', async () => {
    install();
    switchSharing(true);
    expect(await resolvePublicShare(runtime, TOKEN)).toEqual({ workspaceId: WORKSPACE, sharing });
  });

  it('resolves to nothing, as an unknown link does, once sharing is off', async () => {
    switchSharing(false);
    expect(await resolvePublicShare(runtime, TOKEN)).toBeNull();
  });

  it('answers the unknown-link 404 from the public routes, never feature_disabled', async () => {
    install();
    switchSharing(false);
    const fn = vi.fn(() => new Response('served'));
    const response = await withPublicShare(TOKEN, fn);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain('share_not_found');
    expect(text).not.toContain('feature_disabled');
    expect(fn).not.toHaveBeenCalled();
  });

  it('serves the route while sharing is on', async () => {
    install();
    switchSharing(true);
    const response = await withPublicShare(TOKEN, () => new Response('served'));
    expect(await response.text()).toBe('served');
  });
});
