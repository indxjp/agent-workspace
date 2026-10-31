/**
 * The agent version store (#442, S1-04, ADR-0101) against real PostgreSQL, plus the pure matcher
 * and the #133 `writeFiles` ceiling it shares.
 *
 * What only a real database can prove is here: the tenant-paired foreign keys of
 * `agent_version_pointers`, version numbering under concurrent writers, the all-or-nothing
 * `applyAndPoint` and `createAgentWithFirstVersion` transactions, C7's default-connection rule and
 * C9's one-surface-name-per-environment rule, and the workspace default runtime profile a version
 * that names none resolves to (#504, S1-22).
 */
import crypto from 'node:crypto';

import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentFiles } from '../schema/agent-files.js';
import { agentMcpServers } from '../schema/agent-mcp-servers.js';
import { agentSkills } from '../schema/agent-skills.js';
import { agentPointerMoves } from '../schema/agent-pointer-moves.js';
import { agentVersionPointers } from '../schema/agent-version-pointers.js';
import { agentVersions } from '../schema/agent-versions.js';
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
  classifyReferenceMatches,
  narrowFileGrants,
  narrowStorageGrants,
  resolveFromRows,
  storageGrantChange,
} from './agent-versions-resolution.js';
import { lockAgentCreations } from './agent-versions-shared.js';
import { createDatabaseAgentRepositoryProvider } from './agents.js';
import {
  createDatabaseAgentVersionRepositoryProvider,
  type AgentPointerAudit,
  type AgentPointerMoveReason,
  type AgentVersionRepository,
  type MaterialisedAgent,
  type ResolvedReferences,
} from './agent-versions.js';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  type ResourceCatalogRepository,
} from './resource-catalogs.js';
import { createDatabaseSessionRepositoryProvider } from './runs.js';
import { createDatabaseRuntimeProfileRepositoryProvider } from './runtime-profiles.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations, type PostgresViolation } from './violations.js';
import { seedCatalogFile } from './catalog-fixtures.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[repositories/agent-versions.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the agent ' +
      'version store was NOT exercised against a real PostgreSQL.',
  );
}

const READ_ONLY: AgentPermissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

const NO_REFERENCES: ResolvedReferences = {
  modelConnectionId: null,
  runtimeProfileId: null,
  skillIds: [],
  connectorIds: [],
  files: [],
};

/** A version body with these surface names; core stores it unparsed. */
const bodyWith = (...surfaceNames: readonly string[]): unknown => ({
  definition: { agent: { name: 'any' } },
  surfaces: surfaceNames.map((name) => ({ name, kind: 'chat' })),
});

describe('classifyReferenceMatches', () => {
  it('reports a name two rows share as ambiguous and resolves neither', () => {
    // The per-workspace unique name keys (`mcp_servers_workspace_name_key` and its siblings) make
    // two matches unreachable in PostgreSQL today, so this arm is proven here, without a database.
    const matches = classifyReferenceMatches(
      'connector',
      ['github', 'linear'],
      [
        { id: 'c1', name: 'github' },
        { id: 'c2', name: 'github' },
        { id: 'c3', name: 'linear' },
      ],
    );
    expect(matches.ambiguous).toEqual([{ kind: 'connector', name: 'github' }]);
    expect(matches.missing).toEqual([]);
    expect([...matches.ids]).toEqual([['linear', 'c3']]);
  });

  it('matches exactly, and reports a missing name once', () => {
    const matches = classifyReferenceMatches(
      'skill',
      ['Reviewer', 'nope', 'nope'],
      [{ id: 's1', name: 'reviewer' }],
    );
    expect(matches.missing).toEqual([
      { kind: 'skill', name: 'Reviewer' },
      { kind: 'skill', name: 'nope' },
    ]);
    expect(matches.ids.size).toBe(0);
  });
});

describe('resolveFromRows', () => {
  const references = {
    modelConnectionName: null,
    runtimeProfileName: null,
    skills: [],
    connectors: [],
    files: [],
  };

  it('resolves C7 default to the deployment default when no connection is named default', () => {
    expect(resolveFromRows(references, {}, 'p1')).toEqual({
      kind: 'resolved',
      references: {
        modelConnectionId: null,
        runtimeProfileId: 'p1',
        skillIds: [],
        connectorIds: [],
        files: [],
      },
    });
  });

  it('reports a default two connections share as ambiguous, never as the deployment default', () => {
    const rows = {
      'model-connection': [
        { id: 'm1', name: 'default' },
        { id: 'm2', name: 'default' },
      ],
    };
    expect(resolveFromRows(references, rows, null)).toEqual({
      kind: 'unresolved',
      missing: [],
      ambiguous: [{ kind: 'model-connection', name: 'default' }],
    });
  });
});

describe('narrowStorageGrants and storageGrantChange', () => {
  const folder = (connectionId: string, prefix: string, access: 'read' | 'read-write') => ({
    connectionId,
    prefix,
    access,
  });

  // @story US-STO-12
  it('[US-STO-12][contract][sdk] narrows read-write to read without writeFiles, and keeps the wider duplicate', () => {
    const grants = [
      folder('c1', 'reports', 'read'),
      folder('c1', 'reports', 'read-write'),
      folder('c2', 'archive', 'read'),
    ];
    expect(narrowStorageGrants(grants, READ_ONLY)).toEqual([
      folder('c1', 'reports', 'read'),
      folder('c2', 'archive', 'read'),
    ]);
    expect(narrowStorageGrants(grants, { ...READ_ONLY, writeFiles: true })).toEqual([
      folder('c1', 'reports', 'read-write'),
      folder('c2', 'archive', 'read'),
    ]);
  });

  // @story US-STO-12
  it('[US-STO-12][contract][sdk] describes a change by id, access and prefix, and none for equal sets', () => {
    const one = folder('c1', 'reports', 'read');
    const two = folder('c2', 'archive', 'read-write');
    expect(storageGrantChange([one, two], [two, one])).toBeNull();
    expect(storageGrantChange([], [])).toBeNull();
    expect(storageGrantChange([one], [one, two])).toBe('c1 read reports; c2 read-write archive');
    expect(storageGrantChange([one], [])).toBe('no storage grants');
    expect(storageGrantChange([one], [folder('c1', 'reports', 'read-write')])).toBe(
      'c1 read-write reports',
    );
  });
});

describe('narrowFileGrants', () => {
  const grants = [
    { fileId: 'f1', access: 'read-write' as const },
    { fileId: 'f2', access: 'read' as const },
  ];

  it('narrows read-write to read when writeFiles is off (#133)', () => {
    expect(narrowFileGrants(grants, READ_ONLY)).toEqual([
      { fileId: 'f1', access: 'read' },
      { fileId: 'f2', access: 'read' },
    ]);
  });

  it('keeps read-write when writeFiles is on, and one grant per file', () => {
    expect(
      narrowFileGrants([...grants, { fileId: 'f1', access: 'read' }], {
        ...READ_ONLY,
        writeFiles: true,
      }),
    ).toEqual(grants);
  });
});

