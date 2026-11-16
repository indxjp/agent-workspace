/**
 * The worlds `templates.contract.ts` runs in: the stores behind {@link DemoTemplates} built on
 * memory and on a real PostgreSQL, and the readers and seeders over them. Both are made by one
 * function, so the two worlds differ only in the stores and in how a template workspace is made.
 */
import crypto from 'node:crypto';

import type { DatabaseRoot } from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  createInMemoryCatalog,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createSecretsService, type SecretsService } from '@agent-workspace/core/secrets';
import type { AgentResourceAssignments } from '@indx-workspace/contracts/agents';
import { demoTemplateWorkspaceSlug, type DemoEntrySlug } from '@indx-workspace/contracts/demo';

import { createInMemoryAgentStoreProvider } from '../../agents/memory-store';
import type { AgentGrantStoreProvider } from '../../agents/agent-grants-store';
import { compiledPolicyFor, withStoredConnectorIds } from '../../agents/core/policy';
import type { AgentResourceStoreProvider } from '../../agents/resource-store';
import {
  createRepositoryAgentGrantStoreProvider,
  createRepositoryAgentResourceStoreProvider,
  createRepositoryAgentStoreProvider,
  type AgentStoreProvider,
} from '../../agents/store';
import { createInMemoryConnectorsStoreProvider } from '../../connectors/memory-store';
import {
  createInMemoryModelsStoreProvider,
  createRepositoryModelsStoreProvider,
} from '../../models/store';
import type { ModelsStoreProvider } from '../../models/store';
import { createInMemoryRuntimeProfileStoreProvider } from '../../runtimes/memory-store';
import {
  createRepositoryRuntimeProfileStoreProvider,
  type RuntimeProfileStoreProvider,
} from '../../runtimes/store';
import {
  createRepositoryConnectorsStoreProvider,
  type ConnectorsStoreProvider,
} from '../../connectors/store';
import { admitToolConnector } from '../../connectors/tools';
import { createGuestWorkspaceBinder } from '../../email-link/adapters/guest-workspace/production';
import { counterIds, randomIds } from '../../ids';
import { conferRole } from '../../rbac/core/conferral';
import { createMemoryDirectory } from '../../rbac/memory-directory';
import { createPostgresDirectory } from '../../rbac/postgres-directory';
import type { DirectoryRoot } from '../../rbac/directory';
import { createStorageService } from '../../storage/service';
import { createResourceCatalogStoreProvider } from '../../storage/store';
import { createInMemoryObjectStore } from '../../storage/testing';
import type { CatalogPort } from '../../storage/store';
import type { SkillCatalog } from '../../skills/ports';
import { createWorkspaceSkills } from '../../skills/workspace-skills';
import type { DemoSandbox } from './ports';
import {
  TEST_DEMO_API_KEY,
  type DemoTemplatesWorld,
  type SeedConnector,
  type TemplateSpec,
} from './templates.contract';
import { createDemoTemplateOperations } from './seed';
import { createDemoTemplates } from './template-copy';
import { DEMO_TEMPLATE_CONNECTOR_COMMAND, templateConnectorArgs } from './template-connector';
import { recordSetPath } from './template-layout';
import { DEMO_TEMPLATE_OWNER_DOMAIN } from './template-owner';

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

/** The demo key and driver a world gives its provisioner unless a test says otherwise. */
const TEST_DEMO_SANDBOX: DemoSandbox = {
  runtimeDriver: 'docker',
  anthropicApiKey: TEST_DEMO_API_KEY,
  enforcesNoNetwork: () => Promise.resolve(true),
};

/** The parts a world is made of; the two worlds differ in these. */
interface Parts {
  readonly directory: DirectoryRoot;
  readonly agents: AgentStoreProvider;
  readonly resources: AgentResourceStoreProvider;
  readonly grants: AgentGrantStoreProvider;
  readonly connectors: ConnectorsStoreProvider;
  readonly models: ModelsStoreProvider;
  readonly runtimeProfiles: RuntimeProfileStoreProvider;
  readonly catalogs: (workspaceId: string) => Promise<CatalogPort>;
  /** The skills catalog of a workspace: the same catalog, as the skills domain reads it. */
  readonly skillCatalogs: (workspaceId: string) => Promise<SkillCatalog>;
  /** Make the workspace `slug` with `ownerEmail` as its one Owner (a template, or a person's). */
  readonly makeWorkspace: (
    slug: string,
    ownerEmail: string,
  ) => Promise<{
    readonly id: string;
    readonly principalId: string;
    readonly userId: string | null;
  }>;
  readonly workspaceIdForSlug: (slug: string) => Promise<string | null>;
}

