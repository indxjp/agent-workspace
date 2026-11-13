import { expect, it } from 'vitest';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import { GET as LIST } from '../../app/api/models/route';
import { installModelsApi } from '../composition/services';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';

import { WORKSPACE_ID, request } from './routes.fixture.test-support';
export function registerModelHttpAvailabilityTests() {
  it('leaves the surface positively unavailable until the encrypted store is configured', async () => {
    clearApplicationContext();
    const response = await LIST(request('http://web/api/models'));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'models_runtime_not_configured' },
    });
  });

  it('answers the same 503 when the models API was built without the encrypted store', async () => {
    const built = await installModelsApi(
      () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_ID }),
      () => Promise.resolve(null),
      {} as unknown as DatabaseRoot,
      null,
    );
    expect(built).toEqual({ models: { kind: 'unavailable' }, modelsApi: null });
    installTestDomains({ models: built.models });
    const response = await LIST(request('http://web/api/models'));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'models_runtime_not_configured' },
    });
  });

  it('the production encrypted service refuses startup without MASTER_ENCRYPTION_KEY', async () => {
    const { createSecretsService } = await import('@agent-workspace/core/secrets');
    await expect(
      createSecretsService({ DATABASE_URL: 'postgres://never-contacted.invalid/db' }),
    ).rejects.toThrow(/MASTER_ENCRYPTION_KEY/);
  });
}
