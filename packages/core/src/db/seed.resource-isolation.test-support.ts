import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';

import type { Database } from './client.js';
import {
  envelope,
  expectConstraintViolation,
  seedTenantBase,
  type TenantBase,
} from './seed.fixture.test-support.js';
import { agentFiles } from './schema/agent-files.js';
import { agentMcpServers } from './schema/agent-mcp-servers.js';
import { agentSkills } from './schema/agent-skills.js';
import { files } from './schema/files.js';
import { mcpServers } from './schema/mcp-servers.js';
import { secrets } from './schema/secrets.js';
import { skills } from './schema/skills.js';
import { workspaces } from './schema/workspaces.js';

/** One workspace with one of every resource this task added. */
export interface ResourceTenant extends TenantBase {
  skillId: string;
  fileId: string;
  secretId: string;
  mcpServerId: string;
}

async function insertSkillFileAndSecret(db: Database, slug: string, base: TenantBase) {
  const [skill] = await db
    .insert(skills)
    .values({
      workspaceId: base.workspaceId,
      name: 'invoice-review',
      skillMd: '---\nname: invoice-review\n---\n\nReview invoices.\n',
      createdBy: base.userId,
      ownerPrincipalId: base.principalId,
    })
    .returning();
  const [file] = await db
    .insert(files)
    .values({
      workspaceId: base.workspaceId,
      path: 'contracts/agreement.pdf',
      kind: 'file',
      storageKey: `${slug}/contracts/agreement.pdf`,
      objectId: crypto.randomUUID(),
      sizeBytes: 1024,
      contentType: 'application/pdf',
      createdBy: base.userId,
      ownerPrincipalId: base.principalId,
    })
    .returning();
  const [secret] = await db
    .insert(secrets)
    .values({
      workspaceId: base.workspaceId,
      name: 'GITHUB_TOKEN',
      ...envelope(Buffer.alloc(24, 4)),
    })
    .returning();
  if (skill === undefined || file === undefined || secret === undefined) {
    throw new Error(`could not populate the ${slug} tenant`);
  }
  return { skillId: skill.id, fileId: file.id, secretId: secret.id };
}

export async function createResourceTenant(
  db: Database,
  slug: string,
  email: string,
): Promise<ResourceTenant> {
  const base = await seedTenantBase(db, slug, email);
  const resources = await insertSkillFileAndSecret(db, slug, base);
  const [server] = await db
    .insert(mcpServers)
    .values({
      workspaceId: base.workspaceId,
      name: 'GitHub',
      transport: 'http',
      url: 'https://example.com/mcp',
      authType: 'bearer',
      credentialSecretId: resources.secretId,
      createdBy: base.userId,
      ownerPrincipalId: base.principalId,
    })
    .returning();
  if (server === undefined) throw new Error(`could not create the ${slug} connector`);
  return { ...base, ...resources, mcpServerId: server.id };
}

/** The connection and the two resource tenants an isolation case runs against. */
interface ResourceIsolationContext {
  db: Database;
  a: ResourceTenant;
  b: ResourceTenant;
}

async function refusesForeignSkill({ db, a, b }: ResourceIsolationContext): Promise<void> {
  await expectConstraintViolation(
    db.execute(
      sql`insert into ${agentSkills} (workspace_id, agent_id, skill_id) values (${a.workspaceId}, ${a.agentId}, ${b.skillId})`,
    ),
    'agent_skills_skill_workspace_fk',
  );

  const accepted = await db
    .insert(agentSkills)
    .values({ workspaceId: a.workspaceId, agentId: a.agentId, skillId: a.skillId })
    .returning();
  expect(accepted).toHaveLength(1);
}

async function refusesForeignConnector({ db, a, b }: ResourceIsolationContext): Promise<void> {
  await expectConstraintViolation(
    db.execute(
      sql`insert into ${agentMcpServers} (workspace_id, agent_id, mcp_server_id) values (${a.workspaceId}, ${a.agentId}, ${b.mcpServerId})`,
    ),
    'agent_mcp_servers_server_workspace_fk',
  );

  const accepted = await db
    .insert(agentMcpServers)
    .values({ workspaceId: a.workspaceId, agentId: a.agentId, mcpServerId: a.mcpServerId })
    .returning();
  expect(accepted).toHaveLength(1);
}

