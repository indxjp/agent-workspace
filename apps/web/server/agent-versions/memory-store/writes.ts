import { AgentCreatedAuditDetailsSchema } from '@indx-workspace/contracts/observability';
import { toStoredPolicy } from '../../agents/store';
import type { MaterialisedAssignments, RecordedPointerAudit, SeededPointer } from './model';
import { agentWriteRefusal, createdAuditRow, distinctFolders, rowOf, toAssignments } from './rows';
import type { MemoryVersionWorkspace } from './workspace';
import {
  appliedRuntimeProfileId,
  type AgentVersionRecord,
  type ApplyAndPointOutcome,
  type CreateAgentVersionInput,
  type CreateAgentVersionOutcome,
  type CreateAgentWithFirstVersionOutcome,
  type WorkspaceAgentVersionStore,
} from '../store';

type ApplyInput = Parameters<WorkspaceAgentVersionStore['applyAndPoint']>[1];
type FirstInput = Parameters<WorkspaceAgentVersionStore['createAgentWithFirstVersion']>[0];
type FirstVersionSnapshot = Pick<FirstInput, 'agent' | 'version' | 'environment'>;
type FirstRefusal = Exclude<CreateAgentWithFirstVersionOutcome, { readonly kind: 'created' }>;
type LocalMove = {
  readonly agentId: string;
  readonly input: ApplyInput;
  readonly runtimeProfileId: string | null;
  readonly version: AgentVersionRecord;
  readonly pointed: SeededPointer;
  readonly audit: RecordedPointerAudit;
};

function pointerMoved(
  workspace: MemoryVersionWorkspace,
  agentId: string,
  input: ApplyInput,
): { kind: 'pointer-moved'; current: number | null } | null {
  const { pointers, workspaceId } = workspace;
  if (input.expectedVersion !== undefined) {
    const pointed =
      pointers.find(
        (row) =>
          row.workspaceId === workspaceId &&
          row.agentId === agentId &&
          row.environment === input.environment,
      )?.number ?? null;
    if (pointed !== input.expectedVersion) return { kind: 'pointer-moved', current: pointed };
  }
  return null;
}

async function applyLocalVersion(
  workspace: MemoryVersionWorkspace,
  move: LocalMove,
): Promise<ApplyAndPointOutcome> {
  const { agentId, input, runtimeProfileId, version, pointed, audit } = move;
  const {
    audits,
    assignments,
    writtenFrom,
    movePointer,
    agents,
    shareAssignments,
    recordGrantChange,
  } = workspace;
  const updated = await agents.update(agentId, {
    ...rowOf(input.agent),
    runtimeProfileId: appliedRuntimeProfileId(
      version.body,
      runtimeProfileId,
      input.agent.references.runtimeProfileId,
    ),
  });
  if (updated.kind !== 'updated') return agentWriteRefusal(updated);
  const withPolicy = await agents.replacePolicy(agentId, input.agent.policy);
  if (withPolicy.kind !== 'updated') {
    throw new Error(`the in-memory agent ${agentId} vanished during a materialisation`);
  }
  const written = toAssignments(input.agent);
  recordGrantChange(
    agentId,
    assignments.get(agentId)?.storageGrants ?? [],
    written.storageGrants,
    input.audit,
  );
  assignments.set(agentId, written);
  await shareAssignments(agentId, written);
  const pointer = movePointer(pointed, input.reason, input.audit.actorPrincipalId);
  writtenFrom.set(agentId, {
    versionId: version.id,
    agentUpdatedAt: withPolicy.agent.updatedAt.getTime(),
  });
  audits.push(audit);
  return {
    kind: 'applied',
    agent: { ...withPolicy.agent, policy: input.agent.policy },
    pointer,
  };
}

