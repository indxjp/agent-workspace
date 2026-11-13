import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRecord } from '../agents/contract';
import { clearEnginesRegisteredForTests } from '../engines/registry';
import { recordingCeilingFor } from '../policy-ceiling/fixtures';
import { FIXTURE_PERMISSIONS, FIXTURE_POLICY, versionRequest } from './fixtures';
import type { SeededReferences } from './memory-store';
import {
  agent,
  expectRefusal,
  refusalOf,
  storeWith,
  validate,
  validateVersionRequest,
  WORKSPACE,
  withBody,
} from './pipeline.test-support';

afterEach(() => {
  clearEnginesRegisteredForTests();
});

describe('validateAgentVersion', () => {
  describe('7. the deployment policy ceiling (issue #535)', () => {
    const CONNECTION = 'a1111111-1111-4111-8111-111111111111';
    const ALL_ON = {
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: true,
    };

    function withAgent(
      request: ReturnType<typeof versionRequest>,
      edits: { readonly permissions?: typeof ALL_ON; readonly model?: string | null },
    ): ReturnType<typeof versionRequest> {
      const { definition } = request.body;
      return withBody(request, {
        definition: { ...definition, agent: { ...definition.agent, ...edits } },
      });
    }

    function judge(
      raw: unknown,
      ceiling: ReturnType<typeof recordingCeilingFor>,
      options: { readonly subject?: AgentRecord; readonly references?: SeededReferences } = {},
    ) {
      return validate(raw, {
        ...options,
        ceiling: ceiling.ceilingFor(new Request('http://localhost/'), WORKSPACE),
      });
    }

    it('runs after the engine switch: a carried withheld runCommands is not refused', async () => {
      const ceiling = recordingCeilingFor({ permissions: { runCommands: false } });
      const switched = withAgent(
        versionRequest({
          policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
        }),
        { permissions: { ...FIXTURE_PERMISSIONS, runCommands: true } },
      );
      const subject = agent({
        policy: { ...FIXTURE_POLICY, tools: { ...FIXTURE_POLICY.tools, deny: ['Bash'] } },
      });
      expect((await judge(switched, ceiling, { subject })).ok).toBe(true);
      // Without the switch's withholding, the same permission is refused.
      const unswitched = withAgent(versionRequest(), {
        permissions: { ...FIXTURE_PERMISSIONS, runCommands: true },
      });
      expect(refusalOf(await judge(unswitched, ceiling)).body).toMatchObject({
        error: { code: 'policy_cannot_widen', details: ['permissions.runCommands'] },
      });
    });

    it('refuses an explicit model outside policy.models', async () => {
      const ceiling = recordingCeilingFor({ models: ['claude-sonnet-4-5'] });
      expectRefusal(
        await judge(withAgent(versionRequest(), { model: 'gpt-5.1' }), ceiling),
        403,
        'policy_cannot_widen',
        ['model:gpt-5.1'],
      );
    });

    it("judges model: null on the default connection as the provider's deployment default, with no discovery", async () => {
      const ceiling = recordingCeilingFor(
        { models: ['claude-sonnet-4-5'] },
        { defaults: { openai: 'gpt-5.1' }, providers: { [CONNECTION]: 'openai' } },
      );
      const refusal = refusalOf(
        await judge(versionRequest(), ceiling, {
          references: { 'model-connection': [{ id: CONNECTION, name: 'default' }] },
        }),
      );
      expect(refusal.body).toMatchObject({
        error: { code: 'policy_cannot_widen', details: ['model:gpt-5.1'] },
      });
      // The only read is the connection row's provider: no provider or discovery call exists.
      expect(ceiling.lookups).toEqual([`provider:${CONNECTION}`]);
    });

    it('saves a null maxBudgetUsd under a budget ceiling', async () => {
      const ceiling = recordingCeilingFor({ limits: { maxBudgetUsd: 1, maxTurns: 5 } });
      expect((await judge(versionRequest(), ceiling)).ok).toBe(true);
    });

    it('judges a compiled policy on the default engine with no limits', async () => {
      const ceiling = recordingCeilingFor({ engines: ['claude-agent-sdk'] });
      const compiled = versionRequest({
        policy: {
          engine: 'pi',
          skills: { mode: 'all' },
          limits: { maxTurns: 99, maxBudgetUsd: 9 },
        },
        policySource: 'compiled',
      });
      expect((await judge(compiled, ceiling)).ok).toBe(true);
      const stored = versionRequest({
        policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
      });
      expect(refusalOf(await judge(stored, ceiling)).body).toMatchObject({
        error: { details: ['engine:pi'] },
      });
    });

    it('names tool details sorted and once each', async () => {
      const ceiling = recordingCeilingFor({ tools: [] });
      const request = versionRequest({ resources: { connectors: ['zeta', 'alpha'] } });
      const refusal = refusalOf(
        await judge(request, ceiling, {
          references: {
            connector: [
              { id: 'c1', name: 'zeta' },
              { id: 'c2', name: 'alpha' },
            ],
          },
        }),
      );
      expect(refusal.body).toMatchObject({ error: { details: ['tool:alpha', 'tool:zeta'] } });
    });

    it('answers the identical result without a ceiling', async () => {
      const request = withAgent(versionRequest(), { permissions: ALL_ON, model: 'gpt-5.1' });
      const store = await storeWith();
      const subject = { kind: 'existing', agent: agent() } as const;
      const without = await validateVersionRequest(request, subject, { store });
      const withNull = await validateVersionRequest(request, subject, { store, ceiling: null });
      expect(withNull).toEqual(without);
      expect(without.ok).toBe(true);
    });
  });

  describe('8. the #133 write ceiling', () => {
    it('accepts a read-write file grant on an agent whose writeFiles is off', async () => {
      const result = await validate(
        versionRequest({ resources: { files: [{ path: 'docs/a.md', access: 'read-write' }] } }),
        { references: { file: [{ id: 'f1', name: 'docs/a.md' }] } },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.references.files).toEqual([{ fileId: 'f1', access: 'read-write' }]);
      }
    });
  });
});
