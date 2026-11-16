import { expect, it } from 'vitest';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';
import { POST as CREATE } from '../../app/api/model-connections/route';
import { installModelsApi } from '../composition/services';
import type { Role } from '../rbac/core/roles';
import { Principal } from '../rbac/principal';
import { installTestDomains } from '../application-context-fixtures';

import { API_KEY, request } from './routes.fixture.test-support';
export function registerModelCompositionActorRolesTests() {
  it.each(['viewer', 'builder'] as const satisfies readonly Role[])(
    "carries a %s membership's role into the write gate rather than a hard-coded one",
    async (role) => {
      const principal = Principal.fromApiKey({
        principalId: '99999999-9999-4999-8999-999999999999',
        apiKeyId: '77777777-7777-4777-8777-777777777777',
        label: 'Composition-root probe',
        workspaceId: '88888888-8888-4888-8888-888888888888',
        role,
      });
      const { models } = await installModelsApi(
        () => Promise.resolve({ kind: 'workspace', workspaceId: principal.workspaceId }),
        () => Promise.resolve(principal),
        {} as unknown as DatabaseRoot,
        {} as unknown as SecretsService,
      );
      expect(models.kind).toBe('serving');
      installTestDomains({ models });

      const response = await CREATE(
        request('http://web/api/model-connections', 'POST', {
          name: 'Composition-root probe',
          provider: 'anthropic',
          apiKey: API_KEY,
          config: {},
        }),
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('forbidden');
    },
  );
}
