import { describe, expect, it } from 'vitest';

import type { AgentRecord } from '../agents/contract';
import { versionRequest } from './fixtures';
import { createAgentVersion } from './handlers';
import { agent as agentRecord, OWNER } from './pipeline.test-support';
import { promoteAgent, rollbackAgent } from './pointers';
import { ACTOR, everyBundleStored, harness, point } from './pointers.test-support';
import type { WorkspaceAgentVersionStore } from './store';

describe('an archived agent is frozen (issue #1851)', () => {
  const ARCHIVED = agentRecord({
    name: 'frozen',
    ownerPrincipalId: OWNER,
    archivedAt: new Date('2026-10-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  });
  // Any store call, read or write, throws: the refusal has to come before the first one.
  const untouched = new Proxy(
    {},
    {
      get: (_target, method) => {
        throw new Error('the store was called: ' + String(method));
      },
    },
  ) as WorkspaceAgentVersionStore;
  const dependencies = { store: untouched, toolBundles: everyBundleStored };

  const refusals = {
    'set a pointer': () => point(ARCHIVED, 'local', 1, dependencies),
    promote: () => promoteAgent({}, ARCHIVED, ACTOR, dependencies),
    'promote, dry run': () => promoteAgent({ dryRun: true }, ARCHIVED, ACTOR, dependencies),
    rollback: () => rollbackAgent({}, ARCHIVED, ACTOR, dependencies),
    'rollback, dry run': () => rollbackAgent({ dryRun: true }, ARCHIVED, ACTOR, dependencies),
    'save a version': () =>
      createAgentVersion(versionRequest({ name: 'frozen' }), ARCHIVED, OWNER, dependencies),
    'save a version, dry run': () =>
      createAgentVersion(
        versionRequest({ name: 'frozen', dryRun: true }),
        ARCHIVED,
        OWNER,
        dependencies,
      ),
    'save a version from the Builder': () =>
      createAgentVersion(versionRequest({ name: 'frozen' }), ARCHIVED, OWNER, dependencies, 1, {
        via: 'builder',
      }),
  };

  it.each(Object.entries(refusals))(
    'refuses to %s with 409 agent_archived before the store is touched',
    async (_name, attempt) => {
      const result = await attempt();
      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ error: { code: 'agent_archived' } });
    },
  );
});

describe('an archive that commits after the handler read (issue #1987, SEC-07)', () => {
  /** Each door read the agent active, then the agent is archived before `applyAndPoint` runs. */
  const doors = {
    set: (agent: AgentRecord, deps: { store: WorkspaceAgentVersionStore }) =>
      point(agent, 'local', 1, deps),
    promote: (agent: AgentRecord, deps: { store: WorkspaceAgentVersionStore }) =>
      promoteAgent({}, agent, ACTOR, deps),
    rollback: (agent: AgentRecord, deps: { store: WorkspaceAgentVersionStore }) =>
      rollbackAgent({ environment: 'local' }, agent, ACTOR, deps),
  };

  it.each(Object.entries(doors))(
    'refuses %s with 409 agent_archived from the locked write and moves nothing',
    async (_name, door) => {
      const h = await harness();
      const agent = await h.createAgent('Racing');
      await h.save(agent, { instructions: 'Version one.' });
      await h.save(agent, { instructions: 'Version two.' });
      const deps = { store: h.store };
      expect((await point(agent, 'local', 1, deps)).status).toBe(200);
      expect((await point(agent, 'local', 2, deps)).status).toBe(200);
      const pointersBefore = (await h.store.list(agent.id))?.pointers;
      const auditsBefore = h.provider.audits().length;
      const stale = await h.current(agent.id);
      expect(stale.archivedAt).toBeUndefined();

      const archiveOnApply: WorkspaceAgentVersionStore = {
        ...h.store,
        applyAndPoint: (id, input) => {
          h.archive(id);
          return h.store.applyAndPoint(id, input);
        },
      };
      const result = await door(stale, { store: archiveOnApply });

      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ error: { code: 'agent_archived' } });
      expect((await h.store.list(agent.id))?.pointers).toEqual(pointersBefore);
      expect(h.provider.audits()).toHaveLength(auditsBefore);
      expect((await h.current(agent.id)).instructions).toBe('Version two.');
    },
  );
});
