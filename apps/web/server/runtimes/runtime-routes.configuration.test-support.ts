import type { DatabaseRoot } from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';
import { GET as listConnectionsRoute } from '../../app/api/runtime-connections/route';
import { GET as listProfilesRoute } from '../../app/api/runtime-profiles/route';
import { installTestDomains } from '../application-context-fixtures';
import { installRuntimesApi } from '../composition/services';
import { installWorkspaceHeaderRbac } from '../rbac/testing';
import { request, WORKSPACE_A, WORKSPACE_HEADER } from './runtime-routes.test-support';

describe('/api/runtime-profiles — unconfigured', () => {
  it('answers 503 by name, never 401 and never an empty 200', async () => {
    // The role gate lives in the same context, so with none installed it answers first; the
    // runtimes runtime's own answer is the `unavailable` case below.
    const response = await listProfilesRoute(
      request('GET', '/api/runtime-profiles', { workspace: WORKSPACE_A }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rbac_runtime_not_configured');
  });

  it('answers the same 503 on both APIs while the runtimes are unavailable (no secrets service)', async () => {
    installWorkspaceHeaderRbac(WORKSPACE_HEADER);
    const built = await installRuntimesApi(
      () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_A }),
      () => Promise.resolve(null),
      {} as unknown as DatabaseRoot,
      null,
    );
    expect(built).toEqual({ runtimes: { kind: 'unavailable' }, runtimeSwitchAudit: null });
    installTestDomains({ runtimes: built.runtimes });
    for (const response of [
      await listProfilesRoute(request('GET', '/api/runtime-profiles', { workspace: WORKSPACE_A })),
      await listConnectionsRoute(
        request('GET', '/api/runtime-connections', { workspace: WORKSPACE_A }),
      ),
    ]) {
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('runtimes_runtime_not_configured');
    }
  });
});
