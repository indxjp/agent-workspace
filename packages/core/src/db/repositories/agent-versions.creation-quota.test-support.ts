import { expect, it } from 'vitest';
import { lockAgentCreations } from './agent-versions-shared.js';
import {
  READ_ONLY,
  type createAgentVersionFixture,
} from './agent-versions.fixture.test-support.js';
import { createDatabaseAgentRepositoryProvider } from './agents.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
export function registerCreationQuotaCases(fixture: ReturnType<typeof createAgentVersionFixture>) {
  it('makes a console create wait for the creation lock, so the quota count cannot miss it', async () => {
    const resolver = createDatabaseWorkspaceScopeResolver(fixture.isolated.db);
    const scope = await resolver.forWorkspaceId(fixture.workspaceA);
    if (scope === null) throw new Error('workspace fixture did not resolve');
    const consoleAgents = createDatabaseAgentRepositoryProvider(fixture.isolated.db).forScope(
      scope,
    );
    const order: string[] = [];
    let pending: Promise<unknown> = Promise.resolve();
    await fixture.isolated.db.transaction(async (tx) => {
      await lockAgentCreations(tx, fixture.workspaceA);
      pending = consoleAgents
        .create({
          name: 'console-waits-for-lock',
          instructions: '',
          modelConnectionId: null,
          model: null,
          permissions: READ_ONLY,
          ownerPrincipalId: fixture.principalA,
        })
        .then(() => order.push('created'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      order.push('lock released');
    });
    await pending;
    expect(order).toEqual(['lock released', 'created']);
  });
}
