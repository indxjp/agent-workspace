import { VERTEX_DEFAULT_MODEL } from '@indx-workspace/contracts/models';
import { describe, expect, it, vi } from 'vitest';
import type { SetupInput } from '../setup/runtime';
import {
  complete,
  expectUntouched,
  models,
  setupInput,
  snapshot,
  workspace,
} from './setup-fixture.test-support';

export function registerVertexTests(): void {
  describe('keyless vertex', () => {
    const vertexInput = (): SetupInput =>
      setupInput({ provider: 'vertex', providerApiKey: '', runtime: 'local' });

    it('seeds a connection with no secret and the General agent and wizard agent with the vertex model', async () => {
      vi.stubEnv('AW_VERTEX_PROJECT_ID', 'install-project-1');
      vi.stubEnv('AW_VERTEX_LOCATION', 'eu');
      const result = await complete(vertexInput());
      if (!result.ok) throw new Error(`setup refused: ${result.code}`);
      const store = models.forWorkspace(workspace.id);
      const resource = await store.get(result.modelConnectionId);
      expect(resource).toMatchObject({
        name: 'vertex default',
        provider: 'vertex',
        hasCredential: false,
        ready: true,
        config: { projectId: 'install-project-1', location: 'eu' },
      });
      const state = await snapshot();
      expect(state.orphanedSecrets).toEqual([]);
      expect(state.workspaceDefault).toEqual({
        connectionId: result.modelConnectionId,
        model: VERTEX_DEFAULT_MODEL,
      });
      const wizard = state.agents.find((agent) => agent.id === result.agentId);
      expect(wizard).toMatchObject({ model: VERTEX_DEFAULT_MODEL });
      const general = state.agents.find((agent) => agent.name === 'General');
      expect([null, result.modelConnectionId]).toContain(general?.modelConnectionId);
    });

    it('answers 422 vertex_not_configured, writing nothing, when the install names no project', async () => {
      vi.stubEnv('AW_VERTEX_PROJECT_ID', '');
      const result = await complete(vertexInput());
      expect(result).toMatchObject({
        ok: false,
        status: 422,
        code: 'vertex_not_configured',
        message:
          'Claude on Vertex AI needs a Google Cloud project; add the connection on the Models screen.',
      });
      await expectUntouched();
    });

    it('is idempotent: a second run reuses the connection and keeps the Owner’s later edit', async () => {
      vi.stubEnv('AW_VERTEX_PROJECT_ID', 'install-project-1');
      const first = await complete(vertexInput());
      if (!first.ok) throw new Error(`setup refused: ${first.code}`);
      const store = models.forWorkspace(workspace.id);
      const edited = await store.update(first.modelConnectionId, {
        config: { projectId: 'owner-project-9', location: 'us' },
      });
      expect(edited.kind).toBe('updated');
      const second = await complete(vertexInput());
      if (!second.ok) throw new Error(`the re-run was refused: ${second.code}`);
      expect(second.modelConnectionId).toBe(first.modelConnectionId);
      const listed = await store.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        hasCredential: false,
        config: { projectId: 'owner-project-9', location: 'us' },
      });
      expect((await snapshot()).orphanedSecrets).toEqual([]);
    });
  });
}