async function firstVersionRefusal(
  workspace: MemoryVersionWorkspace,
  input: FirstInput,
  snapshot: FirstVersionSnapshot,
): Promise<FirstRefusal | null> {
  const { agent: materialised, version: versionInput, environment } = snapshot;
  const {
    countCreatedSince,
    principalIsUnknown,
    agents,
    subagentNesting,
    takenSurfaceName,
    nameTaken,
  } = workspace;
  if (
    principalIsUnknown(materialised.ownerPrincipalId) ||
    principalIsUnknown(versionInput.createdByPrincipalId)
  ) {
    return { kind: 'unknown-principal' };
  }
  if (
    input.quota !== undefined &&
    (await countCreatedSince(agents, input.quota.since)) >= input.quota.limit
  ) {
    return { kind: 'quota-exceeded' };
  }
  const nesting = await subagentNesting(null, materialised.name, versionInput.body);
  if (nesting !== null) return nesting;
  if (await nameTaken(materialised.name, null)) {
    return { kind: 'name-conflict', name: materialised.name };
  }
  const taken = takenSurfaceName(null, versionInput.body, environment);
  if (taken !== null) return { kind: 'surface-name-taken', name: taken };

  return null;
}

function recordFirstVersion(
  workspace: MemoryVersionWorkspace,
  created: {
    readonly snapshot: FirstVersionSnapshot;
    readonly agentId: string;
    readonly first: MaterialisedAssignments;
    readonly agentUpdatedAt: number;
    readonly createdAudit: ReturnType<typeof createdAuditRow>;
  },
) {
  const { snapshot, agentId, first, agentUpdatedAt, createdAudit } = created;
  const { versions, audits, versionGrants, writtenFrom, now, newId, movePointer, workspaceId } =
    workspace;
  const { version: versionInput, environment } = snapshot;
  const version: AgentVersionRecord = {
    id: newId(),
    workspaceId,
    agentId,
    number: 1,
    summary: versionInput.summary,
    via: versionInput.via,
    body: versionInput.body,
    createdByPrincipalId: versionInput.createdByPrincipalId,
    createdAt: now(),
  };
  versions.push(version);
  versionGrants.set(version.id, first.storageGrants);
  writtenFrom.set(agentId, {
    versionId: version.id,
    agentUpdatedAt,
  });
  const pointer = movePointer(
    {
      workspaceId,
      agentId,
      environment,
      versionId: version.id,
      number: version.number,
      updatedAt: now(),
    },
    'set',
    versionInput.createdByPrincipalId,
  );
  if (createdAudit !== null) {
    audits.push({
      ...createdAudit,
      subjectId: agentId,
      // Parsed again with the real id; it cannot fail, as the same details passed above.
      details: AgentCreatedAuditDetailsSchema.parse({ ...createdAudit.details, agentId }),
    });
  }
  return { version, pointer };
}

async function createVersion(
  workspace: MemoryVersionWorkspace,
  agentId: string,
  input: CreateAgentVersionInput,
): Promise<CreateAgentVersionOutcome> {
  const {
    versions,
    versionGrants,
    now,
    newId,
    principalIsUnknown,
    workspaceId,
    agentExists,
    versionsOf,
  } = workspace;

  if (!(await agentExists(agentId))) return { kind: 'not-found' };
  if (principalIsUnknown(input.createdByPrincipalId)) return { kind: 'unknown-principal' };
  const number = Math.max(0, ...versionsOf(agentId).map((row) => row.number)) + 1;
  if (input.number !== undefined && input.number !== number) return { kind: 'number-taken' };
  const version: AgentVersionRecord = {
    id: newId(),
    workspaceId,
    agentId,
    number,
    summary: input.summary,
    via: input.via,
    body: input.body,
    createdByPrincipalId: input.createdByPrincipalId,
    createdAt: now(),
  };
  versions.push(version);
  versionGrants.set(version.id, distinctFolders(input.storageGrants ?? []));
  return { kind: 'created', version };
}

