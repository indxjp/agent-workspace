import crypto from 'node:crypto';

import type { Database } from '../client.js';
import { agents } from '../schema/agents.js';
import { files } from '../schema/files.js';
import { memberships } from '../schema/memberships.js';
import { modelConnections } from '../schema/model-connections.js';
import { runEvents } from '../schema/run-events.js';
import { runUsageRecords } from '../schema/run-usage-records.js';
import { runs } from '../schema/runs.js';
import { secrets } from '../schema/secrets.js';
import { sessionMessages } from '../schema/session-messages.js';
import { sessionTranscripts } from '../schema/session-transcripts.js';
import { sessions } from '../schema/sessions.js';
import { shareRunCharges } from '../schema/share-run-charges.js';
import { shares } from '../schema/shares.js';
import { users } from '../schema/users.js';
import { workspaces } from '../schema/workspaces.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';

export const RF001_DEFERRED_FIXTURES = {
  activeRuntimeAllocation: {
    prerequisite: 'RF-302',
    reason: 'runtime_allocations does not exist before its owning additive migration',
  },
  partialStorageOperation: {
    prerequisite: 'RF-304',
    reason: 'storage_operations does not exist before its owning additive migration',
  },
} as const;

export interface Rf001LegacyFixture {
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly departingUserId: string;
  readonly departingMembershipId: string;
  readonly usedAgentId: string;
  readonly unusedAgentId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly shareId: string;
  readonly modelConnectionId: string;
  readonly legacyModelCredentialName: string;
  readonly legacyRuntimeCredentialName: string;
  readonly partialFileState: {
    readonly fileId: string;
    readonly catalogStorageKey: string;
    readonly objectKeys: readonly string[];
  };
}

function syntheticEnvelope(marker: number) {
  return {
    algorithm: 'aes-256-gcm' as const,
    masterKeyId: 'rf001-synthetic-key',
    wrappedDataKey: Buffer.alloc(32, marker),
    wrappedDataKeyNonce: Buffer.alloc(12, marker),
    wrappedDataKeyTag: Buffer.alloc(16, marker),
    ciphertext: Buffer.from(`synthetic-${String(marker)}`),
    ciphertextNonce: Buffer.alloc(12, marker + 1),
    ciphertextTag: Buffer.alloc(16, marker + 1),
  };
}

/**
 * Install production-shaped legacy rows used by the dependency-ordered refactoring migrations.
 * Values are synthetic and deliberately contain no usable credential or customer content.
 */