async function refusesForeignFile({ db, a, b }: ResourceIsolationContext): Promise<void> {
  await expectConstraintViolation(
    db.execute(
      sql`insert into ${agentFiles} (workspace_id, agent_id, file_id, access) values (${a.workspaceId}, ${a.agentId}, ${b.fileId}, 'read')`,
    ),
    'agent_files_file_workspace_fk',
  );

  const accepted = await db
    .insert(agentFiles)
    .values({
      workspaceId: a.workspaceId,
      agentId: a.agentId,
      fileId: a.fileId,
      access: 'read-write',
    })
    .returning();
  expect(accepted).toHaveLength(1);
}

async function refusesBorrowedSecret({ db, a, b }: ResourceIsolationContext): Promise<void> {
  await expectConstraintViolation(
    db.insert(mcpServers).values({
      workspaceId: a.workspaceId,
      name: 'Borrowed credential',
      transport: 'sse',
      url: 'https://example.com/mcp/sse',
      authType: 'api-key',
      credentialSecretId: b.secretId,
      createdBy: a.userId,
      ownerPrincipalId: a.principalId,
    }),
    'mcp_servers_credential_secret_workspace_fk',
  );

  const accepted = await db
    .insert(mcpServers)
    .values({
      workspaceId: a.workspaceId,
      name: 'Own credential',
      transport: 'sse',
      url: 'https://example.com/mcp/sse',
      authType: 'api-key',
      credentialSecretId: a.secretId,
      createdBy: a.userId,
      ownerPrincipalId: a.principalId,
    })
    .returning();
  expect(accepted).toHaveLength(1);
  expect(accepted[0]?.credentialSecretId).toBe(a.secretId);
}

async function refusesDeletingUsedSecret({ db, a }: ResourceIsolationContext): Promise<void> {
  // `ON DELETE RESTRICT` on the tenant-paired reference. The alternative — cascade, or set
  // null — is a connector that silently stops authenticating.
  await expectConstraintViolation(
    db.delete(secrets).where(eq(secrets.id, a.secretId)),
    'mcp_servers_credential_secret_workspace_fk',
  );

  // Detach the connector and the same delete is accepted, so the constraint is proved to
  // reject the dangerous statement rather than every statement.
  await db
    .update(mcpServers)
    .set({ authType: 'none', credentialSecretId: null })
    .where(eq(mcpServers.id, a.mcpServerId));
  await db.delete(secrets).where(eq(secrets.id, a.secretId));
  expect(await db.select().from(secrets).where(eq(secrets.id, a.secretId))).toEqual([]);
}

async function deletesWorkspaceResources({ db, a, b }: ResourceIsolationContext): Promise<void> {
  await db.delete(workspaces).where(eq(workspaces.id, a.workspaceId));

  expect(await db.select().from(skills).where(eq(skills.workspaceId, a.workspaceId))).toEqual([]);
  expect(await db.select().from(files).where(eq(files.workspaceId, a.workspaceId))).toEqual([]);
  expect(
    await db.select().from(mcpServers).where(eq(mcpServers.workspaceId, a.workspaceId)),
  ).toEqual([]);
  expect(await db.select().from(secrets).where(eq(secrets.workspaceId, a.workspaceId))).toEqual([]);
  // B is untouched.
  const survivors = await db.select().from(workspaces);
  expect(survivors.map((row) => row.id)).toEqual([b.workspaceId]);
}

export function registerResourceIsolationCases(current: () => ResourceIsolationContext): void {
  it("refuses to assign another workspace's skill to an agent", () =>
    refusesForeignSkill(current()));
  it("refuses to assign another workspace's connector to an agent", () =>
    refusesForeignConnector(current()));
  it("refuses to grant an agent another workspace's file", () => refusesForeignFile(current()));
  it("refuses a connector authenticating with another workspace's secret", () =>
    refusesBorrowedSecret(current()));
  it('refuses to delete a secret a connector still authenticates with', () =>
    refusesDeletingUsedSecret(current()));
  it('deletes a whole workspace and takes its resources with it', () =>
    deletesWorkspaceResources(current()));
}
