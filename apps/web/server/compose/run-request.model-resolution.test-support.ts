import { describe, expect, it } from 'vitest';

import { createInMemoryModelsStoreProvider } from '../models/memory-store';

import { modelResolutionRefusal } from './run-preflight';
import { resolveModelForRun, type ModelResolutionLayers } from './run-request';
import { WORKSPACE, fixedDiscovery } from './run-request.fixture.test-support';
export function registerModelResolutionTests() {
  describe('resolveModelForRun', () => {
    /** Four ready `anthropic` connections, one per layer, each with a distinct discovered model. */
    async function fourLayerFixture() {
      const provider = createInMemoryModelsStoreProvider([WORKSPACE]);
      const store = provider.forWorkspace(WORKSPACE);
      const layerNames = ['run', 'agent', 'project', 'workspace'] as const;
      const ids: Record<(typeof layerNames)[number], string> = {
        run: '',
        agent: '',
        project: '',
        workspace: '',
      };
      for (const layer of layerNames) {
        const created = await store.create({
          name: `${layer} connection`,
          provider: 'anthropic',
          apiKey: `sk-${layer}`,
          config: {},
        });
        if (created.kind !== 'created') throw new Error(`fixture setup failed: ${created.kind}`);
        ids[layer] = created.connection.id;
      }
      const layers: ModelResolutionLayers = {
        run: { connectionId: ids.run, model: 'run-model' },
        agent: { connectionId: ids.agent, model: 'agent-model' },
        project: { connectionId: ids.project, model: 'project-model' },
        workspace: { connectionId: ids.workspace, model: 'workspace-model' },
        deployment: null,
      };
      const discover = fixedDiscovery({
        [ids.run]: ['run-model'],
        [ids.agent]: ['agent-model'],
        [ids.project]: ['project-model'],
        [ids.workspace]: ['workspace-model'],
      });
      return { store, ids, layers, discover };
    }

    it('resolves the run override first when every layer is fully configured', async () => {
      const { store, ids, layers, discover } = await fourLayerFixture();
      await expect(resolveModelForRun(layers, store, discover)).resolves.toMatchObject({
        ok: true,
        layer: 'run',
        connectionId: ids.run,
        model: 'run-model',
        provider: 'anthropic',
        validated: true,
      });
    });

    it('walks down to the agent once the run layer is empty', async () => {
      const { store, ids, layers, discover } = await fourLayerFixture();
      await expect(
        resolveModelForRun({ ...layers, run: null }, store, discover),
      ).resolves.toMatchObject({ ok: true, layer: 'agent', connectionId: ids.agent });
    });

    it('walks down to the project once the run and agent layers are empty', async () => {
      const { store, ids, layers, discover } = await fourLayerFixture();
      await expect(
        resolveModelForRun({ ...layers, run: null, agent: null }, store, discover),
      ).resolves.toMatchObject({ ok: true, layer: 'project', connectionId: ids.project });
    });

    it('walks down to the workspace once only it is configured', async () => {
      const { store, ids, layers, discover } = await fourLayerFixture();
      await expect(
        resolveModelForRun({ ...layers, run: null, agent: null, project: null }, store, discover),
      ).resolves.toMatchObject({ ok: true, layer: 'workspace', connectionId: ids.workspace });
    });

    it('refuses, naming the workspace layer, when every layer is empty', async () => {
      const { store, discover } = await fourLayerFixture();
      const resolution = await resolveModelForRun(
        { run: null, agent: null, project: null, workspace: null, deployment: null },
        store,
        discover,
      );
      expect(resolution.ok).toBe(false);
      if (resolution.ok) throw new Error('unreachable');
      expect(resolution.layer).toBe('workspace');
      expect(resolution.code).toBe('model_connection_unresolved');
      expect(resolution.reason).toContain('workspace default');
    });

    it('refuses at the run layer, WITHOUT falling through to the agent, when the run connection is not ready', async () => {
      const provider = createInMemoryModelsStoreProvider([WORKSPACE]);
      const store = provider.forWorkspace(WORKSPACE);
      // `openai-compatible` requires `config.baseUrl`; omitting it makes `ready` false even with a
      // credential — the same "missing required config" half of #126's derived readiness.
      const notReady = await store.create({
        name: 'Not ready',
        provider: 'openai-compatible',
        apiKey: 'sk-not-ready',
        config: {},
      });
      const ready = await store.create({
        name: 'Ready agent connection',
        provider: 'anthropic',
        apiKey: 'sk-agent',
        config: {},
      });
      if (notReady.kind !== 'created' || ready.kind !== 'created') {
        throw new Error('fixture setup failed');
      }
      const discover = fixedDiscovery({ [ready.connection.id]: ['agent-model'] });
      const resolution = await resolveModelForRun(
        {
          run: { connectionId: notReady.connection.id, model: 'whatever' },
          agent: { connectionId: ready.connection.id, model: 'agent-model' },
          project: null,
          workspace: null,
          deployment: null,
        },
        store,
        discover,
      );
      expect(resolution.ok).toBe(false);
      if (resolution.ok) throw new Error('unreachable');
      expect(resolution.layer).toBe('run');
      expect(resolution.code).toBe('model_connection_unresolved');
      expect(resolution.reason).toMatch(/not ready/);
    });

    it('refuses, naming the layer, when the selected connection no longer exists', async () => {
      const { store, layers, discover } = await fourLayerFixture();
      const resolution = await resolveModelForRun(
        { ...layers, run: { connectionId: crypto.randomUUID(), model: 'ghost-model' } },
        store,
        discover,
      );
      expect(resolution.ok).toBe(false);
      if (resolution.ok) throw new Error('unreachable');
      expect(resolution.layer).toBe('run');
      expect(resolution.reason).toContain('no longer exists');
    });

    it('refuses, naming the layer, when the model is not among what discovery currently returns', async () => {
      const { store, ids, layers, discover } = await fourLayerFixture();
      const resolution = await resolveModelForRun(
        { ...layers, run: { connectionId: ids.run, model: 'a-deprecated-model' } },
        store,
        discover,
      );
      expect(resolution.ok).toBe(false);
      if (resolution.ok) throw new Error('unreachable');
      expect(resolution.layer).toBe('run');
      expect(resolution.code).toBe('model_unavailable');
      expect(resolution.reason).toContain('is not available');
    });

    // Issue #393: a model list that cannot be read is not evidence the model is gone. The explicit
    // selection proceeds, unvalidated, with a warning; the old behaviour refused every run whenever
    // the catalogue call failed, and the composer showed that as if the key were broken.
    it('proceeds with the explicit selection, and warns, when the model list cannot be read', async () => {
      const { store, ids, layers } = await fourLayerFixture();
      const warnings: string[] = [];
      const rateLimited = () =>
        Promise.resolve({
          ok: false as const,
          reason: 'Model list unavailable (provider returned HTTP 429).',
          failure: { kind: 'provider-error' as const, status: 429 },
        });
      const resolution = await resolveModelForRun(layers, store, rateLimited, (message) =>
        warnings.push(message),
      );
      expect(resolution).toMatchObject({
        ok: true,
        layer: 'run',
        connectionId: ids.run,
        validated: false,
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('provider-error');
    });

    // PR #403 review: a discovery call that times out reads as `unreachable`, and the run proceeds.
    it('proceeds, unvalidated, when the model list call timed out (unreachable)', async () => {
      const { store, ids, layers } = await fourLayerFixture();
      const timedOut = () =>
        Promise.resolve({
          ok: false as const,
          reason: 'Model list unavailable (the provider could not be reached).',
          failure: { kind: 'unreachable' as const },
        });
      await expect(
        resolveModelForRun(layers, store, timedOut, () => undefined),
      ).resolves.toMatchObject({ ok: true, connectionId: ids.run, validated: false });
    });

    it('refuses with model_credential_rejected when the provider rejects the key', async () => {
      const { store, layers } = await fourLayerFixture();
      const rejected = () =>
        Promise.resolve({
          ok: false as const,
          reason: 'The provider rejected the API key (HTTP 401).',
          failure: { kind: 'credential-rejected' as const, status: 401 },
        });
      const resolution = await resolveModelForRun(layers, store, rejected);
      expect(resolution.ok).toBe(false);
      if (resolution.ok) throw new Error('unreachable');
      expect(resolution.layer).toBe('run');
      expect(resolution.code).toBe('model_credential_rejected');
      expect(resolution.reason).toContain('HTTP 401');
    });

    // Issue #661: a refused connection or a failed lookup would fail the run the same way, after
    // minutes of retries, so it is refused before the run is queued.
    it('refuses with model_connection_failed when the provider cannot be connected to', async () => {
      const { store, layers } = await fourLayerFixture();
      const warnings: string[] = [];
      const refused = () =>
        Promise.resolve({
          ok: false as const,
          reason:
            "The provider could not be connected to (connection refused or DNS lookup failed). Check the connection's base URL and this host's network.",
          failure: { kind: 'connection-failed' as const },
        });
      const resolution = await resolveModelForRun(layers, store, refused, (message) =>
        warnings.push(message),
      );
      expect(resolution).toMatchObject({
        ok: false,
        layer: 'run',
        code: 'model_connection_failed',
      });
      if (resolution.ok) throw new Error('unreachable');
      expect(resolution.reason).toContain('could not be connected to');
      expect(modelResolutionRefusal(resolution).message).not.toContain('Choose a model');
      expect(warnings).toHaveLength(0);
    });
  });
}
