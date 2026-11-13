import { afterEach, describe, expect, it } from 'vitest';

import { clearEnginesRegisteredForTests } from '../engines/registry';
import { versionRequest } from './fixtures';
import type { SeededReferences } from './memory-store';
import { expectRefusal, refusalOf, validate } from './pipeline.test-support';

afterEach(() => {
  clearEnginesRegisteredForTests();
});

describe('validateAgentVersion', () => {
  describe('4. resolution', () => {
    it('answers 422 agent_definition_references_missing naming each kind:name', async () => {
      expectRefusal(
        await validate(
          versionRequest({
            resources: { skills: ['triage'], files: [{ path: 'docs/a.md', access: 'read' }] },
            runtimeProfileName: 'gpu',
          }),
        ),
        422,
        'agent_definition_references_missing',
        ['skill:triage', 'file:docs/a.md', 'runtime-profile:gpu'],
      );
    });

    it('reports missing before ambiguous', async () => {
      const refusal = refusalOf(
        await validate(versionRequest({ resources: { skills: ['triage'], connectors: ['crm'] } }), {
          references: {
            connector: [
              { id: 'c1', name: 'crm' },
              { id: 'c2', name: 'crm' },
            ],
          },
        }),
      );
      expect(refusal.body).toMatchObject({
        error: { code: 'agent_definition_references_missing', details: ['skill:triage'] },
      });
    });

    it('answers 409 agent_definition_reference_ambiguous when nothing is missing', async () => {
      expectRefusal(
        await validate(versionRequest({ resources: { connectors: ['crm'] } }), {
          references: {
            connector: [
              { id: 'c1', name: 'crm' },
              { id: 'c2', name: 'crm' },
            ],
          },
        }),
        409,
        'agent_definition_reference_ambiguous',
        ['connector:crm'],
      );
    });

    it("never reports a null or 'default' model connection missing (C7)", async () => {
      expect((await validate(versionRequest({ modelConnectionName: 'default' }))).ok).toBe(true);
      expect((await validate(versionRequest({ modelConnectionName: null }))).ok).toBe(true);
      const named = refusalOf(await validate(versionRequest({ modelConnectionName: 'prod' })));
      expect(named.body).toMatchObject({ error: { details: ['model-connection:prod'] } });
    });
    describe("the workspace's default runtime profile (S1-22, #504)", () => {
      const PROFILES: SeededReferences = {
        'runtime-profile': [
          { id: 'rp-local', name: 'local' },
          { id: 'rp-gpu', name: 'gpu' },
        ],
      };

      it('resolves a null runtimeProfileName to the default profile id', async () => {
        const result = await validate(versionRequest({ runtimeProfileName: null }), {
          references: PROFILES,
          defaultRuntimeProfileId: 'rp-local',
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.references.runtimeProfileId).toBe('rp-local');
      });

      it('resolves a null runtimeProfileName to null, never missing, when there is no default', async () => {
        const result = await validate(versionRequest({ runtimeProfileName: null }), {
          references: PROFILES,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.references.runtimeProfileId).toBeNull();
      });

      it('lets a named profile win over the default', async () => {
        const result = await validate(versionRequest({ runtimeProfileName: 'gpu' }), {
          references: PROFILES,
          defaultRuntimeProfileId: 'rp-local',
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.references.runtimeProfileId).toBe('rp-gpu');
      });

      it('still refuses a named profile that does not exist, even with a default', async () => {
        const refusal = refusalOf(
          await validate(versionRequest({ runtimeProfileName: 'tpu' }), {
            references: PROFILES,
            defaultRuntimeProfileId: 'rp-local',
          }),
        );
        expect(refusal.body).toMatchObject({
          error: {
            code: 'agent_definition_references_missing',
            details: ['runtime-profile:tpu'],
          },
        });
      });
    });
  });
});
