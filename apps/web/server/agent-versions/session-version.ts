/**
 * The version a conversation runs (issue #612; ADR-0101): a session pins the version an environment
 * points at when its row is inserted, and every run of that session composes from the pinned
 * version, never from the `agents` row, which is `local`'s working copy and moves with every
 * `aw push` and console edit.
 *
 * {@link resolveSessionVersion} is Lean `startSession`
 * (`formal/AgentWorkspace/Concepts/Release.lean`), replayed by
 * `apps/web/formal/release-sessions.test.ts`. The rest is the I/O around it.
 */
import {
  narrowFileGrants,
  type AgentVersionEnvironment,
  type AgentVersionPointerRecord,
  type AgentVersionRecord,
  type AgentVersionRepository,
  type ResolveDefinitionOutcome,
} from '@agent-workspace/core/db';
import type {
  AGENT_VERSION_PROBLEM_CODES,
  AgentVersionToolBundle,
} from '@indx-workspace/contracts/agent-versions';
import type {
  AgentDefinition,
  AgentPermissions,
  AgentResourceAssignments,
} from '@indx-workspace/contracts/agents';

import type { AgentRecord } from '../agents/contract';
import type { AgentResourceStoreProvider } from '../agents/resource-store';
import type { AgentStoreProvider } from '../agents/store';
import { engineForStoredPolicy } from '../engines/session-engine';
import { DomainError } from '../errors';
import { toAgentVersionResource } from './contract';
import { materialise } from './materialise';
import { definitionReferences } from './pipeline';

export type SessionVersionDecision<V> =
  | { readonly kind: 'pin'; readonly version: V }
  | { readonly kind: 'refused'; readonly code: 'session_already_started' | 'no_pointer' };

/**
 * Lean `startSession`, in its order: a started session is never re-pinned, an environment with no
 * pointer has nothing to pin, and otherwise the session pins the pointer.
 */
export function resolveSessionVersion<V>(
  started: boolean,
  pointer: V | null,
): SessionVersionDecision<V> {
  if (started) return { kind: 'refused', code: 'session_already_started' };
  if (pointer === null) return { kind: 'refused', code: 'no_pointer' };
  return { kind: 'pin', version: pointer };
}

/**
 * The `agent_version_id` a new session stores: the version `environment` points at.
 *
 * `session_already_started` is `SessionRepository.ensure` answering `existing` unchanged, so every
 * caller asks for a session that has not started. `no_pointer` departs from the model: an agent
 * with no pointer is a legacy, unversioned agent, and its session stores `null` and runs from the
 * row instead of being refused (`docs/formal/domains/release.md`).
 */
export function versionToPin(
  pointers: readonly AgentVersionPointerRecord[],
  environment: AgentVersionEnvironment,
): string | null {
  const pointer = pointers.find((each) => each.environment === environment)?.versionId ?? null;
  const decision = resolveSessionVersion(false, pointer);
  return decision.kind === 'pin' ? decision.version : null;
}

/** The engine a version runs on: its stored policy's, or the default for a compiled one. */
export function engineOfVersion(record: AgentVersionRecord): string {
  const { definition } = toAgentVersionResource(record).body;
  return engineForStoredPolicy(definition.policySource === 'stored' ? definition.policy : null);
}

/** One subagent of a run (ADR-0133 D14), resolved from the version its parent's environment points at. */
export interface RunSubagent {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly model: string | null;
  readonly permissions: AgentPermissions;
  /** Its own stored policy, whose withholding narrows `permissions` at compose. */
  readonly policy: AgentRecord['policy'];
}

/** What a run composes from: the agent's configuration and its resource assignments. */
export interface RunAgent {
  readonly agent: AgentRecord;
  readonly assignments: AgentResourceAssignments;
  /** The code tools' bundles the version pins (ADR-0118 TS1); empty for a legacy session. */
  readonly toolBundles: readonly AgentVersionToolBundle[];
  /** Empty for a legacy session, which has no version body to name any. */
  readonly subagents: readonly RunSubagent[];
}

