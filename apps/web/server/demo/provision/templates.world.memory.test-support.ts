/** The templates world over memory: in-memory stores, a memory directory and a counter for ids. */
import crypto from 'node:crypto';

import { createInMemoryCatalog } from '@agent-workspace/core/db/unscoped';
import type { AgentResourceAssignments } from '@indx-workspace/contracts/agents';

import { createInMemoryAgentStoreProvider } from '../../agents/memory-store';
import type { AgentGrantStoreProvider } from '../../agents/agent-grants-store';
import type { AgentResourceStoreProvider } from '../../agents/resource-store';
import type { AgentStoreProvider } from '../../agents/store';
import { createInMemoryConnectorsStoreProvider } from '../../connectors/memory-store';
import { createInMemoryModelsStoreProvider } from '../../models/store';
import type { ModelsStoreProvider } from '../../models/store';
import { createInMemoryRuntimeProfileStoreProvider } from '../../runtimes/memory-store';
import { counterIds } from '../../ids';
import { conferRole } from '../../rbac/core/conferral';
import { createMemoryDirectory } from '../../rbac/memory-directory';
import type { DemoSandbox } from './ports';
import type { DemoTemplatesWorld } from './templates.contract';
import { buildWorld } from './templates.world.build.test-support';
import { TEST_DEMO_SANDBOX } from './templates.world.parts.test-support';

/** A grant store over a map, the in-memory twin of `agent_grants`. */
function memoryGrants(agents: AgentStoreProvider): AgentGrantStoreProvider {
  const byAgent = new Map<string, readonly string[]>();
  return {
    forWorkspace: (workspaceId) => ({
      hasGrant: () => Promise.resolve(false),
      listPrincipalIds: async (agentId) =>
        (await agents.forWorkspace(workspaceId).get(agentId)) === null
          ? null
          : (byAgent.get(`${workspaceId}:${agentId}`) ?? []),
      replacePrincipalIds: async (agentId, principalIds) => {
        if ((await agents.forWorkspace(workspaceId).get(agentId)) === null) {
          return { kind: 'agent-not-found' as const };
        }
        byAgent.set(`${workspaceId}:${agentId}`, principalIds);
        return { kind: 'updated' as const, principalIds };
      },
    }),
  };
}

/** The assignments a world keeps in memory, read through the agents that hold them. */
function memoryResources(
  agents: AgentStoreProvider,
  assignments: ReadonlyMap<string, AgentResourceAssignments>,
): AgentResourceStoreProvider {
  return {
    forWorkspace: (workspaceId) => ({
      get: async (agentId) =>
        (await agents.forWorkspace(workspaceId).get(agentId)) === null
          ? null
          : (assignments.get(`${workspaceId}:${agentId}`) ?? null),
      replace: () => Promise.reject(new Error('the world never replaces assignments')),
    }),
  };
}

/**
 * A models provider that serves any workspace: the in-memory one knows only the workspaces it is
 * given up front, and a test makes its demo workspaces as it goes.
 */
function lazyMemoryModels(): ModelsStoreProvider {
  const byWorkspace = new Map<string, ModelsStoreProvider>();
  return {
    forWorkspace: (workspaceId) => {
      let provider = byWorkspace.get(workspaceId);
      if (provider === undefined) {
        provider = createInMemoryModelsStoreProvider([workspaceId]);
        byWorkspace.set(workspaceId, provider);
      }
      return provider.forWorkspace(workspaceId);
    },
  };
}

export function createMemoryTemplatesWorld(sandbox: Partial<DemoSandbox> = {}): DemoTemplatesWorld {
  const ids = counterIds();
  const slugs = new Map<string, string>();
  const assignments = new Map<string, AgentResourceAssignments>();
  const agents = createInMemoryAgentStoreProvider({ assignments });
  const catalog = createInMemoryCatalog();
  const directory = createMemoryDirectory({ newId: () => ids.newId() });
  return buildWorld(
    {
      directory,
      agents,
      resources: memoryResources(agents, assignments),
      grants: memoryGrants(agents),
      connectors: createInMemoryConnectorsStoreProvider(),
      models: lazyMemoryModels(),
      runtimeProfiles: createInMemoryRuntimeProfileStoreProvider(),
      catalogs: (workspaceId) => Promise.resolve(catalog.forWorkspace(workspaceId)),
      skillCatalogs: (workspaceId) => Promise.resolve(catalog.forWorkspace(workspaceId)),
      async makeWorkspace(slug, ownerEmail) {
        const id = crypto.randomUUID();
        slugs.set(slug, id);
        const conferral = conferRole('owner', 'owner');
        if (conferral.effect !== 'allow') throw new Error('the template owner role was refused');
        const made = await directory.forWorkspace(id).createUser({
          email: ownerEmail,
          name: 'Template owner',
          role: conferral.role,
        });
        if (made.kind !== 'created') throw new Error(`seeding the owner of ${slug}: ${made.kind}`);
        return { id, principalId: made.membership.principalId, userId: made.user.id };
      },
      workspaceIdForSlug: (slug) => Promise.resolve(slugs.get(slug) ?? null),
    },
    { ...TEST_DEMO_SANDBOX, ...sandbox },
  );
}
