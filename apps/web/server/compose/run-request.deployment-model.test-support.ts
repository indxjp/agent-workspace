import { describe, expect, it } from 'vitest';

import type { DeploymentDefaultModels } from '../models/deployment-default';
import { createInMemoryModelsStoreProvider } from '../models/store';

import {
  NO_DEFAULT_CONNECTION_REASON,
  resolveModelForRun,
  type ModelResolutionLayers,
  type ModelSelection,
} from './run-request';
import { WORKSPACE, fixedDiscovery } from './run-request.fixture.test-support';
export function registerDeploymentModelTests() {
  describe('resolveModelForRun — the deployment default layer (issue #506)', () => {
    const SONNET = 'claude-sonnet-4-5';

    /** The 'default' anthropic connection `aw dev` creates, and an agent naming it with no model. */
    async function connectionOnlyFixture() {
      const provider = createInMemoryModelsStoreProvider([WORKSPACE]);
      const store = provider.forWorkspace(WORKSPACE);
      const created = await store.create({
        name: 'default',
        provider: 'anthropic',
        apiKey: 'sk-default',
        config: {},
      });
      if (created.kind !== 'created') throw new Error(`fixture setup failed: ${created.kind}`);
      const connectionId = created.connection.id;
      const layersWith = (
        defaults: DeploymentDefaultModels,
        workspace: ModelSelection | null = null,
      ): ModelResolutionLayers => ({
        run: null,
        agent: null,
        project: null,
        workspace,
        deployment: { connectionId, defaults },
      });
      return { store, connectionId, layersWith };
    }

    it('resolves the agent connection plus the deployment default for its provider', async () => {
      const { store, connectionId, layersWith } = await connectionOnlyFixture();
      const discover = fixedDiscovery({ [connectionId]: [SONNET] });
      await expect(
        resolveModelForRun(layersWith({ anthropic: SONNET }), store, discover),
      ).resolves.toEqual({
        ok: true,
        layer: 'deployment',
        connectionId,
        model: SONNET,
        provider: 'anthropic',
        validated: true,
        connectionName: 'default',
      });
    });

    it('refuses at the deployment layer, before any provider call, when no default is configured for the provider', async () => {
      const { store, layersWith } = await connectionOnlyFixture();
      let discoveryCalls = 0;
      const discover = () => {
        discoveryCalls += 1;
        return Promise.resolve({ ok: true as const, stale: false, models: [] });
      };
      const resolution = await resolveModelForRun(
        layersWith({ openai: 'gpt-5.1' }),
        store,
        discover,
      );
      expect(resolution).toEqual({
        ok: false,
        layer: 'deployment',
        code: 'model_connection_unresolved',
        reason:
          'the agent\'s model connection "default" names no model, no project or workspace default ' +
          'model is configured, and this deployment sets no default model for provider "anthropic".',
      });
      expect(discoveryCalls).toBe(0);
      await expect(resolveModelForRun(layersWith({}), store, discover)).resolves.toMatchObject({
        ok: false,
        layer: 'deployment',
        code: 'model_connection_unresolved',
      });
    });

    it('lets a workspace default win over the deployment default', async () => {
      const { store, connectionId, layersWith } = await connectionOnlyFixture();
      const discover = fixedDiscovery({ [connectionId]: [SONNET, 'workspace-model'] });
      await expect(
        resolveModelForRun(
          layersWith({ anthropic: SONNET }, { connectionId, model: 'workspace-model' }),
          store,
          discover,
        ),
      ).resolves.toMatchObject({ ok: true, layer: 'workspace', model: 'workspace-model' });
    });

    it('proceeds unvalidated with the configured id, and warns, when the model list cannot be read', async () => {
      const { store, connectionId, layersWith } = await connectionOnlyFixture();
      const warnings: string[] = [];
      const unreachable = () =>
        Promise.resolve({
          ok: false as const,
          reason: 'Model list unavailable (the provider could not be reached).',
          failure: { kind: 'unreachable' as const },
        });
      const resolution = await resolveModelForRun(
        layersWith({ anthropic: SONNET }),
        store,
        unreachable,
        (message) => warnings.push(message),
      );
      expect(resolution).toMatchObject({
        ok: true,
        layer: 'deployment',
        connectionId,
        model: SONNET,
        validated: false,
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('deployment');
    });

    it('picks the newest dated release when discovery lists only dated ids', async () => {
      const { store, connectionId, layersWith } = await connectionOnlyFixture();
      const discover = fixedDiscovery({
        [connectionId]: [`${SONNET}-20250101`, `${SONNET}-20250929`, 'claude-opus-4-1-20250805'],
      });
      await expect(
        resolveModelForRun(layersWith({ anthropic: SONNET }), store, discover),
      ).resolves.toMatchObject({ ok: true, layer: 'deployment', model: `${SONNET}-20250929` });
    });

    it('refuses with model_unavailable at the deployment layer when the configured id is not offered', async () => {
      const { store, connectionId, layersWith } = await connectionOnlyFixture();
      const discover = fixedDiscovery({ [connectionId]: ['claude-opus-4-1'] });
      const resolution = await resolveModelForRun(
        layersWith({ anthropic: SONNET }),
        store,
        discover,
      );
      expect(resolution).toMatchObject({
        ok: false,
        layer: 'deployment',
        code: 'model_unavailable',
      });
      if (resolution.ok) throw new Error('unreachable');
      // The review of #506: the connection is the agent's; the deployment supplies only the id.
      expect(resolution.reason).toMatch(
        new RegExp(
          `^the deployment default model "${SONNET}" is not available at the agent's model connection "`,
          'u',
        ),
      );
    });

    it('refuses with model_credential_rejected when the provider rejects the key', async () => {
      const { store, layersWith } = await connectionOnlyFixture();
      const rejected = () =>
        Promise.resolve({
          ok: false as const,
          reason: 'The provider rejected the API key (HTTP 401).',
          failure: { kind: 'credential-rejected' as const, status: 401 },
        });
      await expect(
        resolveModelForRun(layersWith({ anthropic: SONNET }), store, rejected),
      ).resolves.toMatchObject({
        ok: false,
        layer: 'deployment',
        code: 'model_credential_rejected',
      });
    });

    it('runs the same connection checks as every layer: a deleted connection is refused at deployment', async () => {
      const { store } = await connectionOnlyFixture();
      const discover = fixedDiscovery({});
      const resolution = await resolveModelForRun(
        {
          run: null,
          agent: null,
          project: null,
          workspace: null,
          deployment: { connectionId: crypto.randomUUID(), defaults: { anthropic: SONNET } },
        },
        store,
        discover,
      );
      expect(resolution).toMatchObject({
        ok: false,
        layer: 'deployment',
        code: 'model_connection_unresolved',
      });
      if (resolution.ok) throw new Error('unreachable');
      expect(resolution.reason).toMatch(/^the agent's model connection \S+ no longer exists/u);
    });

    it('keeps the workspace refusal for an agent with no connection at all', async () => {
      const { store } = await connectionOnlyFixture();
      await expect(
        resolveModelForRun(
          { run: null, agent: null, project: null, workspace: null, deployment: null },
          store,
          fixedDiscovery({}),
        ),
      ).resolves.toMatchObject({
        ok: false,
        layer: 'workspace',
        code: 'model_connection_unresolved',
        reason:
          'no model connection resolves for this run: the agent names none and no workspace default is configured.',
      });
    });

    it('refuses at the deployment layer, naming the missing default connection, when it has no connection', async () => {
      const { store } = await connectionOnlyFixture();
      await expect(
        resolveModelForRun(
          {
            run: null,
            agent: null,
            project: null,
            workspace: null,
            deployment: { connectionId: null, defaults: { anthropic: SONNET } },
          },
          store,
          fixedDiscovery({}),
        ),
      ).resolves.toEqual({
        ok: false,
        layer: 'deployment',
        code: 'model_connection_unresolved',
        reason: NO_DEFAULT_CONNECTION_REASON,
      });
      expect(NO_DEFAULT_CONNECTION_REASON).toContain('no connection named "default"');
    });
  });
}
