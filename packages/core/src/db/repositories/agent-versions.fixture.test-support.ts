import { asc, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { agentFiles } from '../schema/agent-files.js';
import { agentMcpServers } from '../schema/agent-mcp-servers.js';
import { agentPointerMoves } from '../schema/agent-pointer-moves.js';
import { agentSkills } from '../schema/agent-skills.js';
import { agentVersionPointers } from '../schema/agent-version-pointers.js';
import { agents, type AgentPermissions } from '../schema/agents.js';
import { auditEvents } from '../schema/audit-events.js';
import { files } from '../schema/files.js';
import { mcpServers } from '../schema/mcp-servers.js';
import { memberships } from '../schema/memberships.js';
import { modelConnections } from '../schema/model-connections.js';
import { skills } from '../schema/skills.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import {
  createDatabaseAgentVersionRepositoryProvider,
  type AgentPointerAudit,
  type AgentVersionRepository,
  type MaterialisedAgent,
  type ResolvedReferences,
} from './agent-versions.js';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  type ResourceCatalogRepository,
} from './resource-catalogs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations, type PostgresViolation } from './violations.js';
export const READ_ONLY: AgentPermissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};
export const NO_REFERENCES: ResolvedReferences = {
  modelConnectionId: null,
  runtimeProfileId: null,
  skillIds: [],
  connectorIds: [],
  files: [],
};
export const bodyWith = (...surfaceNames: readonly string[]): unknown => ({
  definition: { agent: { name: 'any' } },
  surfaces: surfaceNames.map((name) => ({ name, kind: 'chat' })),
});
export function createAgentVersionFixture() {
  let isolated: IsolatedTestDatabase;

  let repoA: AgentVersionRepository;

  let repoB: AgentVersionRepository;

  let catalogA: ResourceCatalogRepository;

  const workspaceA = crypto.randomUUID();

  const workspaceB = crypto.randomUUID();

  const userA = crypto.randomUUID();

  const userB = crypto.randomUUID();

  const membershipA = crypto.randomUUID();

  const membershipB = crypto.randomUUID();

  const principalA = crypto.randomUUID();

  const principalB = crypto.randomUUID();

  const skillId = crypto.randomUUID();

  const connectorId = crypto.randomUUID();

  const fileId = crypto.randomUUID();

  const defaultConnectionB = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_agent_versions');
    await isolated.db.insert(workspaces).values([
      { id: workspaceA, slug: 'versions-a', name: 'Versions A' },
      { id: workspaceB, slug: 'versions-b', name: 'Versions B' },
    ]);
    await isolated.db.insert(users).values([
      { id: userA, email: `${userA}@example.test`, name: 'Owner A' },
      { id: userB, email: `${userB}@example.test`, name: 'Owner B' },
    ]);
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values([
        { id: membershipA, workspaceId: workspaceA, userId: userA, role: 'owner' },
        { id: membershipB, workspaceId: workspaceB, userId: userB, role: 'owner' },
      ]);
      await tx.insert(workspacePrincipals).values([
        { id: principalA, workspaceId: workspaceA, kind: 'membership', membershipId: membershipA },
        { id: principalB, workspaceId: workspaceB, kind: 'membership', membershipId: membershipB },
      ]);
    });
    await isolated.db.insert(skills).values({
      id: skillId,
      workspaceId: workspaceA,
      name: 'reviewer',
      skillMd: '# Reviewer',
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    await isolated.db.insert(mcpServers).values({
      id: connectorId,
      workspaceId: workspaceA,
      name: 'github',
      ownerPrincipalId: principalA,
      createdBy: userA,
      transport: 'http',
      command: null,
      args: null,
      url: 'https://example.test/mcp',
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
    });
    await isolated.db.insert(files).values({
      id: fileId,
      workspaceId: workspaceA,
      path: 'handbook',
      kind: 'folder',
      storageKey: null,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    // Workspace A has no connection named `default`; workspace B has one (C7's two cases).
    await isolated.db.insert(modelConnections).values([
      { workspaceId: workspaceA, name: 'Claude', provider: 'anthropic', config: {} },
      {
        id: defaultConnectionB,
        workspaceId: workspaceB,
        name: 'default',
        provider: 'anthropic',
        config: {},
      },
    ]);

    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const scopeA = await resolver.forWorkspaceId(workspaceA);
    const scopeB = await resolver.forWorkspaceId(workspaceB);
    if (scopeA === null || scopeB === null) throw new Error('workspace fixture did not resolve');
    const provider = createDatabaseAgentVersionRepositoryProvider(isolated.db);
    repoA = provider.forScope(scopeA);
    repoB = provider.forScope(scopeB);
    catalogA = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
  }, 180_000);

  afterAll(async () => isolated.close());

  /** Insert a bare agent row in workspace A. */
  async function seedAgent(name: string): Promise<string> {
    const id = crypto.randomUUID();
    await isolated.db.insert(agents).values({
      id,
      workspaceId: workspaceA,
      name,
      instructions: '',
      permissions: READ_ONLY,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    return id;
  }

  /** Write the next version of `agentId` in workspace A and answer it. */
  async function version(agentId: string, body: unknown = bodyWith()) {
    const outcome = await repoA.create(agentId, {
      summary: 'a change',
      via: 'api',
      body,
      createdByPrincipalId: principalA,
    });
    if (outcome.kind !== 'created') throw new Error(`version not created: ${outcome.kind}`);
    return outcome.version;
  }

  const materialise = (overrides: Partial<MaterialisedAgent>): MaterialisedAgent => ({
    name: 'unnamed',
    instructions: 'Be helpful.',
    model: null,
    permissions: READ_ONLY,
    policy: null,
    references: NO_REFERENCES,
    ...overrides,
  });

  /** The `agent-changed` row a move by workspace A's owner records. */
  const auditBy = (overrides: Partial<AgentPointerAudit> = {}): AgentPointerAudit => ({
    subjectLabel: 'an agent: local -> version 1',
    actorPrincipalId: principalA,
    actorUserId: userA,
    actorLabel: 'Owner A',
    ...overrides,
  });

  /** Every `audit_events` row whose subject is `agentId`. */
  async function auditRows(agentId: string) {
    return isolated.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, agentId))
      .orderBy(asc(auditEvents.createdAt));
  }

  /** Every row `applyAndPoint` may touch for `agentId`, for an exact before/after comparison. */
  async function snapshot(agentId: string) {
    const [agent, skillRows, connectorRows, fileRows, pointerRows, moveRows] = await Promise.all([
      isolated.db.select().from(agents).where(eq(agents.id, agentId)),
      isolated.db
        .select()
        .from(agentSkills)
        .where(eq(agentSkills.agentId, agentId))
        .orderBy(asc(agentSkills.id)),
      isolated.db
        .select()
        .from(agentMcpServers)
        .where(eq(agentMcpServers.agentId, agentId))
        .orderBy(asc(agentMcpServers.id)),
      isolated.db
        .select()
        .from(agentFiles)
        .where(eq(agentFiles.agentId, agentId))
        .orderBy(asc(agentFiles.id)),
      isolated.db
        .select()
        .from(agentVersionPointers)
        .where(eq(agentVersionPointers.agentId, agentId)),
      isolated.db
        .select()
        .from(agentPointerMoves)
        .where(eq(agentPointerMoves.agentId, agentId))
        .orderBy(asc(agentPointerMoves.movedAt)),
    ]);
    return { agent, skillRows, connectorRows, fileRows, pointerRows, moveRows };
  }

  /** The violations a refused write raised. */
  async function violationsOf(write: Promise<unknown>): Promise<readonly PostgresViolation[]> {
    try {
      await write;
    } catch (error) {
      return [...postgresViolations(error)];
    }
    throw new Error('the write was expected to be refused');
  }
  return {
    get isolated() {
      return isolated;
    },
    get repoA() {
      return repoA;
    },
    get repoB() {
      return repoB;
    },
    get catalogA() {
      return catalogA;
    },
    get workspaceA() {
      return workspaceA;
    },
    get workspaceB() {
      return workspaceB;
    },
    get userA() {
      return userA;
    },
    get userB() {
      return userB;
    },
    get membershipA() {
      return membershipA;
    },
    get membershipB() {
      return membershipB;
    },
    get principalA() {
      return principalA;
    },
    get principalB() {
      return principalB;
    },
    get skillId() {
      return skillId;
    },
    get connectorId() {
      return connectorId;
    },
    get fileId() {
      return fileId;
    },
    get defaultConnectionB() {
      return defaultConnectionB;
    },
    get seedAgent() {
      return seedAgent;
    },
    get version() {
      return version;
    },
    get materialise() {
      return materialise;
    },
    get auditBy() {
      return auditBy;
    },
    get auditRows() {
      return auditRows;
    },
    get snapshot() {
      return snapshot;
    },
    get violationsOf() {
      return violationsOf;
    },
  };
}