const OPENAPI_DOCUMENT = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Pets', version: '1' },
  servers: [{ url: 'https://93.184.216.34/v1' }],
  paths: {
    '/pets': {
      get: { operationId: 'listPets', responses: {} },
      post: { operationId: 'createPet', responses: {} },
    },
  },
});

async function seedConnector(
  store: ReturnType<ConnectorsStoreProvider['forWorkspace']>,
  connector: SeedConnector,
  owner: { principalId: string; userId: string | null },
): Promise<string> {
  let outcome;
  if (connector.kind === 'declared') {
    outcome = await store.create(
      {
        name: connector.name,
        transport: 'stdio',
        command: DEMO_TEMPLATE_CONNECTOR_COMMAND,
        args: templateConnectorArgs(connector.reads, connector.writes),
        url: null,
        authType: 'none',
        credential: null,
      },
      owner,
    );
    if (outcome.kind !== 'created') throw new Error(`seeding ${connector.name}: ${outcome.kind}`);
    return outcome.server.id;
  }
  if (connector.kind === 'mcp') {
    outcome = await store.create(
      {
        name: connector.name,
        transport: 'http',
        command: null,
        args: null,
        url: 'https://mailer.example.test/mcp',
        authType: 'none',
        credential: null,
      },
      owner,
    );
    if (outcome.kind !== 'created') throw new Error(`seeding ${connector.name}: ${outcome.kind}`);
    return outcome.server.id;
  }
  const body =
    connector.kind === 'postgres'
      ? {
          kind: 'postgres',
          name: connector.name,
          credential: 'postgres://reader:pw@93.184.216.34:5432/shop',
          tables: ['public.orders'],
          readOnly: true,
        }
      : {
          kind: 'openapi',
          name: connector.name,
          document: OPENAPI_DOCUMENT,
          allow: connector.kind === 'openapi-read' ? ['GET /pets'] : ['GET /pets', 'POST /pets'],
          auth: 'bearer',
          credential: 'token-for-the-template-only',
        };
  const admitted = await admitToolConnector(body, () => Promise.resolve({ ok: true }));
  if (!admitted.ok)
    throw new Error(`seeding ${connector.name}: ${JSON.stringify(admitted.result)}`);
  const made = await store.createToolConnector(admitted.write, owner);
  if (made.kind !== 'created') throw new Error(`seeding ${connector.name}: ${made.kind}`);
  return made.connector.id;
}