describe.skipIf(!hasDatabase)('AgentVersionRepository against real PostgreSQL', () => {
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

  it('refuses a pointer that names another workspace (agent_version_pointers_agent_workspace_fk)', async () => {
    const agentId = await seedAgent('cross-workspace');
    const v1 = await version(agentId);
    const violations = await violationsOf(
      isolated.db
        .insert(agentVersionPointers)
        .values({ workspaceId: workspaceB, agentId, environment: 'local', versionId: v1.id }),
    );
    expect(violations).toContainEqual({
      code: '23503',
      constraint: 'agent_version_pointers_agent_workspace_fk',
    });
  });

  it('refuses a pointer to another agent’s version (agent_version_pointers_version_fk)', async () => {
    const owner = await seedAgent('version-owner');
    const other = await seedAgent('version-borrower');
    const v1 = await version(owner);
    const violations = await violationsOf(
      isolated.db.insert(agentVersionPointers).values({
        workspaceId: workspaceA,
        agentId: other,
        environment: 'local',
        versionId: v1.id,
      }),
    );
    expect(violations).toEqual([
      { code: '23503', constraint: 'agent_version_pointers_version_fk' },
    ]);
  });

  it("stores and lists a version with via 'builder' (#1847)", async () => {
    const agentId = await seedAgent('builder-via');
    const outcome = await repoA.create(agentId, {
      summary: 'saved by the Builder',
      via: 'builder',
      body: bodyWith(),
      createdByPrincipalId: principalA,
    });
    expect(outcome.kind).toBe('created');
    const listed = await repoA.list(agentId);
    expect(listed?.versions.map((row) => row.via)).toEqual(['builder']);
    await expect(repoA.find(agentId, 1)).resolves.toMatchObject({ number: 1, via: 'builder' });
  });

  it('numbers two concurrent versions 1 and 2', async () => {
    const agentId = await seedAgent('concurrent');
    const [first, second] = await Promise.all([version(agentId), version(agentId)]);
    expect([first.number, second.number].sort()).toEqual([1, 2]);
    const listed = await repoA.list(agentId);
    expect(listed?.versions.map((row) => row.number)).toEqual([1, 2]);
    await expect(repoA.find(agentId, 2)).resolves.toMatchObject({ number: 2, via: 'api' });
    await expect(repoA.find(agentId, 3)).resolves.toBeNull();
  });

  it('answers not-found for another workspace’s agent, and unknown-principal for a stranger', async () => {
    const agentId = await seedAgent('scoped');
    await expect(
      repoB.create(agentId, {
        summary: 'x',
        via: 'ui',
        body: bodyWith(),
        createdByPrincipalId: principalB,
      }),
    ).resolves.toEqual({ kind: 'not-found' });
    await expect(repoB.list(agentId)).resolves.toBeNull();
    await expect(
      repoA.create(agentId, {
        summary: 'x',
        via: 'ui',
        body: bodyWith(),
        createdByPrincipalId: principalB,
      }),
    ).resolves.toEqual({ kind: 'unknown-principal' });
  });

  it.each(['local', 'production'] as const)(
    'refuses a %s move of an archived agent from the locked row and writes nothing (#1987)',
    async (environment) => {
      const agentId = await seedAgent(`archived-${environment}`);
      await version(agentId);
      await isolated.db
        .update(agents)
        .set({ archivedAt: new Date('2026-01-02T03:04:05.000Z') })
        .where(eq(agents.id, agentId));
      const before = await snapshot(agentId);
      const auditsBefore = await isolated.db.$count(
        auditEvents,
        and(eq(auditEvents.action, 'agent-changed'), eq(auditEvents.subjectId, agentId)),
      );

      await expect(
        repoA.applyAndPoint(agentId, {
          reason: 'set',
          audit: auditBy(),
          environment,
          number: 1,
          agent: materialise({ name: `archived-${environment}` }),
        }),
      ).resolves.toEqual({ kind: 'agent-archived' });

      expect((await repoA.list(agentId))?.pointers).toEqual([]);
      expect(await snapshot(agentId)).toEqual(before);
      expect(
        await isolated.db.$count(
          auditEvents,
          and(eq(auditEvents.action, 'agent-changed'), eq(auditEvents.subjectId, agentId)),
        ),
      ).toBe(auditsBefore);
    },
  );

  it('applies a version and its assignments, narrowing read-write to read (#133)', async () => {
    const agentId = await seedAgent('applied');
    await version(agentId);
    const outcome = await repoA.applyAndPoint(agentId, {
      reason: 'set',
      audit: auditBy(),
      environment: 'local',
      number: 1,
      agent: materialise({
        name: 'applied',
        references: {
          ...NO_REFERENCES,
          skillIds: [skillId],
          connectorIds: [connectorId],
          files: [{ fileId, access: 'read-write' }],
        },
      }),
    });
    expect(outcome).toMatchObject({
      kind: 'applied',
      agent: { id: agentId, instructions: 'Be helpful.' },
      pointer: { agentId, environment: 'local', number: 1 },
    });
    const rows = await snapshot(agentId);
    expect(rows.fileRows.map((row) => row.access)).toEqual(['read']);
    expect(rows.skillRows.map((row) => row.skillId)).toEqual([skillId]);
    expect(rows.connectorRows.map((row) => row.mcpServerId)).toEqual([connectorId]);
    const listed = await repoA.list(agentId);
    expect(listed?.pointers).toEqual([
      expect.objectContaining({ environment: 'local', number: 1 }),
    ]);
    await expect(
      repoA.applyAndPoint(agentId, {
        reason: 'set',
        environment: 'local',
        number: 9,
        agent: materialise({}),
        audit: auditBy(),
      }),
    ).resolves.toEqual({ kind: 'version-not-found' });
    await expect(
      repoB.applyAndPoint(agentId, {
        reason: 'set',
        environment: 'local',
        number: 1,
        agent: materialise({}),
        audit: auditBy({ actorPrincipalId: principalB, actorUserId: userB }),
      }),
    ).resolves.toEqual({ kind: 'not-found' });
  });

  it('rolls everything back on a vanished reference and on a name conflict', async () => {
    const agentId = await seedAgent('atomic');
    await seedAgent('taken-name');
    await version(agentId);
    await version(agentId);
    const applied = await repoA.applyAndPoint(agentId, {
      reason: 'set',
      audit: auditBy(),
      environment: 'local',
      number: 1,
      agent: materialise({
        name: 'atomic',
        references: {
          ...NO_REFERENCES,
          skillIds: [skillId],
          connectorIds: [connectorId],
          files: [{ fileId, access: 'read' }],
        },
      }),
    });
    expect(applied.kind).toBe('applied');
    const before = await snapshot(agentId);

    await expect(
      repoA.applyAndPoint(agentId, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 2,
        agent: materialise({
          name: 'atomic',
          instructions: 'changed',
          references: { ...NO_REFERENCES, skillIds: [crypto.randomUUID()] },
        }),
      }),
    ).resolves.toEqual({ kind: 'reference-gone', referenceKind: 'skill' });
    expect(await snapshot(agentId)).toEqual(before);

    await expect(
      repoA.applyAndPoint(agentId, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 2,
        agent: materialise({ name: 'taken-name', instructions: 'changed' }),
      }),
    ).resolves.toEqual({ kind: 'name-conflict', name: 'taken-name' });
    expect(await snapshot(agentId)).toEqual(before);
  });

  it('writes exactly one agent-changed audit row for an applied move (#478, ADR-0101)', async () => {
    const agentId = await seedAgent('audited');
    await version(agentId);
    const outcome = await repoA.applyAndPoint(agentId, {
      reason: 'set',
      environment: 'local',
      number: 1,
      agent: materialise({ name: 'audited' }),
      audit: auditBy({ subjectLabel: 'audited: local -> version 1' }),
    });
    expect(outcome.kind).toBe('applied');
    const rows = await auditRows(agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: workspaceA,
      action: 'agent-changed',
      subjectId: agentId,
      subjectLabel: 'audited: local -> version 1',
      actorPrincipalId: principalA,
      actorUserId: userA,
      actorLabel: 'Owner A',
    });
  });

  it('rolls the whole move back when its audit row cannot be written (#478 regression)', async () => {
    const agentId = await seedAgent('audit-refused');
    await version(agentId);
    await version(agentId);
    const applied = await repoA.applyAndPoint(agentId, {
      reason: 'set',
      audit: auditBy(),
      environment: 'local',
      number: 1,
      agent: materialise({
        name: 'audit-refused',
        references: { ...NO_REFERENCES, skillIds: [skillId] },
      }),
    });
    expect(applied.kind).toBe('applied');
    const before = await snapshot(agentId);
    const auditsBefore = await auditRows(agentId);
    expect(auditsBefore).toHaveLength(1);

    // Another workspace's principal: the move's history row, written before the audit row, is
    // refused first by `agent_pointer_moves_moved_by_principal_workspace_fk` (#615).
    const crossWorkspace = await violationsOf(
      repoA.applyAndPoint(agentId, {
        reason: 'set',
        environment: 'local',
        number: 2,
        agent: materialise({ name: 'audit-refused-renamed', instructions: 'changed' }),
        audit: auditBy({ actorPrincipalId: principalB }),
      }),
    );
    expect(crossWorkspace).toContainEqual({
      code: '23503',
      constraint: 'agent_pointer_moves_moved_by_principal_workspace_fk',
    });
    expect(await snapshot(agentId)).toEqual(before);
    expect(await auditRows(agentId)).toEqual(auditsBefore);

    // A blank actor label: `audit_events_actor_label_not_blank` refuses the row.
    const blankLabel = await violationsOf(
      repoA.applyAndPoint(agentId, {
        reason: 'set',
        environment: 'local',
        number: 2,
        agent: materialise({ name: 'audit-refused-renamed', instructions: 'changed' }),
        audit: auditBy({ actorLabel: '   ' }),
      }),
    );
    expect(blankLabel).toContainEqual({
      code: '23514',
      constraint: 'audit_events_actor_label_not_blank',
    });
    expect(await snapshot(agentId)).toEqual(before);
    expect(await auditRows(agentId)).toEqual(auditsBefore);
  });

  it('writes no audit row for a refused move (#478)', async () => {
    const agentId = await seedAgent('audit-quiet');
    await seedAgent('audit-quiet-taken');
    const holder = await seedAgent('audit-quiet-holder');
    await version(agentId, bodyWith('quiet-surface'));
    await version(holder, bodyWith('quiet-surface'));
    await expect(
      repoA.applyAndPoint(holder, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 1,
        agent: materialise({ name: 'audit-quiet-holder' }),
      }),
    ).resolves.toMatchObject({ kind: 'applied' });

    await expect(
      repoA.applyAndPoint(agentId, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 7,
        agent: materialise({ name: 'audit-quiet' }),
      }),
    ).resolves.toEqual({ kind: 'version-not-found' });
    await expect(
      repoA.applyAndPoint(agentId, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 1,
        agent: materialise({ name: 'audit-quiet' }),
      }),
    ).resolves.toEqual({ kind: 'surface-name-taken', name: 'quiet-surface' });
    await expect(
      repoA.applyAndPoint(agentId, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 1,
        agent: materialise({ name: 'audit-quiet-taken' }),
      }),
    ).resolves.toEqual({ kind: 'name-conflict', name: 'audit-quiet-taken' });
    expect(await auditRows(agentId)).toEqual([]);
  });

  describe('compare-and-set on a pointer move (#1847)', () => {
    /** An agent with versions 1..3 and `local` pointed at version 1. */
    async function agentAtVersionOne(name: string): Promise<string> {
      const agentId = await seedAgent(name);
      await version(agentId);
      await version(agentId);
      await version(agentId);
      const seeded = await repoA.applyAndPoint(agentId, {
        reason: 'set',
        environment: 'local',
        number: 1,
        agent: materialise({ name }),
        audit: auditBy(),
      });
      expect(seeded.kind).toBe('applied');
      return agentId;
    }

    const moveLocal = (
      agentId: string,
      name: string,
      number: number,
      expectedVersion?: number | null,
    ) =>
      repoA.applyAndPoint(agentId, {
        reason: 'set',
        environment: 'local',
        number,
        agent: materialise({ name }),
        audit: auditBy(),
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      });

    it('moves local once when two moves both expect the same version', async () => {
      const agentId = await agentAtVersionOne('cas-concurrent');
      const [toTwo, toThree] = await Promise.all([
        moveLocal(agentId, 'cas-concurrent', 2, 1),
        moveLocal(agentId, 'cas-concurrent', 3, 1),
      ]);

      const outcomes = [toTwo, toThree];
      const applied = outcomes.filter((outcome) => outcome.kind === 'applied');
      expect(applied).toHaveLength(1);
      const winner = applied[0];
      if (winner?.kind !== 'applied') throw new Error('one move should have applied');
      expect(outcomes.filter((outcome) => outcome.kind !== 'applied')).toEqual([
        { kind: 'pointer-moved', current: winner.pointer.number },
      ]);

      const rows = await snapshot(agentId);
      expect(rows.pointerRows.map((row) => row.versionId)).toEqual([winner.pointer.versionId]);
      // The seed move plus the winner's: the refused move appended nothing.
      expect(rows.moveRows).toHaveLength(2);
      expect(await auditRows(agentId)).toHaveLength(2);
    });

    it('refuses a stale expectation, changes nothing, and leaves the new version unpointed', async () => {
      const agentId = await agentAtVersionOne('cas-stale');
      const before = await snapshot(agentId);
      const auditsBefore = await auditRows(agentId);

      await expect(moveLocal(agentId, 'cas-stale', 3, 2)).resolves.toEqual({
        kind: 'pointer-moved',
        current: 1,
      });

      expect(await snapshot(agentId)).toEqual(before);
      expect(await auditRows(agentId)).toEqual(auditsBefore);
      // §08 Data rule 2: the version a refused move was about to point at stays saved, unpointed.
      const listed = await repoA.list(agentId);
      expect(listed?.versions.map((row) => row.number)).toEqual([1, 2, 3]);
      expect(listed?.pointers.map((row) => row.number)).toEqual([1]);
    });

    it('applies when the expectation holds, and when it is absent', async () => {
      const agentId = await agentAtVersionOne('cas-holds');
      await expect(moveLocal(agentId, 'cas-holds', 2, 1)).resolves.toMatchObject({
        kind: 'applied',
        pointer: { number: 2 },
      });
      await expect(moveLocal(agentId, 'cas-holds', 3)).resolves.toMatchObject({
        kind: 'applied',
        pointer: { number: 3 },
      });
    });

    it('reads null as "the pointer must be unset"', async () => {
      const unset = await seedAgent('cas-null-unset');
      await version(unset);
      await expect(moveLocal(unset, 'cas-null-unset', 1, null)).resolves.toMatchObject({
        kind: 'applied',
      });
      await expect(moveLocal(unset, 'cas-null-unset', 1, null)).resolves.toEqual({
        kind: 'pointer-moved',
        current: 1,
      });
    });

    it('checks the environment being moved, not local', async () => {
      const agentId = await agentAtVersionOne('cas-production');
      const promote = (expectedVersion: number | null) =>
        repoA.applyAndPoint(agentId, {
          reason: 'promote',
          environment: 'production',
          number: 1,
          agent: materialise({ name: 'cas-production' }),
          audit: auditBy(),
          expectedVersion,
        });
      await expect(promote(1)).resolves.toEqual({ kind: 'pointer-moved', current: null });
      await expect(promote(null)).resolves.toMatchObject({ kind: 'applied' });
    });

    it('answers not-found for another workspace’s agent before comparing', async () => {
      const agentId = await agentAtVersionOne('cas-scoped');
      await expect(
        repoB.applyAndPoint(agentId, {
          reason: 'set',
          environment: 'local',
          number: 1,
          agent: materialise({}),
          audit: auditBy({ actorPrincipalId: principalB, actorUserId: userB }),
          expectedVersion: 2,
        }),
      ).resolves.toEqual({ kind: 'not-found' });
    });
  });

  it('appends one history row per move, newest first, scoped to the workspace (#615)', async () => {
    const agentId = await seedAgent('history');
    await version(agentId);
    await version(agentId);
    const move = (
      number: number,
      environment: 'local' | 'production',
      reason: AgentPointerMoveReason,
    ) =>
      repoA.applyAndPoint(agentId, {
        reason,
        environment,
        number,
        agent: materialise({ name: 'history' }),
        audit: auditBy(),
      });
    await expect(move(1, 'local', 'set')).resolves.toMatchObject({ kind: 'applied' });
    await expect(move(2, 'local', 'set')).resolves.toMatchObject({ kind: 'applied' });
    await expect(move(2, 'production', 'promote')).resolves.toMatchObject({ kind: 'applied' });
    await expect(move(1, 'production', 'rollback')).resolves.toMatchObject({ kind: 'applied' });
    // A refused move appends nothing.
    await expect(move(9, 'production', 'promote')).resolves.toEqual({
      kind: 'version-not-found',
    });

    const moves = await repoA.listMoves(agentId, null, 10);
    expect(moves.map(({ environment, number, reason }) => [environment, number, reason])).toEqual([
      ['production', 1, 'rollback'],
      ['production', 2, 'promote'],
      ['local', 2, 'set'],
      ['local', 1, 'set'],
    ]);
    expect(moves.every((row) => row.movedByPrincipalId === principalA)).toBe(true);
    const production = await repoA.listMoves(agentId, 'production', 2);
    expect(production.map((row) => row.number)).toEqual([1, 2]);
    // The head of each environment's history is its pointer.
    const listed = await repoA.list(agentId);
    expect(listed?.pointers.map((row) => [row.environment, row.number])).toEqual([
      ['local', 2],
      ['production', 1],
    ]);
    // Another workspace never sees these rows.
    await expect(repoB.listMoves(agentId, null, 10)).resolves.toEqual([]);
  });

  it('resolves names exactly and reports a missing skill', async () => {
    await expect(
      repoA.resolveDefinition({
        modelConnectionName: null,
        runtimeProfileName: null,
        skills: ['reviewer'],
        connectors: ['github'],
        files: [{ path: 'handbook', access: 'read' }],
      }),
    ).resolves.toEqual({
      kind: 'resolved',
      references: {
        modelConnectionId: null,
        runtimeProfileId: null,
        skillIds: [skillId],
        connectorIds: [connectorId],
        files: [{ fileId, access: 'read' }],
      },
    });
    await expect(
      repoA.resolveDefinition({
        modelConnectionName: null,
        runtimeProfileName: 'nowhere',
        skills: ['nope', 'reviewer'],
        connectors: ['GitHub'],
        files: [],
      }),
    ).resolves.toEqual({
      kind: 'unresolved',
      missing: [
        { kind: 'skill', name: 'nope' },
        { kind: 'connector', name: 'GitHub' },
        { kind: 'runtime-profile', name: 'nowhere' },
      ],
      ambiguous: [],
    });
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] does not resolve a pending upload by path or id', async () => {
    const pendingId = crypto.randomUUID();
    await isolated.db.insert(files).values({
      id: pendingId,
      workspaceId: workspaceA,
      path: 'pending-upload.pdf',
      kind: 'file',
      storageKey: 'pending-upload.pdf',
      objectId: crypto.randomUUID(),
      status: 'pending',
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    const result = await repoA.resolveDefinition({
      modelConnectionName: null,
      runtimeProfileName: null,
      skills: [],
      connectors: [],
      files: [{ path: 'pending-upload.pdf', access: 'read' }],
    });
    expect(result.kind).toBe('unresolved');
    expect(JSON.stringify(result)).toContain('pending-upload.pdf');
    // The id lookup (`namesOf`) is the other branch of the same file query.
    const byId = await repoA.namesOf({ file: [pendingId] });
    expect(byId.file.has(pendingId)).toBe(false);
  });

  it('resolves a skill revision pin only once that revision is published, and writes it with the assignment (SDK-19, N-1)', async () => {
    const references = {
      modelConnectionName: null,
      runtimeProfileName: null,
      skills: ['reviewer'],
      skillRevisions: { reviewer: 1 },
      connectors: [],
      files: [],
    };
    await expect(repoA.resolveDefinition(references)).resolves.toEqual({
      kind: 'unresolved',
      missing: [{ kind: 'skill', name: 'reviewer@1' }],
      ambiguous: [],
    });

    await catalogA.publishSkillRevision('reviewer', {
      fileCount: 1,
      write: () => Promise.resolve(undefined),
    });
    await expect(repoA.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'resolved',
      references: { skillIds: [skillId], skillRevisions: { [skillId]: 1 } },
    });
    // Another workspace has no such skill, so it has no such revision either.
    await expect(repoB.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'unresolved',
    });

    const agentId = await seedAgent('pins-a-revision');
    await version(agentId);
    const applied = await repoA.applyAndPoint(agentId, {
      reason: 'set',
      audit: auditBy(),
      environment: 'local',
      number: 1,
      agent: materialise({
        name: 'pins-a-revision',
        references: { ...NO_REFERENCES, skillIds: [skillId], skillRevisions: { [skillId]: 1 } },
      }),
    });
    expect(applied.kind).toBe('applied');
    expect((await snapshot(agentId)).skillRows).toMatchObject([{ skillId, revision: 1 }]);
  });

  it('resolves a files() grant on a folder that only has a file uploaded under it (#899)', async () => {
    const references = {
      modelConnectionName: null,
      runtimeProfileName: null,
      skills: [],
      connectors: [],
      files: [{ path: 'manuals', access: 'read' as const }],
    };
    await expect(repoA.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'unresolved',
      missing: [{ kind: 'file', name: 'manuals' }],
    });

    await seedCatalogFile(catalogA, {
      path: 'manuals/hydraulic-unit.md',
      kind: 'file',
      sizeBytes: 1,
      contentType: 'text/markdown',
      ownerPrincipalId: principalA,
      createdBy: userA,
    });

    await expect(repoA.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'resolved',
      references: { files: [{ access: 'read' }] },
    });
    await expect(repoB.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'unresolved',
    });
  });

  it('resolves a files() grant on a folder a file was moved into (#899)', async () => {
    const references = {
      modelConnectionName: null,
      runtimeProfileName: null,
      skills: [],
      connectors: [],
      files: [{ path: 'moved-into', access: 'read' as const }],
    };
    await seedCatalogFile(catalogA, {
      path: 'loose.md',
      kind: 'file',
      sizeBytes: 1,
      contentType: 'text/markdown',
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    await expect(repoA.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'unresolved',
      missing: [{ kind: 'file', name: 'moved-into' }],
    });

    await catalogA.rename('loose.md', 'moved-into/loose.md');

    await expect(repoA.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'resolved',
      references: { files: [{ access: 'read' }] },
    });
  });

  // C15: a tool connector is referenced by its name, and compose hands it to the engine through
  // the gateway (S2-02f, #531), so it resolves as an agent connector.
  it('resolves a tool connector named as an agent connector', async () => {
    const toolId = crypto.randomUUID();
    await isolated.db.insert(mcpServers).values({
      id: toolId,
      workspaceId: workspaceA,
      name: 'pets-tool',
      kind: 'openapi',
      ownerPrincipalId: principalA,
      transport: null,
      toolConfig: { openapi: {} },
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
    });
    await expect(
      repoA.resolveDefinition({
        modelConnectionName: null,
        runtimeProfileName: null,
        skills: [],
        connectors: ['pets-tool'],
        files: [],
      }),
    ).resolves.toMatchObject({ kind: 'resolved', references: { connectorIds: [toolId] } });
  });

  it('C7: null and "default" resolve to the default connection, or to the deployment default', async () => {
    const references = {
      runtimeProfileName: null,
      skills: [],
      connectors: [],
      files: [],
    } as const;
    for (const modelConnectionName of [null, 'default']) {
      await expect(
        repoA.resolveDefinition({ ...references, modelConnectionName }),
      ).resolves.toMatchObject({ kind: 'resolved', references: { modelConnectionId: null } });
      await expect(
        repoB.resolveDefinition({ ...references, modelConnectionName }),
      ).resolves.toMatchObject({
        kind: 'resolved',
        references: { modelConnectionId: defaultConnectionB },
      });
    }
    await expect(
      repoA.resolveDefinition({ ...references, modelConnectionName: 'GPT' }),
    ).resolves.toEqual({
      kind: 'unresolved',
      missing: [{ kind: 'model-connection', name: 'GPT' }],
      ambiguous: [],
    });
  });

  it('names which connectors launch a process, in its own workspace only (#793)', async () => {
    const stdio = (name: string, workspaceId: string, ownerPrincipalId: string) => ({
      id: crypto.randomUUID(),
      workspaceId,
      name,
      ownerPrincipalId,
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', 'orders-mcp@1.2.3'],
      authType: 'none' as const,
      credentialSecretId: null,
      enabled: true,
    });
    await isolated.db
      .insert(mcpServers)
      .values([
        stdio('stdio-zeta', workspaceA, principalA),
        stdio('stdio-alpha', workspaceA, principalA),
        stdio('stdio-b-only', workspaceB, principalB),
      ]);

    // `github` is an http connector and `missing` does not exist: neither launches a process.
    await expect(
      repoA.stdioConnectorNames([
        'stdio-zeta',
        'github',
        'stdio-alpha',
        'missing',
        'stdio-b-only',
        'stdio-alpha',
      ]),
    ).resolves.toEqual(['stdio-alpha', 'stdio-zeta']);
    await expect(repoA.stdioConnectorNames([])).resolves.toEqual([]);
    await expect(repoB.stdioConnectorNames(['stdio-alpha', 'stdio-b-only'])).resolves.toEqual([
      'stdio-b-only',
    ]);
  });

  it('finds MCP connector ids by name, in its own workspace only (#1109)', async () => {
    const mcp = (name: string, workspaceId: string, ownerPrincipalId: string) => ({
      id: crypto.randomUUID(),
      workspaceId,
      name,
      ownerPrincipalId,
      transport: 'http' as const,
      url: 'https://mcp.example.test/mcp',
      authType: 'none' as const,
      credentialSecretId: null,
      enabled: true,
    });
    const finder = mcp('ids-finder', workspaceA, principalA);
    const foreign = mcp('ids-foreign', workspaceB, principalB);
    await isolated.db.insert(mcpServers).values([finder, foreign]);
    await isolated.db.insert(mcpServers).values({
      workspaceId: workspaceA,
      name: 'ids-tool',
      kind: 'openapi',
      ownerPrincipalId: principalA,
      transport: null,
      toolConfig: { openapi: {} },
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
    });

    // `ids-tool` is a tool connector and `ids-foreign` is workspace B's: neither is answered.
    const ids = await repoA.mcpConnectorIdsByName([
      'ids-finder',
      'ids-tool',
      'ids-foreign',
      'missing',
    ]);
    expect([...ids]).toEqual([['ids-finder', finder.id]]);
    await expect(repoA.mcpConnectorIdsByName([])).resolves.toEqual(new Map());
  });

  it('finds agents by name with the subagent flag of the materialised body (agentsByName)', async () => {
    const withSubagents = await seedAgent('by-name-nested');
    await version(withSubagents, {
      ...(bodyWith() as object),
      subagents: [{ name: 'by-name-plain' }],
    });
    const plain = await seedAgent('by-name-plain');
    await version(plain, { ...(bodyWith() as object), description: 'Plain.' });
    const unmaterialised = await seedAgent('by-name-unmaterialised');
    await version(unmaterialised, { ...(bodyWith() as object), subagents: [{ name: 'x' }] });
    const emptied = await seedAgent('by-name-empty-list');
    await version(emptied, { ...(bodyWith() as object), subagents: [] });
    await isolated.db.insert(agents).values({
      workspaceId: workspaceB,
      name: 'by-name-b-only',
      instructions: '',
      permissions: READ_ONLY,
      ownerPrincipalId: principalB,
      createdBy: userB,
    });
    for (const [id, name] of [
      [withSubagents, 'by-name-nested'],
      [plain, 'by-name-plain'],
      [emptied, 'by-name-empty-list'],
    ] as const) {
      const outcome = await repoA.applyAndPoint(id, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 1,
        agent: materialise({ name }),
      });
      expect(outcome.kind).toBe('applied');
    }

    const found = await repoA.agentsByName([
      'by-name-nested',
      'by-name-plain',
      'by-name-unmaterialised',
      'by-name-empty-list',
      'by-name-b-only',
      'by-name-missing',
      'by-name-plain',
    ]);
    expect(Object.fromEntries(found)).toEqual({
      'by-name-nested': { id: withSubagents, hasSubagents: true, hasDescription: false },
      'by-name-plain': { id: plain, hasSubagents: false, hasDescription: true },
      'by-name-unmaterialised': { id: unmaterialised, hasSubagents: false, hasDescription: false },
      'by-name-empty-list': { id: emptied, hasSubagents: false, hasDescription: false },
    });
    await expect(repoA.agentsByName([])).resolves.toEqual(new Map());
  });

  describe('one level of subagents, both ways', () => {
    const namesSubagents = (...names: readonly string[]): unknown => ({
      ...(bodyWith() as object),
      subagents: names.map((name) => ({ name })),
    });

    /** Seed `names` as agents whose materialised version declares nothing. */
    async function seedPlain(...names: readonly string[]): Promise<Map<string, string>> {
      const ids = new Map<string, string>();
      for (const name of names) {
        const id = await seedAgent(name);
        const written = await version(id);
        const outcome = await repoA.applyAndPoint(id, {
          reason: 'set',
          audit: auditBy(),
          environment: 'local',
          number: written.number,
          agent: materialise({ name }),
        });
        expect(outcome.kind).toBe('applied');
        ids.set(name, id);
      }
      return ids;
    }

    const idOf = (ids: ReadonlyMap<string, string>, name: string): string => {
      const id = ids.get(name);
      if (id === undefined) throw new Error(`no seeded agent ${name}`);
      return id;
    };

    /** Write the next version of `name` naming `subagents`, and move `environment` to it. */
    async function declare(
      ids: ReadonlyMap<string, string>,
      name: string,
      subagents: readonly string[],
      environment: 'local' | 'production' = 'local',
    ) {
      const id = idOf(ids, name);
      const written = await version(id, namesSubagents(...subagents));
      return repoA.applyAndPoint(id, {
        reason: 'set',
        audit: auditBy(),
        environment,
        number: written.number,
        agent: materialise({ name }),
      });
    }

    /** Names of workspace A's agents that declare subagents and are also named by another agent. */
    async function nestedAgents(): Promise<readonly string[]> {
      const result = await isolated.db.execute(sql`
        select distinct a.name
        from agents a
        join agent_versions v on v.id = a.materialised_version_id
        where a.workspace_id = ${workspaceA}
          and jsonb_array_length(coalesce(v.body->'subagents', '[]'::jsonb)) > 0
          and exists (
            select 1
            from agents o
            join agent_versions ov on ov.id = o.materialised_version_id
            cross join lateral jsonb_array_elements(coalesce(ov.body->'subagents', '[]'::jsonb)) s(elem)
            where o.workspace_id = ${workspaceA} and o.id <> a.id and s.elem->>'name' = a.name
          )`);
      return result.rows.map((row) => String(row['name']));
    }

    it('refuses a parent naming an agent that has subagents', async () => {
      const ids = await seedPlain('nest-fwd-a', 'nest-fwd-b', 'nest-fwd-c');
      await expect(declare(ids, 'nest-fwd-b', ['nest-fwd-c'])).resolves.toMatchObject({
        kind: 'applied',
      });
      await expect(declare(ids, 'nest-fwd-a', ['nest-fwd-b'])).resolves.toEqual({
        kind: 'subagent-nesting',
        unusable: ['nest-fwd-b'],
        parents: [],
      });
    });

    it("refuses an agent that is already someone's subagent gaining subagents", async () => {
      const ids = await seedPlain('nest-rev-a', 'nest-rev-b', 'nest-rev-c');
      await expect(declare(ids, 'nest-rev-a', ['nest-rev-b'])).resolves.toMatchObject({
        kind: 'applied',
      });
      const before = await snapshot(idOf(ids, 'nest-rev-b'));
      await expect(declare(ids, 'nest-rev-b', ['nest-rev-c'])).resolves.toEqual({
        kind: 'subagent-nesting',
        unusable: [],
        parents: ['nest-rev-a'],
      });
      const after = await snapshot(idOf(ids, 'nest-rev-b'));
      expect(after.agent).toEqual(before.agent);
      expect(after.pointerRows).toEqual(before.pointerRows);
      expect(after.moveRows).toEqual(before.moveRows);
    });

    it('reports every missing subagent in body order, and an agent naming itself', async () => {
      const ids = await seedPlain('nest-missing-a', 'nest-missing-b');
      await expect(
        declare(ids, 'nest-missing-a', [
          'nest-missing-zz',
          'nest-missing-b',
          'nest-missing-aa',
          'nest-missing-a',
        ]),
      ).resolves.toEqual({
        kind: 'subagent-nesting',
        unusable: ['nest-missing-zz', 'nest-missing-aa', 'nest-missing-a'],
        parents: [],
      });
    });

    it('runs no check for a body without subagents or a non-local move', async () => {
      const ids = await seedPlain('nest-free-a', 'nest-free-b');
      await expect(declare(ids, 'nest-free-a', ['nest-free-b'])).resolves.toMatchObject({
        kind: 'applied',
      });
      // b has a parent now, but a body that declares nothing creates no edge.
      await expect(declare(ids, 'nest-free-b', [])).resolves.toMatchObject({ kind: 'applied' });
      // Only the materialised (local) bodies form the graph, so a production move is not checked.
      await expect(
        declare(ids, 'nest-free-b', ['nest-free-missing'], 'production'),
      ).resolves.toMatchObject({ kind: 'applied' });
    });

    it('refuses a new agent whose first version nests, either way', async () => {
      const ids = await seedPlain('nest-new-b', 'nest-new-c');
      await declare(ids, 'nest-new-b', ['nest-new-c']);
      const create = (name: string, subagents: readonly string[]) =>
        repoA.createAgentWithFirstVersion({
          agent: { ...materialise({ name }), ownerPrincipalId: principalA, createdBy: userA },
          version: {
            summary: 'first',
            via: 'api',
            body: namesSubagents(...subagents),
            createdByPrincipalId: principalA,
          },
          environment: 'local',
        });
      await expect(create('nest-new-a', ['nest-new-b'])).resolves.toEqual({
        kind: 'subagent-nesting',
        unusable: ['nest-new-b'],
        parents: [],
      });
      await expect(create('nest-new-c-parent', ['nest-new-c'])).resolves.toMatchObject({
        kind: 'created',
      });
      // A new agent named like an existing subagent is refused the same way an edit would be.
      await expect(create('nest-new-c', ['nest-new-x'])).resolves.toMatchObject({
        kind: 'subagent-nesting',
        unusable: ['nest-new-x'],
      });
    });

    it('lists the parents of a name, excluding the agent itself and other workspaces', async () => {
      const ids = await seedPlain('parents-a1', 'parents-a2', 'parents-child');
      await declare(ids, 'parents-a2', ['parents-child']);
      await declare(ids, 'parents-a1', ['parents-child']);
      await expect(repoA.subagentParents('parents-child', null)).resolves.toEqual([
        'parents-a1',
        'parents-a2',
      ]);
      await expect(
        repoA.subagentParents('parents-child', idOf(ids, 'parents-a1')),
      ).resolves.toEqual(['parents-a2']);
      await expect(repoB.subagentParents('parents-child', null)).resolves.toEqual([]);
    });

    it('cannot build A→B→C from two concurrent materialisations', async () => {
      for (let round = 0; round < 10; round += 1) {
        const [a, b, c] = [`race-${round}-a`, `race-${round}-b`, `race-${round}-c`] as const;
        const ids = await seedPlain(a, b, c);
        // Both versions are saved first: only the two materialising moves race.
        const [first, second] = await Promise.all([declare(ids, a, [b]), declare(ids, b, [c])]);
        expect([first.kind, second.kind].sort()).toEqual(['applied', 'subagent-nesting']);
      }
      await expect(nestedAgents()).resolves.toEqual([]);
      // Ten rounds of racing transactions against real PostgreSQL: seconds on a shared CI runner.
    }, 30_000);

    it('cannot build A→B→C from a created agent racing a materialisation', async () => {
      for (let round = 0; round < 10; round += 1) {
        const [a, b, c] = [`crace-${round}-a`, `crace-${round}-b`, `crace-${round}-c`] as const;
        const ids = await seedPlain(b, c);
        const [created, moved] = await Promise.all([
          repoA.createAgentWithFirstVersion({
            agent: { ...materialise({ name: a }), ownerPrincipalId: principalA, createdBy: userA },
            version: {
              summary: 'first',
              via: 'api',
              body: namesSubagents(b),
              createdByPrincipalId: principalA,
            },
            // Another environment's pointer lock: only the subagent lock can order the two.
            environment: 'production',
          }),
          declare(ids, b, [c]),
        ]);
        const succeeded = [created.kind === 'created', moved.kind === 'applied'];
        expect(succeeded.filter(Boolean)).toHaveLength(1);
      }
      await expect(nestedAgents()).resolves.toEqual([]);
      // Ten rounds of racing transactions against real PostgreSQL: seconds on a shared CI runner.
    }, 30_000);
  });

  it('names each kind by id in its own workspace only (namesOf, #616)', async () => {
    const scopeA = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceA,
    );
    if (scopeA === null) throw new Error('workspace A did not resolve');
    const profile = await createDatabaseRuntimeProfileRepositoryProvider(isolated.db)
      .forScope(scopeA)
      .create({
        name: 'names-of',
        driver: 'local',
        runtimeConnectionId: null,
        cpu: null,
        memoryMb: null,
        diskMb: null,
        networkPolicy: 'open',
        allowedDomains: null,
        filesystem: 'read-write',
        persistPaths: null,
        timeoutSeconds: null,
        idleTimeoutSeconds: null,
        driverConfig: null,
      });
    if (profile.kind !== 'created') throw new Error(`expected created, got ${profile.kind}`);
    const [claude] = await isolated.db
      .select({ id: modelConnections.id })
      .from(modelConnections)
      .where(
        and(eq(modelConnections.workspaceId, workspaceA), eq(modelConnections.name, 'Claude')),
      );
    if (claude === undefined) throw new Error('the Claude connection fixture is missing');

    const names = await repoA.namesOf({
      skill: [skillId],
      connector: [connectorId],
      file: [fileId],
      // Workspace B's connection and a non-UUID are not workspace A's: both are absent.
      'model-connection': [claude.id, defaultConnectionB, 'not-a-uuid'],
      'runtime-profile': [profile.profile.id],
    });
    expect([...names.skill]).toEqual([[skillId, 'reviewer']]);
    expect([...names.connector]).toEqual([[connectorId, 'github']]);
    expect([...names.file]).toEqual([[fileId, 'handbook']]);
    expect([...names['model-connection']]).toEqual([[claude.id, 'Claude']]);
    expect([...names['runtime-profile']]).toEqual([[profile.profile.id, 'names-of']]);

    const fromB = await repoB.namesOf({ skill: [skillId], file: [fileId] });
    expect(fromB.skill.size + fromB.file.size).toBe(0);
  });

  it('points production without rewriting the agent row or its assignments (#612)', async () => {
    const agentId = await seedAgent('promoted');
    await version(agentId);
    await version(agentId);
    await expect(
      repoA.applyAndPoint(agentId, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 2,
        agent: materialise({
          name: 'promoted',
          instructions: 'Version two.',
          references: { ...NO_REFERENCES, skillIds: [skillId] },
        }),
      }),
    ).resolves.toMatchObject({ kind: 'applied' });
    const before = await snapshot(agentId);

    const outcome = await repoA.applyAndPoint(agentId, {
      reason: 'set',
      audit: auditBy({ subjectLabel: 'promoted: production -> version 1' }),
      environment: 'production',
      number: 1,
      agent: materialise({ name: 'renamed-by-v1', instructions: 'Version one.' }),
    });

    expect(outcome).toMatchObject({
      kind: 'applied',
      agent: { id: agentId, name: 'promoted', instructions: 'Version two.' },
      pointer: { agentId, environment: 'production', number: 1 },
    });
    const after = await snapshot(agentId);
    expect(after.agent).toEqual(before.agent);
    expect(after.skillRows).toEqual(before.skillRows);
    expect(after.pointerRows.map((row) => row.environment).sort()).toEqual(['local', 'production']);
    const listed = await repoA.list(agentId);
    expect(listed?.pointers.map((row) => [row.environment, row.number])).toEqual([
      ['local', 2],
      ['production', 1],
    ]);
    // The row is still `local`'s working copy, written from version 2.
    expect(listed?.materialisedVersionId).toBe(listed?.versions[1]?.id);
    expect((await auditRows(agentId)).map((row) => row.subjectLabel)).toEqual([
      'an agent: local -> version 1',
      'promoted: production -> version 1',
    ]);
  });

  it('C9 holds per environment: production refuses a name another production pointer serves', async () => {
    const first = await seedAgent('production-first');
    const second = await seedAgent('production-second');
    await version(first, bodyWith('storefront'));
    await version(second, bodyWith('storefront'));
    const point = (agentId: string, environment: 'local' | 'production', name: string) =>
      repoA.applyAndPoint(agentId, {
        reason: 'set',
        audit: auditBy(),
        environment,
        number: 1,
        agent: materialise({ name }),
      });
    await expect(point(first, 'production', 'production-first')).resolves.toMatchObject({
      kind: 'applied',
    });
    await expect(point(second, 'local', 'production-second')).resolves.toMatchObject({
      kind: 'applied',
    });
    await expect(point(second, 'production', 'production-second')).resolves.toEqual({
      kind: 'surface-name-taken',
      name: 'storefront',
    });
  });

  it('accepts a production pointer and refuses preview (agent_version_pointers_environment_valid)', async () => {
    const agentId = await seedAgent('environments');
    const v1 = await version(agentId);
    await isolated.db
      .insert(agentVersionPointers)
      .values({ workspaceId: workspaceA, agentId, environment: 'production', versionId: v1.id });
    const violations = await violationsOf(
      isolated.db.execute(
        sql`insert into agent_version_pointers (workspace_id, agent_id, environment, version_id)
            values (${workspaceA}, ${agentId}, 'preview', ${v1.id})`,
      ),
    );
    expect(violations).toEqual([
      { code: '23514', constraint: 'agent_version_pointers_environment_valid' },
    ]);
  });

  it('finds a version by id in its own workspace only', async () => {
    const agentId = await seedAgent('by-id');
    const v1 = await version(agentId);
    await expect(repoA.findById(v1.id)).resolves.toEqual(v1);
    await expect(repoB.findById(v1.id)).resolves.toBeNull();
    await expect(repoA.findById(crypto.randomUUID())).resolves.toBeNull();
  });

  describe('sessions.agent_version_id (#612)', () => {
    const sessionsOf = async (workspaceId: string) => {
      const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
        workspaceId,
      );
      if (scope === null) throw new Error('workspace fixture did not resolve');
      return createDatabaseSessionRepositoryProvider(isolated.db).forScope(scope);
    };

    it('pins the version on insert and keeps it when the session is ensured again', async () => {
      const agentId = await seedAgent('pinned');
      const v1 = await version(agentId);
      const v2 = await version(agentId);
      const sessionsA = await sessionsOf(workspaceA);
      const id = crypto.randomUUID();
      const input = { id, agentId, ownerPrincipalId: principalA };

      await expect(sessionsA.ensure({ ...input, agentVersionId: v1.id })).resolves.toMatchObject({
        kind: 'created',
        session: { id, agentVersionId: v1.id },
      });
      await expect(sessionsA.ensure({ ...input, agentVersionId: v2.id })).resolves.toMatchObject({
        kind: 'existing',
        session: { id, agentVersionId: v1.id },
      });
      await expect(sessionsA.get(id)).resolves.toMatchObject({ agentVersionId: v1.id });
    });

    it('stores NULL for a legacy session', async () => {
      const agentId = await seedAgent('legacy');
      const sessionsA = await sessionsOf(workspaceA);
      const outcome = await sessionsA.ensure({
        id: crypto.randomUUID(),
        agentId,
        ownerPrincipalId: principalA,
      });
      expect(outcome).toMatchObject({ kind: 'created', session: { agentVersionId: null } });
    });

    it("refuses another agent's or another workspace's version (sessions_agent_version_fk)", async () => {
      const agentId = await seedAgent('pin-owner');
      const other = await seedAgent('pin-borrower');
      const v1 = await version(other);
      const sessionsA = await sessionsOf(workspaceA);
      const borrowed = await violationsOf(
        sessionsA.ensure({
          id: crypto.randomUUID(),
          agentId,
          ownerPrincipalId: principalA,
          agentVersionId: v1.id,
        }),
      );
      expect(borrowed).toEqual([{ code: '23503', constraint: 'sessions_agent_version_fk' }]);

      const agentB = crypto.randomUUID();
      await isolated.db.insert(agents).values({
        id: agentB,
        workspaceId: workspaceB,
        name: 'pin-tenant',
        instructions: '',
        permissions: READ_ONLY,
        ownerPrincipalId: principalB,
        createdBy: userB,
      });
      const sessionsB = await sessionsOf(workspaceB);
      const crossTenant = await violationsOf(
        sessionsB.ensure({
          id: crypto.randomUUID(),
          agentId: agentB,
          ownerPrincipalId: principalB,
          agentVersionId: v1.id,
        }),
      );
      expect(crossTenant).toEqual([{ code: '23503', constraint: 'sessions_agent_version_fk' }]);
    });

    it('deleting the agent removes its versions and its pinned sessions together', async () => {
      const agentId = await seedAgent('pin-cascade');
      const v1 = await version(agentId);
      const sessionsA = await sessionsOf(workspaceA);
      const id = crypto.randomUUID();
      await sessionsA.ensure({ id, agentId, ownerPrincipalId: principalA, agentVersionId: v1.id });

      await isolated.db.delete(agents).where(eq(agents.id, agentId));

      await expect(sessionsA.get(id)).resolves.toBeNull();
      await expect(repoA.findById(v1.id)).resolves.toBeNull();
    });
  });

  it('C9: refuses a second agent serving the same surface name, leaving its pointer alone', async () => {
    const first = await seedAgent('surface-first');
    const second = await seedAgent('surface-second');
    await version(first, bodyWith('main'));
    await version(second, bodyWith('other'));
    await version(second, bodyWith('main', 'side'));
    await expect(
      repoA.applyAndPoint(first, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 1,
        agent: materialise({ name: 'surface-first' }),
      }),
    ).resolves.toMatchObject({ kind: 'applied' });
    await expect(
      repoA.applyAndPoint(second, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 1,
        agent: materialise({ name: 'surface-second' }),
      }),
    ).resolves.toMatchObject({ kind: 'applied', pointer: { number: 1 } });
    const before = await snapshot(second);

    await expect(
      repoA.applyAndPoint(second, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 2,
        agent: materialise({ name: 'surface-second', instructions: 'changed' }),
      }),
    ).resolves.toEqual({ kind: 'surface-name-taken', name: 'main' });
    expect(await snapshot(second)).toEqual(before);

    // Re-pointing the agent that already serves `main` is not a conflict with itself.
    await expect(
      repoA.applyAndPoint(first, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 1,
        agent: materialise({ name: 'surface-first' }),
      }),
    ).resolves.toMatchObject({ kind: 'applied' });

    const firstVersion = await repoA.find(first, 1);
    await expect(repoA.findPointedSurface('local', 'main')).resolves.toEqual({
      agentId: first,
      versionId: firstVersion?.id,
      number: 1,
      surface: { name: 'main', kind: 'chat' },
    });
    await expect(repoA.findPointedSurface('local', 'other')).resolves.toMatchObject({
      agentId: second,
      number: 1,
    });
    await expect(repoA.findPointedSurface('local', 'unknown')).resolves.toBeNull();
    await expect(repoB.findPointedSurface('local', 'main')).resolves.toBeNull();
    // Issue #680: each pointed surface name once, not an unpointed version's, never another
    // workspace's.
    const names = await repoA.listPointedSurfaceNames();
    expect(names).toEqual(expect.arrayContaining(['main', 'other']));
    expect(names).not.toContain('side');
    expect(new Set(names).size).toBe(names.length);
    await expect(repoB.listPointedSurfaceNames()).resolves.not.toContain('main');

    // A persisted surface element without a string `name` is skipped, not fatal to the list.
    const malformed = await seedAgent('surface-malformed');
    const bad = await version(malformed, {
      surfaces: [{ kind: 'chat' }, 'bare', { name: 7 }, { name: 'third', kind: 'chat' }],
    });
    await isolated.db.insert(agentVersionPointers).values({
      workspaceId: workspaceA,
      agentId: malformed,
      environment: 'production',
      versionId: bad.id,
    });
    await expect(repoA.listPointedSurfaceNames()).resolves.toEqual(
      expect.arrayContaining(['main', 'other', 'third']),
    );
  });

  it('does not resolve a skill being deleted and refuses to assign it, as a conflict and not a missing name', async () => {
    const deletingId = crypto.randomUUID();
    await isolated.db.insert(skills).values({
      id: deletingId,
      workspaceId: workspaceA,
      name: 'being-deleted',
      skillMd: '# Gone',
      ownerPrincipalId: principalA,
      createdBy: userA,
      pendingDelete: { ownerPrincipalId: principalA, revisions: [] },
    });
    await expect(
      repoA.resolveDefinition({
        modelConnectionName: null,
        runtimeProfileName: null,
        skills: ['being-deleted', 'nope'],
        connectors: [],
        files: [],
      }),
    ).resolves.toEqual({
      kind: 'unresolved',
      missing: [{ kind: 'skill', name: 'nope' }],
      ambiguous: [],
      deleting: [{ kind: 'skill', name: 'being-deleted' }],
    });
    // Marked between resolve and write: a typed outcome, not an escaped rollback.
    await expect(
      repoA.createAgentWithFirstVersion({
        agent: {
          ...materialise({
            name: 'born-with-deleting',
            references: { ...NO_REFERENCES, skillIds: [deletingId] },
          }),
          ownerPrincipalId: principalA,
          createdBy: userA,
        },
        version: {
          summary: 'first',
          via: 'aw-push',
          body: bodyWith('born'),
          createdByPrincipalId: principalA,
        },
        environment: 'local',
      }),
    ).resolves.toEqual({ kind: 'reference-gone', referenceKind: 'skill' });
  });

  it('creates an agent with its first version atomically', async () => {
    const created = await repoA.createAgentWithFirstVersion({
      agent: {
        ...materialise({
          name: 'born-versioned',
          references: { ...NO_REFERENCES, skillIds: [skillId] },
        }),
        ownerPrincipalId: principalA,
        createdBy: userA,
      },
      version: {
        summary: 'first',
        via: 'aw-push',
        body: bodyWith('born'),
        createdByPrincipalId: principalA,
      },
      environment: 'local',
    });
    if (created.kind !== 'created') throw new Error(`expected created, got ${created.kind}`);
    expect(created.version).toMatchObject({ number: 1, via: 'aw-push', agentId: created.agent.id });
    expect(created.pointer).toMatchObject({ number: 1, versionId: created.version.id });
    expect((await snapshot(created.agent.id)).skillRows).toHaveLength(1);
    await expect(repoA.listMoves(created.agent.id, null, 10)).resolves.toEqual([
      expect.objectContaining({
        environment: 'local',
        number: 1,
        reason: 'set',
        movedByPrincipalId: principalA,
      }),
    ]);

    const input = {
      ownerPrincipalId: principalA,
      createdBy: userA,
    };
    await expect(
      repoA.createAgentWithFirstVersion({
        agent: { ...materialise({ name: 'born-versioned' }), ...input },
        version: {
          summary: 'again',
          via: 'api',
          body: bodyWith(),
          createdByPrincipalId: principalA,
        },
        environment: 'local',
      }),
    ).resolves.toEqual({ kind: 'name-conflict', name: 'born-versioned' });

    // A refusal after the agent row was inserted (C9 runs last) still leaves no agent behind.
    await expect(
      repoA.createAgentWithFirstVersion({
        agent: { ...materialise({ name: 'born-refused' }), ...input },
        version: {
          summary: 'clash',
          via: 'api',
          body: bodyWith('born'),
          createdByPrincipalId: principalA,
        },
        environment: 'local',
      }),
    ).resolves.toEqual({ kind: 'surface-name-taken', name: 'born' });
    const left = await isolated.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceA), eq(agents.name, 'born-refused')));
    expect(left).toEqual([]);
    const orphanVersions = await isolated.db
      .select({ id: agentVersions.id })
      .from(agentVersions)
      .where(eq(agentVersions.summary, 'clash'));
    expect(orphanVersions).toEqual([]);
  });

  describe('agentCreatedAudit', () => {
    const created = (name: string) => ({
      agent: { ...materialise({ name }), ownerPrincipalId: principalA, createdBy: userA },
      version: {
        summary: name,
        via: 'builder' as const,
        body: bodyWith(name),
        createdByPrincipalId: principalA,
      },
      environment: 'local' as const,
    });
    const audit = (overrides: { actorLabel?: string } = {}) => ({
      actorPrincipalId: principalA,
      actorUserId: userA,
      actorLabel: 'Owner A',
      details: { builderRunId: 'run-1' },
      ...overrides,
    });
    const createdRows = (name: string) =>
      isolated.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, workspaceA),
            eq(auditEvents.action, 'agent-created'),
            eq(auditEvents.subjectLabel, name),
          ),
        );
    const pointerCount = async () =>
      (
        await isolated.db
          .select({ id: agentVersionPointers.agentId })
          .from(agentVersionPointers)
          .where(eq(agentVersionPointers.workspaceId, workspaceA))
      ).length;

    it('leaves no agent, version, pointer or audit row when the audit row is refused', async () => {
      const name = 'born-audit-refused';
      const pointersBefore = await pointerCount();

      const violations = await violationsOf(
        repoA.createAgentWithFirstVersion({
          ...created(name),
          agentCreatedAudit: audit({ actorLabel: '   ' }),
        }),
      );

      expect(violations).toContainEqual({
        code: '23514',
        constraint: 'audit_events_actor_label_not_blank',
      });
      expect(
        await isolated.db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.workspaceId, workspaceA), eq(agents.name, name))),
      ).toEqual([]);
      expect(
        await isolated.db
          .select({ id: agentVersions.id })
          .from(agentVersions)
          .where(eq(agentVersions.summary, name)),
      ).toEqual([]);
      expect(await pointerCount()).toBe(pointersBefore);
      expect(await createdRows(name)).toEqual([]);
    });

    it('writes exactly one agent-created row naming the agent, version 1 and the run', async () => {
      const name = 'born-audited';

      const result = await repoA.createAgentWithFirstVersion({
        ...created(name),
        agentCreatedAudit: audit(),
      });

      if (result.kind !== 'created') throw new Error(`expected created, got ${result.kind}`);
      expect(await createdRows(name)).toMatchObject([
        {
          subjectId: result.agent.id,
          actorPrincipalId: principalA,
          actorUserId: userA,
          actorLabel: 'Owner A',
          details: { agentId: result.agent.id, version: 1, via: 'builder', builderRunId: 'run-1' },
        },
      ]);
    });

    it('writes no agent-created row without the input', async () => {
      const name = 'born-unaudited';

      const result = await repoA.createAgentWithFirstVersion(created(name));

      expect(result.kind).toBe('created');
      expect(await createdRows(name)).toEqual([]);
    });
  });

  it('answers unknown-creator-agent, writing nothing, when the lineage names no agent or is half set (#1851)', async () => {
    const creatorId = await seedAgent('lineage-creator');
    const lineage = { agentId: creatorId, version: 1, runId: 'run-1' };
    const cases = [
      { label: 'no-agent', createdByAgent: { ...lineage, agentId: crypto.randomUUID() } },
      // The run id missing while the version is set: only agents_created_by_agent_lineage_check refuses it.
      {
        label: 'half-set',
        createdByAgent: { ...lineage, runId: undefined } as unknown as typeof lineage,
      },
    ];
    for (const { label, createdByAgent } of cases) {
      await expect(
        repoA.createAgentWithFirstVersion({
          agent: {
            ...materialise({ name: `lineage-${label}` }),
            ownerPrincipalId: principalA,
            createdBy: userA,
            createdByAgent,
          },
          version: {
            summary: `lineage-${label}`,
            via: 'builder',
            body: bodyWith(`lineage-${label}`),
            createdByPrincipalId: principalA,
          },
          environment: 'local',
        }),
      ).resolves.toEqual({ kind: 'unknown-creator-agent' });
      const left = await isolated.db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceA), eq(agents.name, `lineage-${label}`)));
      expect(left).toEqual([]);
    }
  });

  it('answers unknown-principal, writing nothing, when the owner or the author is not of this workspace', async () => {
    const stranger = crypto.randomUUID();
    const cases = [
      { label: 'owner-b', owner: principalB, author: principalA },
      { label: 'author-b', owner: principalA, author: principalB },
      { label: 'author-unknown', owner: principalA, author: stranger },
    ];
    for (const { label, owner, author } of cases) {
      await expect(
        repoA.createAgentWithFirstVersion({
          agent: {
            ...materialise({ name: `stranger-${label}` }),
            ownerPrincipalId: owner,
            createdBy: userA,
          },
          version: {
            summary: `stranger-${label}`,
            via: 'api',
            body: bodyWith(`stranger-${label}`),
            createdByPrincipalId: author,
          },
          environment: 'local',
        }),
      ).resolves.toEqual({ kind: 'unknown-principal' });
      const left = await isolated.db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceA), eq(agents.name, `stranger-${label}`)));
      expect(left).toEqual([]);
    }
  });

  it('keeps an author’s versions when their membership is removed, refusing the removal (RF-202)', async () => {
    // A Builder who owns no agent writes a version of an agent someone else owns. Removing that
    // member must not erase or rewrite the immutable history: the author FK refuses the removal,
    // as `agents_owner_principal_workspace_fk` and the other owner FKs do until RF-202 defines
    // offboarding and reassignment.
    const builderUser = crypto.randomUUID();
    const builderMembership = crypto.randomUUID();
    const builderPrincipal = crypto.randomUUID();
    await isolated.db
      .insert(users)
      .values({ id: builderUser, email: `${builderUser}@example.test`, name: 'Builder A' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({
        id: builderMembership,
        workspaceId: workspaceA,
        userId: builderUser,
        role: 'builder',
      });
      await tx.insert(workspacePrincipals).values({
        id: builderPrincipal,
        workspaceId: workspaceA,
        kind: 'membership',
        membershipId: builderMembership,
      });
    });
    const agentId = await seedAgent('authored-by-builder');
    const authored = await repoA.create(agentId, {
      summary: 'builder change',
      via: 'ui',
      body: bodyWith(),
      createdByPrincipalId: builderPrincipal,
    });
    if (authored.kind !== 'created') throw new Error(`expected created, got ${authored.kind}`);

    const violations = await violationsOf(
      isolated.db.delete(memberships).where(eq(memberships.id, builderMembership)),
    );
    expect(violations.map((violation) => [violation.code, violation.constraint])).toContainEqual([
      '23503',
      'agent_versions_created_by_principal_workspace_fk',
    ]);
    await expect(repoA.find(agentId, 1)).resolves.toMatchObject({
      id: authored.version.id,
      createdByPrincipalId: builderPrincipal,
    });
  });

  it('#504: a null runtime profile name resolves to the workspace default at apply time, else none', async () => {
    // A workspace of its own, so the default set here cannot leak into the other cases above.
    const workspaceC = crypto.randomUUID();
    const userC = crypto.randomUUID();
    const membershipC = crypto.randomUUID();
    const principalC = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceC, slug: 'versions-c', name: 'Versions C' });
    await isolated.db
      .insert(users)
      .values({ id: userC, email: `${userC}@example.test`, name: 'Owner C' });
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipC, workspaceId: workspaceC, userId: userC, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalC,
        workspaceId: workspaceC,
        kind: 'membership',
        membershipId: membershipC,
      });
    });
    const scopeC = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceC,
    );
    if (scopeC === null) throw new Error('workspace C did not resolve');
    const repoC = createDatabaseAgentVersionRepositoryProvider(isolated.db).forScope(scopeC);
    const profilesC = createDatabaseRuntimeProfileRepositoryProvider(isolated.db).forScope(scopeC);
    const references = {
      modelConnectionName: null,
      runtimeProfileName: null,
      skills: [],
      connectors: [],
      files: [],
    } as const;

    // No default chosen: none, exactly as before #504 — and never reported missing.
    await expect(repoC.resolveDefinition(references)).resolves.toEqual({
      kind: 'resolved',
      references: NO_REFERENCES,
    });

    const heavy = await profilesC.create({
      name: 'heavy',
      driver: 'docker',
      runtimeConnectionId: null,
      cpu: 4,
      memoryMb: null,
      diskMb: null,
      networkPolicy: 'restricted',
      allowedDomains: null,
      filesystem: 'read-write',
      persistPaths: null,
      timeoutSeconds: null,
      idleTimeoutSeconds: null,
      driverConfig: null,
    });
    if (heavy.kind !== 'created') throw new Error(`expected created, got ${heavy.kind}`);
    const ensured = await profilesC.ensureWorkspaceDefault(
      {
        name: 'local',
        driver: 'local',
        runtimeConnectionId: null,
        cpu: null,
        memoryMb: null,
        diskMb: null,
        networkPolicy: 'open',
        allowedDomains: null,
        filesystem: 'read-write',
        persistPaths: null,
        timeoutSeconds: null,
        idleTimeoutSeconds: null,
        driverConfig: null,
      },
      { adoptable: () => true },
    );
    if (ensured.kind !== 'created') throw new Error(`expected created, got ${ensured.kind}`);
    const localId = ensured.profile.id;

    const resolved = await repoC.resolveDefinition(references);
    expect(resolved).toEqual({
      kind: 'resolved',
      references: { ...NO_REFERENCES, runtimeProfileId: localId },
    });
    if (resolved.kind !== 'resolved') return;
    // A named profile wins over the default, and an unknown name is still missing.
    await expect(
      repoC.resolveDefinition({ ...references, runtimeProfileName: 'heavy' }),
    ).resolves.toMatchObject({
      kind: 'resolved',
      references: { runtimeProfileId: heavy.profile.id },
    });
    await expect(
      repoC.resolveDefinition({ ...references, runtimeProfileName: 'nowhere' }),
    ).resolves.toEqual({
      kind: 'unresolved',
      missing: [{ kind: 'runtime-profile', name: 'nowhere' }],
      ambiguous: [],
    });
    // Workspace A has no default, whatever workspace C chose.
    await expect(repoA.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'resolved',
      references: { runtimeProfileId: null },
    });

    // Both materialising paths store the concrete profile id.
    const created = await repoC.createAgentWithFirstVersion({
      agent: {
        ...materialise({ name: 'defaulted', references: resolved.references }),
        ownerPrincipalId: principalC,
        createdBy: userC,
      },
      version: {
        summary: 'first',
        via: 'aw-push',
        body: bodyWith(),
        createdByPrincipalId: principalC,
      },
      environment: 'local',
    });
    if (created.kind !== 'created') throw new Error(`expected created, got ${created.kind}`);
    expect(created.agent.runtimeProfileId).toBe(localId);

    const second = await repoC.create(created.agent.id, {
      summary: 'second',
      via: 'aw-push',
      body: bodyWith(),
      createdByPrincipalId: principalC,
    });
    if (second.kind !== 'created') throw new Error(`expected created, got ${second.kind}`);
    await isolated.db
      .update(agents)
      .set({ runtimeProfileId: null })
      .where(eq(agents.id, created.agent.id));
    const applied = await repoC.applyAndPoint(created.agent.id, {
      reason: 'set',
      environment: 'local',
      number: 2,
      agent: materialise({ name: 'defaulted', references: resolved.references }),
      audit: auditBy({
        actorPrincipalId: principalC,
        actorUserId: userC,
        actorLabel: 'Owner C',
      }),
    });
    expect(applied).toMatchObject({
      kind: 'applied',
      agent: { id: created.agent.id, runtimeProfileId: localId },
    });

    // The default deleted between resolve and apply is the existing `reference-gone` race.
    const stale = await profilesC.create({
      name: 'stale',
      driver: 'docker',
      runtimeConnectionId: null,
      cpu: null,
      memoryMb: null,
      diskMb: null,
      networkPolicy: 'none',
      allowedDomains: null,
      filesystem: 'read-only',
      persistPaths: null,
      timeoutSeconds: null,
      idleTimeoutSeconds: null,
      driverConfig: null,
    });
    if (stale.kind !== 'created') throw new Error(`expected created, got ${stale.kind}`);
    await profilesC.delete(stale.profile.id);
    const staleApply = {
      reason: 'set',
      environment: 'local',
      number: 1,
      agent: materialise({
        name: 'defaulted',
        references: { ...NO_REFERENCES, runtimeProfileId: stale.profile.id },
      }),
      audit: auditBy({ actorPrincipalId: principalC, actorUserId: userC }),
    } as const;
    // #832: a row that has a profile keeps it, so the resolved default is not written at all.
    await expect(repoC.applyAndPoint(created.agent.id, staleApply)).resolves.toMatchObject({
      kind: 'applied',
      agent: { runtimeProfileId: localId },
    });
    // Only a row with none takes the default, and so meets the race.
    await isolated.db
      .update(agents)
      .set({ runtimeProfileId: null })
      .where(eq(agents.id, created.agent.id));
    await expect(repoC.applyAndPoint(created.agent.id, staleApply)).resolves.toEqual({
      kind: 'reference-gone',
      referenceKind: 'runtime-profile',
    });
  });
  it('#504 review: ensuring a default attaches it to agents applied while the workspace had none, and #786: a replaceable default hands them over', async () => {
    const workspaceD = crypto.randomUUID();
    const userD = crypto.randomUUID();
    const membershipD = crypto.randomUUID();
    const principalD = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceD, slug: 'versions-d', name: 'Versions D' });
    await isolated.db
      .insert(users)
      .values({ id: userD, email: `${userD}@example.test`, name: 'Owner D' });
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipD, workspaceId: workspaceD, userId: userD, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalD,
        workspaceId: workspaceD,
        kind: 'membership',
        membershipId: membershipD,
      });
    });
    const scopeD = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceD,
    );
    if (scopeD === null) throw new Error('workspace D did not resolve');
    const repoD = createDatabaseAgentVersionRepositoryProvider(isolated.db).forScope(scopeD);
    const profilesD = createDatabaseRuntimeProfileRepositoryProvider(isolated.db).forScope(scopeD);
    const localInput = {
      name: 'local',
      driver: 'local',
      runtimeConnectionId: null,
      cpu: null,
      memoryMb: null,
      diskMb: null,
      networkPolicy: 'open',
      allowedDomains: null,
      filesystem: 'read-write',
      persistPaths: null,
      timeoutSeconds: null,
      idleTimeoutSeconds: null,
      driverConfig: null,
    } as const;
    const bodyNaming = (name: string, runtimeProfileName: string | null): unknown => ({
      definition: { agent: { name, runtimeProfileName } },
      surfaces: [],
    });
    /** Push `name` as `aw push` does while the workspace has no default: the row gets no profile. */
    async function pushed(name: string, runtimeProfileName: string | null): Promise<string> {
      const created = await repoD.createAgentWithFirstVersion({
        agent: {
          ...materialise({ name, references: NO_REFERENCES }),
          ownerPrincipalId: principalD,
          createdBy: userD,
        },
        version: {
          summary: 'first',
          via: 'aw-push',
          body: bodyNaming(name, runtimeProfileName),
          createdByPrincipalId: principalD,
        },
        environment: 'local',
      });
      if (created.kind !== 'created') throw new Error(`expected created, got ${created.kind}`);
      return created.agent.id;
    }
    async function row(agentId: string) {
      const rows = await isolated.db
        .select({ runtimeProfileId: agents.runtimeProfileId, updatedAt: agents.updatedAt })
        .from(agents)
        .where(eq(agents.id, agentId));
      const found = rows[0];
      if (found === undefined) throw new Error('agent row missing');
      return found;
    }

    const unprofiled = await pushed('unprofiled', null);
    // Its version names a profile; its row is NULL because that profile is gone. Not ours to fill.
    const named = await pushed('named', 'heavy');
    // Edited by hand after its pointer moved: the row is no longer what the version materialised.
    const edited = await pushed('edited', null);
    await isolated.db
      .update(agents)
      .set({ instructions: 'Edited in the UI.', materialisedVersionId: null })
      .where(eq(agents.id, edited));
    const before = await row(unprofiled);
    expect(before.runtimeProfileId).toBeNull();

    const ensured = await profilesD.ensureWorkspaceDefault(localInput, { adoptable: () => true });
    if (ensured.kind !== 'created') throw new Error(`expected created, got ${ensured.kind}`);
    // Attached without moving `updated_at`, so `aw push` still reads it as unedited.
    await expect(row(unprofiled)).resolves.toEqual({
      runtimeProfileId: ensured.profile.id,
      updatedAt: before.updatedAt,
    });
    await expect(row(named)).resolves.toMatchObject({ runtimeProfileId: null });
    await expect(row(edited)).resolves.toMatchObject({ runtimeProfileId: null });

    // The default deleted (the foreign key sets the row to NULL) and ensured again on restart.
    await expect(profilesD.delete(ensured.profile.id)).resolves.toEqual({ kind: 'deleted' });
    await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: null });
    const again = await profilesD.ensureWorkspaceDefault(localInput, { adoptable: () => true });
    if (again.kind !== 'created') throw new Error(`expected created, got ${again.kind}`);
    await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: again.profile.id });

    // `kept` attaches too: an agent whose row lost the default is filled on the next ensure.
    await isolated.db.execute(
      sql`update agents set runtime_profile_id = null where id = ${unprofiled}`,
    );
    await expect(
      profilesD.ensureWorkspaceDefault(localInput, { adoptable: () => true }),
    ).resolves.toMatchObject({ kind: 'kept' });
    await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: again.profile.id });

    // #786: a caller that owns the default may replace it. The new default takes the mark and the
    // agents that carried the old one as the default; an agent set to it by hand stays.
    const pinned = await pushed('pinned', null);
    await isolated.db
      .update(agents)
      .set({ runtimeProfileId: again.profile.id, materialisedVersionId: null })
      .where(eq(agents.id, pinned));
    const dockerInput = { ...localInput, name: 'docker', driver: 'docker', diskMb: 1_024 } as const;
    const ownLocal = { adoptable: () => true, replaceable: () => true };
    await expect(
      profilesD.ensureWorkspaceDefault(dockerInput, { adoptable: () => true }),
    ).resolves.toMatchObject({ kind: 'kept', profile: { id: again.profile.id } });
    const docker = await profilesD.ensureWorkspaceDefault(dockerInput, ownLocal);
    if (docker.kind !== 'created') throw new Error(`expected created, got ${docker.kind}`);
    await expect(profilesD.findWorkspaceDefault()).resolves.toMatchObject({
      id: docker.profile.id,
    });
    await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: docker.profile.id });
    await expect(row(pinned)).resolves.toMatchObject({ runtimeProfileId: again.profile.id });
    await expect(row(named)).resolves.toMatchObject({ runtimeProfileId: null });

    // And back: the existing `local` profile is adopted, nothing new is created.
    const back = await profilesD.ensureWorkspaceDefault(localInput, ownLocal);
    expect(back).toMatchObject({ kind: 'adopted', profile: { id: again.profile.id } });
    await expect(row(unprofiled)).resolves.toMatchObject({ runtimeProfileId: again.profile.id });
    await expect(profilesD.list()).resolves.toHaveLength(2);
  });

  it('makes a console create wait for the creation lock, so the quota count cannot miss it', async () => {
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const scope = await resolver.forWorkspaceId(workspaceA);
    if (scope === null) throw new Error('workspace fixture did not resolve');
    const consoleAgents = createDatabaseAgentRepositoryProvider(isolated.db).forScope(scope);
    const order: string[] = [];
    let pending: Promise<unknown> = Promise.resolve();
    await isolated.db.transaction(async (tx) => {
      await lockAgentCreations(tx, workspaceA);
      pending = consoleAgents
        .create({
          name: 'console-waits-for-lock',
          instructions: '',
          modelConnectionId: null,
          model: null,
          permissions: READ_ONLY,
          ownerPrincipalId: principalA,
        })
        .then(() => order.push('created'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      order.push('lock released');
    });
    await pending;
    expect(order).toEqual(['lock released', 'created']);
  });
});