/**
 * The agent as version `record` runs it: the row keeps the identity (id, owner, timestamps), and
 * everything a version sets comes from the version, materialised in memory with today's ids. A
 * name the workspace no longer resolves refuses the run with the code a pointer move answers.
 */
export async function runAgentFromVersion(
  row: AgentRecord,
  record: AgentVersionRecord,
  versions: Pick<AgentVersionRepository, 'resolveDefinition' | 'list' | 'agentsByName'>,
): Promise<RunAgent> {
  const { definition, toolBundles, subagents } = toAgentVersionResource(record).body;
  const resolution = await versions.resolveDefinition(definitionReferences(definition));
  if (resolution.kind === 'unresolved') throw unresolvedVersion(record, resolution);
  const materialised = materialise(definition, resolution.references, definition.policy);
  const { references } = materialised;
  return {
    agent: {
      ...row,
      name: materialised.name,
      instructions: materialised.instructions,
      model: materialised.model,
      permissions: materialised.permissions,
      policy: materialised.policy,
      modelConnectionId: references.modelConnectionId,
      runtimeProfileId: references.runtimeProfileId,
    },
    assignments: {
      files: narrowFileGrants(references.files, materialised.permissions),
      skillIds: references.skillIds,
      connectorIds: references.connectorIds,
    },
    toolBundles: toolBundles ?? [],
    subagents: await resolveSubagents(
      row.id,
      record,
      (subagents ?? []).map((subagent) => subagent.name),
      definition,
      materialised.permissions,
      versions,
    ),
  };
}

function subagentUnusable(name: string, reason: string): DomainError {
  return new DomainError({
    category: 'validation',
    code: 'agent_subagent_unusable',
    publicMessage: `agent_subagent_unusable: the subagent ${JSON.stringify(name)} ${reason}.`,
  });
}

/** The first resource `sub` is granted that `parent` is not, as `<kind>:<name>`; a file counts at its effective access. */
function ungrantedResource(
  sub: { definition: AgentDefinition; permissions: AgentPermissions },
  parent: { definition: AgentDefinition; permissions: AgentPermissions },
): string | null {
  const { resources } = sub.definition;
  const parentResources = parent.definition.resources;
  const connector = resources.connectors.find((name) => !parentResources.connectors.includes(name));
  if (connector !== undefined) return `connector:${connector}`;
  const skill = resources.skills.find((name) => !parentResources.skills.includes(name));
  if (skill !== undefined) return `skill:${skill}`;
  const effective = (grant: { access: string }, permissions: AgentPermissions) =>
    permissions.writeFiles ? grant.access : 'read';
  const file = resources.files.find(
    (grant) =>
      !parentResources.files.some(
        (held) =>
          held.path === grant.path &&
          (effective(held, parent.permissions) === 'read-write' ||
            effective(grant, sub.permissions) === 'read'),
      ),
  );
  return file === undefined ? null : `file:${file.path}`;
}

/**
 * Each subagent `names` the parent's version, as the version its environment points at: the
 * subagent's `production` pointer when the parent runs its own `production` version, else `local`.
 */
