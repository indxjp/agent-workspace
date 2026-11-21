/**
 * Builds a {@link DemoTemplatesWorld} from {@link WorldParts}: the services over the stores, and the
 * readers and seeders a contract test uses.
 */
import crypto from 'node:crypto';

import { demoTemplateWorkspaceSlug } from '@indx-workspace/contracts/demo';

import { compiledPolicyFor } from '../../agents/core/policy';
import { createGuestWorkspaceBinder } from '../../email-link/adapters/guest-workspace/production';
import { randomIds } from '../../ids';
import { createStorageService } from '../../storage/service';
import { createInMemoryObjectStore } from '../../storage/testing';
import { createWorkspaceSkills } from '../../skills/workspace-skills';
import type { DemoSandbox } from './ports';
import type { DemoTemplatesWorld } from './templates.contract';
import { createDemoTemplateOperations } from './seed';
import { createDemoTemplates } from './template-copy';
import type { WorldParts } from './templates.world.parts.test-support';
import { seedTemplateWorkspace } from './templates.world.seed-template.test-support';

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

/** How many catalog rows a world reads at once. */
const READ_ROWS_LIMIT = 1000;

/** The skills service a world uses: its objects held per workspace, its rows in the catalog. */
function buildSkills(parts: WorldParts, storage: Storage) {
  // A skill stored before the catalog held rows lives here; these worlds write rows only.
  const skillObjects = new Map<string, ReturnType<typeof createInMemoryObjectStore>>();
  return createWorkspaceSkills({
    objects: (workspaceId) => {
      const held = skillObjects.get(workspaceId) ?? createInMemoryObjectStore();
      skillObjects.set(workspaceId, held);
      return held;
    },
    catalog: parts.skillCatalogs,
    storage,
  });
}

type Storage = ReturnType<typeof createStorageService>;
type Skills = ReturnType<typeof buildSkills>;
type Binder = ReturnType<typeof createGuestWorkspaceBinder>;
type World = DemoTemplatesWorld;

/** How a world makes the people and workspaces a test acts as, and lifts an agent's limits. */
function worldPeople(
  parts: WorldParts,
  binder: Binder,
): Pick<World, 'newGuest' | 'newWorkspace' | 'uncap'> {
  return {
    async newGuest() {
      const email = `guest-${crypto.randomUUID()}@example.test`;
      const binding = await binder.bind({ email, now: new Date() });
      if (binding === null) throw new Error('no guest binding');
      const held = await parts.directory.membershipsForUser(binding.userId);
      const principalId = held.find((m) => m.workspaceId === binding.workspaceId)?.principalId;
      if (principalId === undefined) throw new Error('the guest has no principal');
      return { workspaceId: binding.workspaceId, userId: binding.userId, principalId };
    },

    async newWorkspace() {
      const id = crypto.randomUUID();
      const made = await parts.makeWorkspace(`verification-${id}`, `owner-${id}@example.test`);
      if (made.userId === null) throw new Error('the workspace owner has no user');
      return { workspaceId: made.id, userId: made.userId, principalId: made.principalId };
    },

    async uncap(workspaceId, agentId) {
      const store = parts.agents.forWorkspace(workspaceId);
      const agent = await store.get(agentId);
      if (agent === null) throw new Error('uncap: no such agent');
      await store.replacePolicy(agentId, {
        ...(agent.policy ?? compiledPolicyFor(agent.permissions, [])),
        limits: { maxTurns: null, maxBudgetUsd: null },
      });
    },
  };
}

/** The readers a contract test inspects a world with. */
function worldReaders(
  parts: WorldParts,
  storage: Storage,
  skills: Skills,
): Omit<
  World,
  | keyof ReturnType<typeof worldPeople>
  | 'templates'
  | 'operations'
  | 'templateId'
  | 'directory'
  | 'entry'
  | 'seedTemplate'
