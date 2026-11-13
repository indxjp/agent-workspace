import { describe, expect, it } from 'vitest';

import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';

import type { AgentRecord } from '../agents/contract';
import { toAgentVersionResource } from './contract';
import { promoteAgent, rollbackAgent, setAgentPointer } from './pointers';
import {
  ACTOR,
  agentWithVersions,
  barOf,
  codeToolEdits,
  DIGEST_A,
  DIGEST_B,
  everyBundleStored,
  harness,
  point,
  toolHostDeps,
  type Harness,
} from './pointers.test-support';

describe('setAgentPointer', () => {
  describe('on a deployment with a tool host (ADR-0118 TS8)', () => {
    const needsHost = (result: { status: number; body: unknown }, environment = 'production') => {
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        error: {
          code: 'code_tool_needs_host',
          details: [`connector:${AW_DEV_TOOLS_CONNECTOR}`, `environment:${environment}`],
        },
      });
    };

    async function codeToolAgent(): Promise<{ h: Harness; agent: AgentRecord }> {
      const h = await harness();
      const agent = await agentWithVersions(h, codeToolEdits(DIGEST_A, 'Version one.'));
      await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
        store: h.store,
        toolBundles: everyBundleStored,
      });
      return { h, agent };
    }

    it('promotes and points production at a bundled code-tool version, and refuses without one', async () => {
      const { h, agent } = await codeToolAgent();
      const withHost = toolHostDeps(h);
      const withoutHost = { store: h.store, toolBundles: everyBundleStored };

      needsHost(await promoteAgent({}, await h.current(agent.id), ACTOR, withoutHost));
      needsHost(
        await promoteAgent({}, await h.current(agent.id), ACTOR, {
          ...withoutHost,
          toolHost: false,
        }),
      );
      needsHost(await point(agent, 'production', 1, withoutHost));
      expect(h.provider.pointerCount()).toBe(1);

      expect(
        (await promoteAgent({ dryRun: true }, await h.current(agent.id), ACTOR, withHost)).status,
      ).toBe(200);
      expect(h.provider.pointerCount()).toBe(1);
      expect((await promoteAgent({}, await h.current(agent.id), ACTOR, withHost)).status).toBe(200);
      expect(h.provider.pointerCount()).toBe(2);
    });

    it('hands a bundled code-tool version to the promotion bar once a host exists', async () => {
      const { h, agent } = await codeToolAgent();
      const bar = { store: h.store, toolBundles: everyBundleStored, ceiling: barOf(0.9) };

      needsHost(await point(agent, 'production', 1, bar));
      // With a host the bar judges the version: unevaluated it is refused for that, not the host.
      const withHost = { ...bar, toolHost: true };
      const judged = await point(agent, 'production', 1, withHost);
      expect(judged.status).toBe(409);
      expect(judged.body).toMatchObject({ error: { code: 'promotion_not_evaluated' } });

      const id = (await h.store.list(agent.id))?.versions.find((row) => row.number === 1)?.id;
      if (id === undefined) throw new Error('version 1 is saved');
      h.provider.recordEvaluation(id, { score: 1, passed: 1, total: 1, failing: [] });
      expect((await point(agent, 'production', 1, withHost)).status).toBe(200);
    });

    it('still refuses a code-tool version with no hostable bundle, by name', async () => {
      const h = await harness();
      const agent = await agentWithVersions(h, {
        resources: { connectors: [AW_DEV_TOOLS_CONNECTOR] },
      });
      await h.save(agent, {
        resources: { connectors: [AW_DEV_TOOLS_CONNECTOR] },
        toolBundles: [{ tool: 'lookup', digest: DIGEST_A }],
      });
      const deps = toolHostDeps(h);

      for (const version of [1, 2]) {
        needsHost(
          await setAgentPointer({ environment: 'production', version }, agent, ACTOR, deps),
        );
      }
      expect(h.provider.pointerCount()).toBe(0);
    });

    it('refuses a pointer move to a domain-declaring tool where the sandbox cannot enforce them, by name (#1018)', async () => {
      const h = await harness();
      const agent = await h.createAgent('Support triage');
      const edits = codeToolEdits(DIGEST_A, 'Version one.');
      await h.save(agent, {
        ...edits,
        toolBundles: [
          {
            tool: 'lookup',
            digest: DIGEST_A,
            description: 'Look a ticket up.',
            inputSchema: {},
            allowedDomains: ['api.example.com'],
          },
        ],
      });
      const deps = toolHostDeps(h);
      const e2b = { ...deps, toolDomainsRefusal: 'cannot enforce restricted yet' };

      for (const environment of ['local', 'production'] as const) {
        const refused = await setAgentPointer({ environment, version: 1 }, agent, ACTOR, e2b);
        expect(refused.status).toBe(422);
        expect(refused.body).toMatchObject({
          error: { code: 'network_policy_unsupported', details: ['tool:lookup'] },
        });
      }
      expect(h.provider.pointerCount()).toBe(0);

      const enforced = { ...deps, toolDomainsRefusal: null };
      expect((await point(agent, 'production', 1, enforced)).status).toBe(200);
    });

    it('rolls production back to the previous version and its bundle digest', async () => {
      const h = await harness();
      const agent = await agentWithVersions(
        h,
        codeToolEdits(DIGEST_A, 'Version one.'),
        codeToolEdits(DIGEST_B, 'Version two.'),
      );
      const deps = toolHostDeps(h);
      for (const version of [1, 2]) {
        const moved = await setAgentPointer(
          { environment: 'production', version },
          agent,
          ACTOR,
          deps,
        );
        expect(moved.status).toBe(200);
      }

      const rolled = await rollbackAgent(
        { environment: 'production' },
        await h.current(agent.id),
        ACTOR,
        deps,
      );

      expect(rolled).toMatchObject({ status: 200, body: { environment: 'production', to: 1 } });
      const pointer = (await h.store.list(agent.id))?.pointers.find(
        (candidate) => candidate.environment === 'production',
      );
      expect(pointer?.number).toBe(1);
      const restored = await h.store.find(agent.id, 1);
      if (restored === null) throw new Error('version 1 is saved');
      expect(toAgentVersionResource(restored).body.toolBundles?.[0]?.digest).toBe(DIGEST_A);
    });

    it('refuses a rollback onto a code-tool version without a tool host', async () => {
      const h = await harness();
      const agent = await agentWithVersions(h, codeToolEdits(DIGEST_A, 'Version one.'), {
        instructions: 'Version two.',
      });
      const withHost = toolHostDeps(h);
      await point(agent, 'production', 1, withHost);
      await point(agent, 'production', 2, withHost);

      const rolled = await rollbackAgent({ environment: 'production' }, agent, ACTOR, {
        store: h.store,
        toolBundles: everyBundleStored,
      });

      needsHost(rolled);
      const pointer = (await h.store.list(agent.id))?.pointers.find(
        (candidate) => candidate.environment === 'production',
      );
      expect(pointer?.number).toBe(2);
    });
  });
});