async function applyAndPoint(
  workspace: MemoryVersionWorkspace,
  agentId: string,
  input: ApplyInput,
): Promise<ApplyAndPointOutcome> {
  const {
    audits,
    now,
    movePointer,
    workspaceId,
    agents,
    versionsOf,
    subagentNesting,
    takenSurfaceName,
    nameTaken,
  } = workspace;

  const current = await agents.get(agentId);
  if (current === null) return { kind: 'not-found' };
  if (current.archivedAt !== undefined) return { kind: 'agent-archived' };
  const moved = pointerMoved(workspace, agentId, input);
  if (moved !== null) return moved;
  const version = versionsOf(agentId).find((row) => row.number === input.number);
  if (version === undefined) return { kind: 'version-not-found' };
  const rewritesRow = input.environment === 'local';
  if (rewritesRow) {
    const nesting = await subagentNesting(agentId, input.agent.name, version.body);
    if (nesting !== null) return nesting;
  }
  if (rewritesRow && (await nameTaken(input.agent.name, agentId))) {
    return { kind: 'name-conflict', name: input.agent.name };
  }
  const taken = takenSurfaceName(agentId, version.body, input.environment);
  if (taken !== null) return { kind: 'surface-name-taken', name: taken };
  const pointed: SeededPointer = {
    workspaceId,
    agentId,
    environment: input.environment,
    versionId: version.id,
    number: version.number,
    updatedAt: now(),
  };
  const audit: RecordedPointerAudit = {
    ...input.audit,
    workspaceId,
    action: 'agent-changed',
    subjectId: agentId,
  };
  if (!rewritesRow) {
    const pointer = movePointer(pointed, input.reason, input.audit.actorPrincipalId);
    audits.push(audit);
    const policy = current.policy === null ? null : toStoredPolicy(current.policy);
    return { kind: 'applied', agent: { ...current, policy }, pointer };
  }

  return applyLocalVersion(workspace, {
    agentId,
    input,
    runtimeProfileId: current.runtimeProfileId,
    version,
    pointed,
    audit,
  });
}

async function createAgentWithFirstVersion(
  workspace: MemoryVersionWorkspace,
  input: FirstInput,
): Promise<CreateAgentWithFirstVersionOutcome> {
  const { assignments, workspaceId, agents, shareAssignments, recordGrantChange } = workspace;

  const { agent: materialised, version: versionInput, environment } = input;
  // Keep the validated references even if the caller replaces input fields during a write.
  const snapshot: FirstVersionSnapshot = {
    agent: materialised,
    version: versionInput,
    environment,
  };
  const refusal = await firstVersionRefusal(workspace, input, snapshot);
  if (refusal !== null) return refusal;
  // Built and parsed before any write, so a refused row leaves nothing behind; the new agent's
  // id is filled in below, once the agent exists.
  const createdAudit = createdAuditRow(workspaceId, input);

  const created = await agents.create(rowOf(materialised), {
    principalId: materialised.ownerPrincipalId,
    userId: materialised.createdBy,
  });
  if (created.kind !== 'created') {
    const refusal = agentWriteRefusal(created);
    if (refusal.kind === 'not-found') {
      throw new Error('the in-memory agent store answered not-found to a create');
    }
    return refusal;
  }
  const agentId = created.agent.id;
  const withPolicy = await agents.replacePolicy(agentId, materialised.policy);
  if (withPolicy.kind !== 'updated') {
    throw new Error(`the in-memory agent ${agentId} vanished during its own create`);
  }
  const first = toAssignments(materialised);
  assignments.set(agentId, first);
  await shareAssignments(agentId, first);
  recordGrantChange(agentId, [], first.storageGrants, input.audit);
  const { version, pointer } = recordFirstVersion(workspace, {
    snapshot,
    agentId,
    first,
    agentUpdatedAt: withPolicy.agent.updatedAt.getTime(),
    createdAudit,
  });
  return {
    kind: 'created',
    agent: { ...withPolicy.agent, policy: materialised.policy },
    version,
    pointer,
  };
}

export function createMemoryVersionWrites(
  workspace: MemoryVersionWorkspace,
): Pick<WorkspaceAgentVersionStore, 'create' | 'applyAndPoint' | 'createAgentWithFirstVersion'> {
  return {
    create: (agentId, input) => createVersion(workspace, agentId, input),
    applyAndPoint: (agentId, input) => applyAndPoint(workspace, agentId, input),
    createAgentWithFirstVersion: (input) => createAgentWithFirstVersion(workspace, input),
  };
}