> {
  const readRows = async (workspaceId: string) => {
    const catalog = await parts.catalogs(workspaceId);
    return (await catalog.list('', { limit: READ_ROWS_LIMIT })).rows;
  };

  return {
    agents: (workspaceId) => parts.agents.forWorkspace(workspaceId).list(),
    assignments: (workspaceId, agentId) => parts.resources.forWorkspace(workspaceId).get(agentId),

    async fileText(workspaceId, path) {
      const row = await (await parts.catalogs(workspaceId)).get(path);
      if (row === null || row.kind !== 'file') return null;
      const opened = await storage.open({ workspaceId }, row);
      return opened === null ? null : await new Response(opened.body).text();
    },
    paths: async (workspaceId) => (await readRows(workspaceId)).map((row) => row.path),
    async pathOf(workspaceId, fileId) {
      return (await readRows(workspaceId)).find((row) => row.id === fileId)?.path ?? null;
    },
    connectors: (workspaceId) => parts.connectors.forWorkspace(workspaceId).list(),
    connectorStores: parts.connectors,
    models: (workspaceId) => parts.models.forWorkspace(workspaceId),
    profiles: (workspaceId) => parts.runtimeProfiles.forWorkspace(workspaceId).list(),
    profileStore: (workspaceId) => parts.runtimeProfiles.forWorkspace(workspaceId),
    async detachProfile(workspaceId, agentId) {
      await parts.agents.forWorkspace(workspaceId).update(agentId, { runtimeProfileId: null });
    },
    granted: (workspaceId, agentId) =>
      parts.grants.forWorkspace(workspaceId).listPrincipalIds(agentId),
    skills: (workspaceId) => skills.list(workspaceId),
    skillsDomain: skills,
    skillRevisions: async (workspaceId, name) =>
      (await (await parts.skillCatalogs(workspaceId)).listSkillRevisions(name)).length,
    async skillFiles(workspaceId, name) {
      const files = await skills.files(workspaceId, name);
      return files === null
        ? null
        : Object.fromEntries(
            files.map((file) => [file.path, new TextDecoder().decode(file.bytes)] as const),
          );
    },
  };
}

export function buildWorld(parts: WorldParts, sandbox: DemoSandbox): DemoTemplatesWorld {
  const tag = crypto.randomUUID().slice(0, 8);
  const storage = createStorageService({
    catalog: (workspaceId) => parts.catalogs(workspaceId),
    objects: createInMemoryObjectStore(),
    log: noLog,
  });
  const binder = createGuestWorkspaceBinder({ directory: parts.directory, ids: randomIds });
  const skills = buildSkills(parts, storage);
  const templates = createDemoTemplates({
    workspaceIdForSlug: parts.workspaceIdForSlug,
    directory: parts.directory,
    agents: parts.agents,
    resources: parts.resources,
    grants: parts.grants,
    connectors: parts.connectors,
    catalogs: parts.catalogs,
    storage,
    models: parts.models,
    runtimeProfiles: parts.runtimeProfiles,
    skills,
    sandbox,
  });
  const templateSlugs = new Set<string>();
  const operations = createDemoTemplateOperations({
    workspaceIdForSlug: parts.workspaceIdForSlug,
    workspaces: {
      async make({ slug, ownerEmail }) {
        if ((await parts.workspaceIdForSlug(slug)) !== null) return null;
        const made = await parts.makeWorkspace(slug, ownerEmail);
        templateSlugs.add(slug);
        return made.id;
      },
      templateSlugs: () => Promise.resolve([...templateSlugs]),
    },
    directory: parts.directory,
    agents: parts.agents,
    connectors: parts.connectors,
    catalogs: parts.catalogs,
    storage,
    skills,
  });
  const seeding = { parts, storage, skills, templateSlugs };

  return {
    templates,
    operations,
    templateId: (entry) => parts.workspaceIdForSlug(demoTemplateWorkspaceSlug(entry)),
    directory: parts.directory,
    entry: (local) => `${local}-${tag}-${crypto.randomUUID().slice(0, 4)}`,
    seedTemplate: (entry, spec, madeBy = 'deployment') =>
      seedTemplateWorkspace(seeding, entry, spec, madeBy),

    ...worldPeople(parts, binder),
    ...worldReaders(parts, storage, skills),
  };
}