export async function installRf001LegacyFixture(db: Database): Promise<Rf001LegacyFixture> {
  const workspaceId = crypto.randomUUID();
  const ownerUserId = crypto.randomUUID();
  const ownerMembershipId = crypto.randomUUID();
  const ownerPrincipalId = crypto.randomUUID();
  const departingUserId = crypto.randomUUID();
  const departingMembershipId = crypto.randomUUID();
  const departingPrincipalId = crypto.randomUUID();
  const usedAgentId = crypto.randomUUID();
  const unusedAgentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const shareId = crypto.randomUUID();
  const modelConnectionId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  // Reproduce two production-only naming conventions without importing server code into core:
  // `modelConnectionSecretName` in `apps/web/server/models/store.ts`, and the
  // `RUNTIME_CONNECTION__` prefix filter in `apps/web/server/runtimes/connections.ts`.
  const legacyModelCredentialName = `MODEL_CONNECTION_${modelConnectionId
    .replaceAll('-', '')
    .toUpperCase()}`;
  const legacyRuntimeCredentialName = 'RUNTIME_CONNECTION__DOCKER__RF001';
  const catalogStorageKey = `workspaces/${workspaceId}/files/${fileId}/original`;

  await db.insert(workspaces).values({
    id: workspaceId,
    slug: `rf001-${workspaceId.slice(0, 8)}`,
    name: 'RF-001 fixture',
  });
  await db.insert(users).values([
    { id: ownerUserId, email: `owner-${workspaceId}@example.test`, name: 'Fixture Owner' },
    {
      id: departingUserId,
      email: `departing-${workspaceId}@example.test`,
      name: 'Departing Member',
    },
  ]);
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values([
      { id: ownerMembershipId, workspaceId, userId: ownerUserId, role: 'owner' },
      {
        id: departingMembershipId,
        workspaceId,
        userId: departingUserId,
        role: 'builder',
      },
    ]);
    await tx.insert(workspacePrincipals).values([
      {
        id: ownerPrincipalId,
        workspaceId,
        kind: 'membership',
        membershipId: ownerMembershipId,
      },
      {
        id: departingPrincipalId,
        workspaceId,
        kind: 'membership',
        membershipId: departingMembershipId,
      },
    ]);
  });
  await db.insert(modelConnections).values({
    id: modelConnectionId,
    workspaceId,
    name: 'Legacy model connection',
    provider: 'anthropic',
    config: {},
  });
  await db.insert(secrets).values([
    {
      id: crypto.randomUUID(),
      workspaceId,
      name: legacyModelCredentialName,
      ...syntheticEnvelope(1),
    },
    {
      id: crypto.randomUUID(),
      workspaceId,
      name: legacyRuntimeCredentialName,
      ...syntheticEnvelope(3),
    },
  ]);
  await db.insert(agents).values([
    {
      id: usedAgentId,
      workspaceId,
      name: 'Used legacy Agent',
      instructions: '',
      createdBy: ownerUserId,
      ownerPrincipalId,
      modelConnectionId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    },
    {
      id: unusedAgentId,
      workspaceId,
      name: 'Unused legacy Agent',
      instructions: '',
      createdBy: ownerUserId,
      ownerPrincipalId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    },
  ]);
  await db.insert(sessions).values({
    id: sessionId,
    workspaceId,
    userId: departingUserId,
    ownerPrincipalId: departingPrincipalId,
    agentId: usedAgentId,
    title: 'Legacy durable history',
  });
  await db.insert(runs).values({ id: runId, workspaceId, sessionId });
  await db.insert(runEvents).values({
    runId,
    workspaceId,
    sequence: 1n,
    type: 'status',
    data: { status: 'queued' },
  });
  await db.insert(runUsageRecords).values({
    id: crypto.randomUUID(),
    workspaceId,
    runId,
    providerResponseId: `rf001-${runId}`,
    provider: 'anthropic',
    model: 'synthetic-model',
    inputTokens: 1,
    outputTokens: 1,
    costUsd: '0',
  });
  await db.insert(sessionTranscripts).values({
    workspaceId,
    projectKey: 'rf001',
    sessionId,
    subpath: '',
  });
  await db.insert(sessionMessages).values({
    workspaceId,
    projectKey: 'rf001',
    sessionId,
    subpath: '',
    sequence: 1n,
    position: 1n,
    entryUuid: 'rf001-message',
    entry: { type: 'user', message: { content: 'synthetic fixture' } },
  });
  await db.insert(shares).values({
    id: shareId,
    workspaceId,
    token: `rf001_${shareId}`,
    subjectType: 'agent',
    subjectId: usedAgentId,
    subjectLabel: 'Used legacy Agent',
    visibility: 'public',
    mode: 'runnable',
    include: {},
    budgetCapUsd: '1.0000',
    spentUsd: '0',
    createdBy: ownerUserId,
    publisherPrincipalId: ownerPrincipalId,
  });
  await db.insert(shareRunCharges).values({
    runId,
    workspaceId,
    shareId,
    chargedUsd: '0',
  });
  await db.insert(files).values({
    id: fileId,
    workspaceId,
    path: 'legacy/report.txt',
    kind: 'file',
    storageKey: catalogStorageKey,
    sizeBytes: 9,
    contentType: 'text/plain',
    createdBy: ownerUserId,
    ownerPrincipalId,
  });

  return {
    workspaceId,
    ownerUserId,
    departingUserId,
    departingMembershipId,
    usedAgentId,
    unusedAgentId,
    sessionId,
    runId,
    shareId,
    modelConnectionId,
    legacyModelCredentialName,
    legacyRuntimeCredentialName,
    partialFileState: {
      fileId,
      catalogStorageKey,
      objectKeys: [`${catalogStorageKey}-moved`],
    },
  };
}