async function resolveSubagents(
  parentId: string,
  parentRecord: AgentVersionRecord,
  names: readonly string[],
  parentDefinition: AgentDefinition,
  parentPermissions: AgentPermissions,
  versions: Pick<AgentVersionRepository, 'resolveDefinition' | 'list' | 'agentsByName'>,
): Promise<readonly RunSubagent[]> {
  if (names.length === 0) return [];
  const parentPointers = (await versions.list(parentId))?.pointers ?? [];
  const environment: AgentVersionEnvironment =
    parentPointers.find((pointer) => pointer.environment === 'production')?.versionId ===
    parentRecord.id
      ? 'production'
      : 'local';
  const candidates = await versions.agentsByName(names);
  const resolved: RunSubagent[] = [];
  for (const name of names) {
    const candidate = candidates.get(name);
    if (candidate === undefined) throw subagentUnusable(name, 'is not an agent of this workspace');
    const listing = await versions.list(candidate.id);
    const versionId = listing?.pointers.find((each) => each.environment === environment)?.versionId;
    const record = listing?.versions.find((each) => each.id === versionId);
    if (record === undefined) {
      throw subagentUnusable(name, `has no version in the ${environment} environment`);
    }
    const body = toAgentVersionResource(record).body;
    const resolution = await versions.resolveDefinition(definitionReferences(body.definition));
    if (resolution.kind === 'unresolved') throw unresolvedVersion(record, resolution);
    const materialised = materialise(
      body.definition,
      resolution.references,
      body.definition.policy,
    );
    if ((body.subagents ?? []).length > 0) {
      throw subagentUnusable(name, 'declares subagents of its own (one level only)');
    }
    if (body.description === undefined) throw subagentUnusable(name, 'has no description');
    const ungranted = ungrantedResource(
      { definition: body.definition, permissions: materialised.permissions },
      { definition: parentDefinition, permissions: parentPermissions },
    );
    if (ungranted !== null) {
      throw subagentUnusable(name, `is granted ${ungranted} that the parent is not`);
    }
    resolved.push({
      name,
      description: body.description,
      instructions: materialised.instructions,
      model: materialised.model,
      permissions: materialised.permissions,
      policy: materialised.policy,
    });
  }
  return resolved;
}

function unresolvedVersion(
  record: AgentVersionRecord,
  resolution: Extract<ResolveDefinitionOutcome, { readonly kind: 'unresolved' }>,
): DomainError {
  const missing = resolution.missing.length > 0;
  const code: keyof typeof AGENT_VERSION_PROBLEM_CODES = missing
    ? 'agent_definition_references_missing'
    : 'agent_definition_reference_ambiguous';
  const references = missing ? resolution.missing : resolution.ambiguous;
  const names = references.map((reference) => `${reference.kind}:${reference.name}`).join(', ');
  return new DomainError({
    category: 'validation',
    code,
    publicMessage: `${code}: this conversation runs agent version ${String(record.number)}, which names ${names}; the workspace no longer resolves them. Start a new conversation.`,
  });
}

export interface RunAgentSources {
  readonly agents: AgentStoreProvider;
  readonly assignments: AgentResourceStoreProvider;
  /** One workspace's versions, or `null` when the workspace is gone. */
  readonly versions: (
    workspaceId: string,
  ) => Promise<Pick<
    AgentVersionRepository,
    'findById' | 'resolveDefinition' | 'list' | 'agentsByName'
  > | null>;
}

/**
 * Read what a run of `agentId` composes from: the pinned version's, or for a `null` pin (a legacy
 * session) the row and its assignments. Throws when the agent, or the pinned version, is gone.
 */
export function createRunAgentReader(
  sources: RunAgentSources,
): (workspaceId: string, agentId: string, agentVersionId: string | null) => Promise<RunAgent> {
  return async (workspaceId, agentId, agentVersionId) => {
    const row = await sources.agents.forWorkspace(workspaceId).get(agentId);
    if (row === null) {
      throw new Error(
        `agent ${agentId} is no longer in workspace ${workspaceId}; the run cannot be composed`,
      );
    }
    if (agentVersionId === null) {
      const assignments = await sources.assignments.forWorkspace(workspaceId).get(agentId);
      if (assignments === null) {
        throw new Error(`agent ${agentId} disappeared before its resources could be loaded`);
      }
      return { agent: row, assignments, toolBundles: [], subagents: [] };
    }
    const versions = await sources.versions(workspaceId);
    const record = versions === null ? null : await versions.findById(agentVersionId);
    if (versions === null || record === null || record.agentId !== agentId) {
      throw new Error(`agent version ${agentVersionId} of agent ${agentId} is gone`);
    }
    return runAgentFromVersion(row, record, versions);
  };
}