function buildWorld(parts: Parts, sandbox: DemoSandbox): DemoTemplatesWorld {
  const tag = crypto.randomUUID().slice(0, 8);
  const objects = createInMemoryObjectStore();
  const storage = createStorageService({
    catalog: (workspaceId) => parts.catalogs(workspaceId),
    objects,
    log: noLog,
  });
  const binder = createGuestWorkspaceBinder({ directory: parts.directory, ids: randomIds });
  // A skill stored before the catalog held rows lives here; these worlds write rows only.
  const skillObjects = new Map<string, ReturnType<typeof createInMemoryObjectStore>>();
  const skills = createWorkspaceSkills({
    objects: (workspaceId) => {
      const held = skillObjects.get(workspaceId) ?? createInMemoryObjectStore();
      skillObjects.set(workspaceId, held);
      return held;
    },
    catalog: parts.skillCatalogs,
    storage,
  });
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
  /** Make the spec's skills in the template: a built-in from the release, any other from its files. */
  async function seedSkills(
    workspaceId: string,
    owner: { principalId: string; userId: string | null },
    specs: NonNullable<TemplateSpec['skills']>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const spec of specs) {
      if (spec.files === undefined) {
        await skills.installBuiltins(workspaceId, owner, [spec.name]);
        const id = (await skills.list(workspaceId)).find((skill) => skill.name === spec.name)?.id;
        if (id === undefined) throw new Error(`seeding the built-in skill ${spec.name}`);
        ids.push(id);
        continue;
      }
      const made = await skills.create(workspaceId, owner, {
        name: spec.name,
        files: Object.entries(spec.files).map(([path, text]) => ({
          path,
          bytes: new TextEncoder().encode(text),
        })),
      });
      if (made.kind !== 'created') throw new Error(`seeding the skill ${spec.name}: ${made.kind}`);
      ids.push(made.id);
    }
    return ids;
  }

  const readRows = async (workspaceId: string) => {
    const catalog = await parts.catalogs(workspaceId);
    return (await catalog.list('', { limit: 1000 })).rows;
  };

  return {
    templates,
    operations,
    templateId: (entry) => parts.workspaceIdForSlug(demoTemplateWorkspaceSlug(entry)),
    directory: parts.directory,
    entry: (local) => `${local}-${tag}-${crypto.randomUUID().slice(0, 4)}`,

    async seedTemplate(
      entry: DemoEntrySlug,
      spec: TemplateSpec,
      madeBy: 'deployment' | 'person' = 'deployment',
    ) {
      templateSlugs.add(demoTemplateWorkspaceSlug(entry));
      const template = await parts.makeWorkspace(
        demoTemplateWorkspaceSlug(entry),
        madeBy === 'person'
          ? `${crypto.randomUUID()}@example.test`
          : `${crypto.randomUUID()}@${DEMO_TEMPLATE_OWNER_DOMAIN}`,
      );
      const owner = { principalId: template.principalId, userId: template.userId };
      const ctx = { workspaceId: template.id, ...owner };
      for (const file of spec.files) {
        const bytes = new TextEncoder().encode(file.text);
        const saved = await storage.save(ctx, {
          area: 'files',
          path: file.path,
          body: new Response(bytes).body ?? new ReadableStream(),
          maxBytes: 1_000_000,
          contentType: 'text/plain',
          replace: false,
        });
        if (!saved.ok) throw new Error(`seeding ${file.path}: ${saved.code}`);
      }
      for (const set of spec.records ?? []) {
        const saved = await storage.save(ctx, {
          area: 'files',
          path: recordSetPath(set),
          body: new Response(JSON.stringify(set)).body ?? new ReadableStream(),
          maxBytes: 1_000_000,
          contentType: 'application/json',
          replace: false,
        });
        if (!saved.ok) throw new Error(`seeding records of ${set.connector}: ${saved.code}`);
      }
      const catalog = await parts.catalogs(template.id);
      const assigned: { fileId: string; access: 'read' | 'read-write' }[] = [];
      for (const grant of spec.assign) {
        const row = await catalog.get(grant.path);
        if (row === null) throw new Error(`seeding: no row at ${grant.path}`);
        assigned.push({ fileId: row.id, access: grant.access });
      }
      const store = parts.connectors.forWorkspace(template.id);
      const connectorIds: string[] = [];
      const idsByName = new Map<string, string>();
      for (const connector of spec.connectors ?? []) {
        const id = await seedConnector(store, connector, owner);
        connectorIds.push(id);
        idsByName.set(connector.name, id);
      }
      const skillIds = await seedSkills(template.id, owner, spec.skills ?? []);
      const permissions = {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: spec.agent.unrestrictedNetwork ?? false,
      };
      const agents = parts.agents.forWorkspace(template.id);
      const made = await agents.createWithAssignments(
        {
          name: spec.agent.name,
          instructions: spec.agent.instructions,
          modelConnectionId: null,
          model: null,
          permissions,
        },
        owner,
        { files: assigned, skillIds, connectorIds },
      );
      if (made.kind !== 'created') throw new Error(`seeding the agent: ${made.kind}`);
      const base = compiledPolicyFor(
        permissions,
        (spec.skills ?? []).map((skill) => skill.name),
      );
      // Rules are written by connector name, and stored by id, as the agents routes store them.
      const ruled = withStoredConnectorIds(
        {
          ...base,
          tools: {
            ...base.tools,
            autoApprove: [...base.tools.autoApprove, ...(spec.rules?.autoApprove ?? [])],
            deny: [...base.tools.deny, ...(spec.rules?.deny ?? [])],
          },
        },
        idsByName,
      );
      if (spec.policy === 'compiled') return;
      await agents.replacePolicy(made.agent.id, {
        ...ruled,
        limits: { maxTurns: spec.agent.maxTurns, maxBudgetUsd: spec.agent.maxBudgetUsd },
      });
    },

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
    models: (workspaceId) => parts.models.forWorkspace(workspaceId),
    profiles: (workspaceId) => parts.runtimeProfiles.forWorkspace(workspaceId).list(),
    profileStore: (workspaceId) => parts.runtimeProfiles.forWorkspace(workspaceId),
    async detachProfile(workspaceId, agentId) {
      await parts.agents.forWorkspace(workspaceId).update(agentId, { runtimeProfileId: null });
    },
    granted: (workspaceId, agentId) =>
      parts.grants.forWorkspace(workspaceId).listPrincipalIds(agentId),
    skills: (workspaceId) => skills.list(workspaceId),
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
  const resources: AgentResourceStoreProvider = {
    forWorkspace: (workspaceId) => ({
      get: async (agentId) =>
        (await agents.forWorkspace(workspaceId).get(agentId)) === null
          ? null
          : (assignments.get(`${workspaceId}:${agentId}`) ?? null),
      replace: () => Promise.reject(new Error('the world never replaces assignments')),
    }),
  };
  const directory = createMemoryDirectory({ newId: () => ids.newId() });
  return buildWorld(
    {
      directory,
      agents,
      resources,
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

function createPostgresTemplatesWorld(
  database: DatabaseRoot,
  isolated: IsolatedTestDatabase,
  secrets: SecretsService,
  sandbox: Partial<DemoSandbox>,
): DemoTemplatesWorld {
  const scopes = database.scopes;
  const agents = createRepositoryAgentStoreProvider({ repositories: database.agents, scopes });
  const catalogs = createResourceCatalogStoreProvider({
    repositories: database.resourceCatalogs,
    scopes,
  });
  return buildWorld(
    {
      directory: createPostgresDirectory(database.directory),
      agents,
      resources: createRepositoryAgentResourceStoreProvider({
        repositories: database.agentResources,
        scopes,
      }),
      grants: createRepositoryAgentGrantStoreProvider({
        repositories: database.agentGrants,
        scopes,
      }),
      connectors: createRepositoryConnectorsStoreProvider({
        mcpServers: database.mcpServers,
        secrets,
        scopes,
      }),
      models: createRepositoryModelsStoreProvider({
        repositories: database.modelConnections,
        scopes,
        secrets,
      }),
      runtimeProfiles: createRepositoryRuntimeProfileStoreProvider({
        repositories: database.runtimeProfiles,
        scopes,
      }),
      catalogs: (workspaceId) => catalogs.forWorkspace(workspaceId),
      skillCatalogs: (workspaceId) => catalogs.forWorkspace(workspaceId),
      async makeWorkspace(slug, ownerEmail) {
        const id = crypto.randomUUID();
        const userId = crypto.randomUUID();
        const membershipId = crypto.randomUUID();
        const principalId = crypto.randomUUID();
        await isolated.db.insert(workspaces).values({ id, slug, name: slug });
        await isolated.db
          .insert(users)
          .values({ id: userId, email: ownerEmail, name: 'Template owner' });
        await isolated.db.transaction(async (tx) => {
          await tx
            .insert(memberships)
            .values({ id: membershipId, workspaceId: id, userId, role: 'owner' });
          await tx
            .insert(workspacePrincipals)
            .values({ id: principalId, workspaceId: id, kind: 'membership', membershipId });
        });
        return { id, principalId, userId };
      },
      async workspaceIdForSlug(slug) {
        return (await scopes.forWorkspaceSlug(slug))?.workspaceId ?? null;
      },
    },
    { ...TEST_DEMO_SANDBOX, ...sandbox },
  );
}

export async function openPostgresTemplatesWorld(): Promise<{
  /** A world over the one database, whose provisioner runs on `sandbox` (the test defaults, changed by it). */
  readonly world: (sandbox?: Partial<DemoSandbox>) => Promise<DemoTemplatesWorld>;
  readonly close: () => Promise<void>;
}> {
  const { openDatabaseRoot } = await import('@agent-workspace/core/db');
  const isolated = await createIsolatedTestDatabase('aw_demo_templates');
  const database = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  // One secrets service (it opens its own pool) for every world over this database.
  const secrets = await createSecretsService({
    DATABASE_URL: isolated.url,
    MASTER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  });
  return {
    world: (sandbox = {}) =>
      Promise.resolve(createPostgresTemplatesWorld(database, isolated, secrets, sandbox)),
    close: async () => {
      await secrets.close();
      await database.close();
      await isolated.close();
    },
  };
}
