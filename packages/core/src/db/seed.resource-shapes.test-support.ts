import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';

import type { Database } from './client.js';
import {
  createMembershipPrincipal,
  envelope,
  expectConstraintViolation,
} from './seed.fixture.test-support.js';
import { apiKeys } from './schema/api-keys.js';
import { auditEvents } from './schema/audit-events.js';
import { files } from './schema/files.js';
import { mcpServers } from './schema/mcp-servers.js';
import { secrets } from './schema/secrets.js';
import { skills } from './schema/skills.js';
import { users } from './schema/users.js';
import { workspaces } from './schema/workspaces.js';

/** The fabricated envelope the shape suite's own counterexample row is built from. */
const goodEnvelope = envelope(Buffer.from('not-really-encrypted'));

/** The workspace every shape case writes into. */
export interface ShapesOwner {
  workspaceId: string;
  /** `created_by` is tenant-paired to `memberships` (issue #117); every shape case needs a real
   *  member of `workspaceId` to attribute its inserts to. */
  ownerUserId: string;
  ownerPrincipalId: string;
}

export async function createShapesOwner(db: Database): Promise<ShapesOwner> {
  const [workspace] = await db
    .insert(workspaces)
    .values({ slug: 'shapes', name: 'Shapes' })
    .returning();
  if (workspace === undefined) throw new Error('could not create the shapes workspace');
  const [owner] = await db
    .insert(users)
    .values({ email: 'shapes-owner@example.test', name: 'Shapes Owner' })
    .returning();
  if (owner === undefined) throw new Error('could not create the shapes owner');
  const ownerPrincipalId = await createMembershipPrincipal(db, workspace.id, owner.id);
  return { workspaceId: workspace.id, ownerUserId: owner.id, ownerPrincipalId };
}

interface ShapesContext extends ShapesOwner {
  db: Database;
}

async function refusesShortNonce({ db, workspaceId }: ShapesContext): Promise<void> {
  await expectConstraintViolation(
    db.insert(secrets).values({
      workspaceId,
      name: 'ANTHROPIC_API_KEY',
      ...goodEnvelope,
      ciphertextNonce: Buffer.alloc(8, 5),
    }),
    'secrets_nonce_sizes',
  );

  const accepted = await db
    .insert(secrets)
    .values({ workspaceId, name: 'ANTHROPIC_API_KEY', ...goodEnvelope })
    .returning();
  expect(accepted).toHaveLength(1);
}

async function refusesBadSecretName({ db, workspaceId }: ShapesContext): Promise<void> {
  await expectConstraintViolation(
    db.insert(secrets).values({ workspaceId, name: 'github token', ...goodEnvelope }),
    'secrets_name_shape',
  );
}

async function refusesShortTag({ db, workspaceId }: ShapesContext): Promise<void> {
  await expectConstraintViolation(
    db.insert(secrets).values({
      workspaceId,
      name: 'AZURE_OPENAI_API_KEY',
      ...goodEnvelope,
      wrappedDataKeyTag: Buffer.alloc(4, 3),
    }),
    'secrets_tag_sizes',
  );
}

async function refusesShortDataKey({ db, workspaceId }: ShapesContext): Promise<void> {
  await expectConstraintViolation(
    db.insert(secrets).values({
      workspaceId,
      name: 'INTERNAL_DATABASE_TOKEN',
      ...goodEnvelope,
      wrappedDataKey: Buffer.alloc(16, 1),
    }),
    'secrets_wrapped_data_key_size',
  );
}

async function refusesMissingCredential(context: ShapesContext): Promise<void> {
  const { db, workspaceId, ownerUserId, ownerPrincipalId } = context;
  await expectConstraintViolation(
    db.insert(mcpServers).values({
      workspaceId,
      name: 'Unauthenticated bearer',
      transport: 'http',
      url: 'https://example.com/mcp',
      authType: 'bearer',
      createdBy: ownerUserId,
      ownerPrincipalId,
    }),
    'mcp_servers_credential_required',
  );

  const accepted = await db
    .insert(mcpServers)
    .values({
      workspaceId,
      name: 'Anonymous',
      transport: 'http',
      url: 'https://example.com/mcp',
      authType: 'none',
      createdBy: ownerUserId,
      ownerPrincipalId,
    })
    .returning();
  expect(accepted).toHaveLength(1);
}

async function refusesStdioUrl(context: ShapesContext): Promise<void> {
  const { db, workspaceId, ownerUserId, ownerPrincipalId } = context;
  await expectConstraintViolation(
    db.insert(mcpServers).values({
      workspaceId,
      name: 'Confused transport',
      transport: 'stdio',
      command: 'npx',
      url: 'https://example.com/mcp',
      createdBy: ownerUserId,
      ownerPrincipalId,
    }),
    'mcp_servers_remote_has_url',
  );

  const accepted = await db
    .insert(mcpServers)
    .values({
      workspaceId,
      name: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
      createdBy: ownerUserId,
      ownerPrincipalId,
    })
    .returning();
  expect(accepted).toHaveLength(1);
  expect(accepted[0]?.args).toEqual([
    '-y',
    '@modelcontextprotocol/server-filesystem',
    '/workspace',
  ]);
}

async function refusesClimbingPath(context: ShapesContext): Promise<void> {
  const { db, workspaceId, ownerUserId, ownerPrincipalId } = context;
  await expectConstraintViolation(
    db.insert(files).values({
      workspaceId,
      path: '../etc/passwd',
      kind: 'file',
      storageKey: 'x',
      objectId: crypto.randomUUID(),
      createdBy: ownerUserId,
      ownerPrincipalId,
    }),
    'files_path_no_dot_segments',
  );

  const accepted = await db
    .insert(files)
    .values({
      workspaceId,
      path: 'contracts/pricing.xlsx',
      kind: 'file',
      storageKey: 'x',
      objectId: crypto.randomUUID(),
      createdBy: ownerUserId,
      ownerPrincipalId,
    })
    .returning();
  expect(accepted).toHaveLength(1);
}

async function refusesMismatchedStorage(context: ShapesContext): Promise<void> {
  const { db, workspaceId, ownerUserId, ownerPrincipalId } = context;
  await expectConstraintViolation(
    db.insert(files).values({
      workspaceId,
      path: 'orphan.md',
      kind: 'file',
      objectId: crypto.randomUUID(),
      createdBy: ownerUserId,
      ownerPrincipalId,
    }),
    'files_storage_key_iff_file',
  );
  await expectConstraintViolation(
    db.insert(files).values({
      workspaceId,
      path: 'contracts',
      kind: 'folder',
      storageKey: 'x',
      createdBy: ownerUserId,
      ownerPrincipalId,
    }),
    'files_storage_key_iff_file',
  );

  const accepted = await db
    .insert(files)
    .values({
      workspaceId,
      path: 'contracts',
      kind: 'folder',
      createdBy: ownerUserId,
      ownerPrincipalId,
    })
    .returning();
  expect(accepted).toHaveLength(1);
}

async function refusesBadSkillName(context: ShapesContext): Promise<void> {
  const { db, workspaceId, ownerUserId, ownerPrincipalId } = context;
  await expectConstraintViolation(
    db.insert(skills).values({
      workspaceId,
      name: 'Invoice Review',
      skillMd: '# x',
      createdBy: ownerUserId,
      ownerPrincipalId,
    }),
    'skills_name_shape',
  );

  const accepted = await db
    .insert(skills)
    .values({
      workspaceId,
      name: 'invoice-review',
      skillMd: '# x',
      createdBy: ownerUserId,
      ownerPrincipalId,
    })
    .returning();
  expect(accepted).toHaveLength(1);
}

async function refusesUnknownApiKeyRole({ db, workspaceId }: ShapesContext): Promise<void> {
  await expectConstraintViolation(
    db.execute(
      sql`insert into ${apiKeys} (workspace_id, name, role, key_prefix, key_hash) values (${workspaceId}, 'CI', 'superuser', 'ak_live_', 'hash')`,
    ),
    'api_keys_role_valid',
  );

  const accepted = await db
    .insert(apiKeys)
    .values({
      workspaceId,
      name: 'CI',
      role: 'builder',
      keyPrefix: 'ak_live_',
      keyHash: 'a-hash-nobody-can-present',
    })
    .returning();
  expect(accepted).toHaveLength(1);
}

async function refusesUnknownAuditAction({ db, workspaceId }: ShapesContext): Promise<void> {
  await expectConstraintViolation(
    db.execute(
      sql`insert into ${auditEvents} (workspace_id, actor_label, action, subject_label) values (${workspaceId}, 'Ito', 'agent-exfiltrated', 'Customer Support Agent')`,
    ),
    'audit_events_action_valid',
  );

  const accepted = await db
    .insert(auditEvents)
    .values({
      workspaceId,
      actorLabel: 'Ito',
      action: 'agent-changed',
      subjectLabel: 'Customer Support Agent',
    })
    .returning();
  expect(accepted).toHaveLength(1);
}

async function keepsAuditLabelsAfterActorDeleted({
  db,
  workspaceId,
}: ShapesContext): Promise<void> {
  // §36 audits "user deleted", so a trail that forbade deleting an audited user would forbid
  // the action it exists to record. The link goes NULL; the stored labels still read.
  const [actor] = await db
    .insert(users)
    .values({ email: 'ito@example.com', name: 'Ito' })
    .returning();
  if (actor === undefined) throw new Error('could not create the actor');
  await db.insert(auditEvents).values({
    workspaceId,
    actorUserId: actor.id,
    actorLabel: 'Ito',
    action: 'agent-changed',
    subjectLabel: 'Customer Support Agent',
  });

  await db.delete(users).where(eq(users.id, actor.id));

  const [row] = await db.select().from(auditEvents);
  expect(row?.actorUserId).toBeNull();
  expect(row?.actorLabel).toBe('Ito');
  expect(row?.subjectLabel).toBe('Customer Support Agent');
}

export function registerResourceShapeCases(current: () => ShapesContext): void {
  it('refuses a secret whose nonce is not 12 bytes', () => refusesShortNonce(current()));
  it('refuses a secret whose authentication tag is not 16 bytes', () => refusesShortTag(current()));
  it('refuses a secret whose wrapped data key is not an AES-256 key', () =>
    refusesShortDataKey(current()));
  it('refuses a secret whose name is not environment-variable shaped', () =>
    refusesBadSecretName(current()));
  it('refuses a connector that claims an authentication it stores no credential for', () =>
    refusesMissingCredential(current()));
  it('refuses a stdio connector that carries a URL', () => refusesStdioUrl(current()));
  it('refuses a file path that climbs out of the workspace', () => refusesClimbingPath(current()));
  it('refuses a file row with no object behind it, and a folder with one', () =>
    refusesMismatchedStorage(current()));
  it('refuses a skill whose name would not be a directory name', () =>
    refusesBadSkillName(current()));
  it('refuses an API key whose role is outside the four of §21', () =>
    refusesUnknownApiKeyRole(current()));
  it('refuses an audit action outside the list §36 prints', () =>
    refusesUnknownAuditAction(current()));
  it('keeps an audit line readable after the actor is deleted', () =>
    keepsAuditLabelsAfterActorDeleted(current()));
}
