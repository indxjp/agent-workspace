/**
 * A console edit is a version (issue #616; ADR-0101): the legacy `PATCH /api/agents/:id`,
 * `PUT …/policy` and `PUT …/resources` save the edited agent through the same two handlers
 * `aw push` calls — {@link createAgentVersion} with `via: 'ui'`, then {@link setAgentPointer} on
 * `local` — so a console edit can be rolled back and pulled, and there is no second write path.
 * Every validation, the engine-switch carry, the ceiling, the materialisation, the audit row and
 * `materialised_version_id` are theirs; nothing here restates them.
 *
 * ## The body the edit lands on
 *
 * - The `local` version's body when the agent row is still materialised from it, the normal case
 *   once an agent is versioned. Only the edited fields change, so a pulled file changes only where
 *   the console edited it.
 * - Otherwise a body read from the row and its assignments: an agent created in the console with no
 *   version, or a row edited outside versions. Its first console edit becomes the next version, so
 *   no earlier row edit is lost. Surfaces live only in version bodies, so it carries the `local`
 *   version's surfaces, if any, which would otherwise stop being served.
 *
 * The console edits by id and a version names by name, so every id the edit or the row-built body
 * needs is named in one {@link WorkspaceAgentVersionStore.namesOf} read. An id the edit sends that
 * this workspace does not have answers the code the legacy write answered for it.
 */
import type { AgentDefinitionReferenceKind } from '@agent-workspace/core/db';
import {
  AgentVersionResourceSchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';
import {
  AGENT_DEFINITION_API_VERSION,
  AGENT_DEFINITION_KIND,
  type AgentDefinition,
} from '@indx-workspace/contracts/agents';

import type {
  AgentPolicy,
  AgentResourceAssignments,
  UpdateAgentPatch,
} from '../../contracts/agents';
import type { AgentRecord } from '../agents/contract';
import { agentNotFound, problem, type ApiResult } from '../agents/handlers';
import { compiledPolicyFor } from '../agents/policy';
import type { RequestCeiling } from '../policy-ceiling/ceiling';
import type { ToolBundleLookup } from '../tool-bundles/handlers';
import { toAgentVersionResource } from './contract';
import { createAgentVersion } from './handlers';
import { setAgentPointer, type PointerActor } from './pointers';
import type { WorkspaceAgentVersionStore } from './store';

/** What the console changed: the `PATCH` fields, the whole policy, or the whole assignment set. */
export type UiEdit =
  | { readonly kind: 'patch'; readonly patch: UpdateAgentPatch }
  | { readonly kind: 'policy'; readonly policy: AgentPolicy }
  | { readonly kind: 'resources'; readonly assignments: AgentResourceAssignments };

const SUMMARIES: Readonly<Record<UiEdit['kind'], string>> = {
  patch: 'Console edit: settings',
  policy: 'Console edit: policy',
  resources: 'Console edit: resources',
};

export interface UiEditDependencies {
  readonly store: WorkspaceAgentVersionStore;
  /** The agent's assignments, read only when the body is built from the row. */
  readonly assignments: () => Promise<AgentResourceAssignments | null>;
  /** The deployment's engine ids; defaults to the installed registry's (see the pipeline). */
  readonly registered?: readonly string[];
  /** The deployment's policy ceiling for this request (pipeline step 7, issue #535). */
  readonly ceiling?: RequestCeiling | null;
  /** The caller's tool bundles (pipeline step 4, issue #790). */
  readonly toolBundles?: ToolBundleLookup | null;
}

type Reference = readonly [AgentDefinitionReferenceKind, string];

/** Names an id the caller has made sure the workspace has. */
type Names = (kind: AgentDefinitionReferenceKind, id: string) => string;

/** Every id an assignment set names, files first, as the legacy write checked them. */
function assignmentIds(assignments: AgentResourceAssignments): Reference[] {
  return [
    ...assignments.files.map((grant): Reference => ['file', grant.fileId]),
    ...assignments.skillIds.map((id): Reference => ['skill', id]),
    ...assignments.connectorIds.map((id): Reference => ['connector', id]),
  ];
}

/** Every id `edit` sends. */
function editIds(edit: UiEdit): Reference[] {
  switch (edit.kind) {
    case 'patch': {
      const { modelConnectionId, runtimeProfileId } = edit.patch;
      const ids: Reference[] = [];
      if (typeof modelConnectionId === 'string') ids.push(['model-connection', modelConnectionId]);
      if (typeof runtimeProfileId === 'string') ids.push(['runtime-profile', runtimeProfileId]);
      return ids;
    }
    case 'policy':
      return [];
    case 'resources':
      return assignmentIds(edit.assignments);
  }
}

/** Every id the agent row and its assignments name. */
function rowIds(agent: AgentRecord, assignments: AgentResourceAssignments): Reference[] {
  const ids = assignmentIds(assignments);
  if (agent.modelConnectionId !== null) ids.push(['model-connection', agent.modelConnectionId]);
  if (agent.runtimeProfileId !== null) ids.push(['runtime-profile', agent.runtimeProfileId]);
  return ids;
}

/** An id the edit sent that this workspace does not have, answered as the legacy write did. */
function unknownReference(kind: AgentDefinitionReferenceKind, id: string): ApiResult {
  switch (kind) {
    case 'model-connection':
      return problem(
        400,
        'unknown_model_connection',
        'modelConnectionId does not name a model connection in this workspace.',
      );
    case 'runtime-profile':
      return problem(
        400,
        'unknown_runtime_profile',
        'runtimeProfileId does not name a runtime profile in this workspace.',
      );
    case 'file':
    case 'skill':
    case 'connector':
      return problem(
        400,
        `unknown-${kind}`,
        `The assignment references an unavailable resource: ${id}.`,
      );
  }
}

/** The body the agent row and its assignments describe, carrying `surfaces` onto the row's name. */
function rowBody(
  agent: AgentRecord,
  assignments: AgentResourceAssignments,
  surfaces: AgentVersionBody['surfaces'],
  names: Names,
): AgentVersionBody {
  const skills = assignments.skillIds.map((id) => names('skill', id));
  const definition: AgentDefinition = {
    apiVersion: AGENT_DEFINITION_API_VERSION,
    kind: AGENT_DEFINITION_KIND,
    agent: {
      name: agent.name,
      instructions: agent.instructions,
      permissions: agent.permissions,
      model: agent.model,
      modelConnectionName:
        agent.modelConnectionId === null
          ? null
          : names('model-connection', agent.modelConnectionId),
      runtimeProfileName:
        agent.runtimeProfileId === null ? null : names('runtime-profile', agent.runtimeProfileId),
    },
    policy: agent.policy ?? compiledPolicyFor(agent.permissions, skills),
    policySource: agent.policy === null ? 'compiled' : 'stored',
    resources: {
      files: assignments.files.map((grant) => ({
        path: names('file', grant.fileId),
        access: grant.access,
      })),
      skills,
      connectors: assignments.connectorIds.map((id) => names('connector', id)),
    },
  };
  return { definition, surfaces: surfaces.map((surface) => ({ ...surface, agent: agent.name })) };
}

/**
 * `base` with `edit` applied: only the edited fields change. A compiled policy is recompiled from
 * the result's permissions and skills, and a rename carries the surfaces along, since each names
 * its agent.
 */
export function uiEditBody(base: AgentVersionBody, edit: UiEdit, names: Names): AgentVersionBody {
  const { definition } = base;
  let { agent, policy, policySource, resources } = definition;
  switch (edit.kind) {
    case 'patch': {
      const { patch } = edit;
      agent = {
        name: patch.name ?? agent.name,
        instructions: patch.instructions ?? agent.instructions,
        permissions: patch.permissions ?? agent.permissions,
        model: patch.model === undefined ? agent.model : patch.model,
        modelConnectionName:
          patch.modelConnectionId === undefined
            ? agent.modelConnectionName
            : patch.modelConnectionId === null
              ? null
              : names('model-connection', patch.modelConnectionId),
        runtimeProfileName:
          patch.runtimeProfileId === undefined
            ? agent.runtimeProfileName
            : patch.runtimeProfileId === null
              ? null
              : names('runtime-profile', patch.runtimeProfileId),
      };
      break;
    }
    case 'policy':
      policy = edit.policy;
      policySource = 'stored';
      break;
    case 'resources': {
      const { assignments } = edit;
      resources = {
        files: assignments.files.map((grant) => ({
          path: names('file', grant.fileId),
          access: grant.access,
        })),
        skills: assignments.skillIds.map((id) => names('skill', id)),
        connectors: assignments.connectorIds.map((id) => names('connector', id)),
      };
      break;
    }
  }
  if (policySource === 'compiled') policy = compiledPolicyFor(agent.permissions, resources.skills);
  const renamed = agent.name !== definition.agent.name;
  return {
    ...base,
    definition: { ...definition, agent, policy, policySource, resources },
    surfaces: renamed
      ? base.surfaces.map((surface) => ({ ...surface, agent: agent.name }))
      : base.surfaces,
  };
}

/**
 * Save `edit` of `agent` as its next version (`via: 'ui'`) and point `local` at it. Answers `null`
 * once both have committed, else the refusal of whichever step refused, unchanged.
 */
export async function saveUiEdit(
  agent: AgentRecord,
  edit: UiEdit,
  actor: PointerActor,
  dependencies: UiEditDependencies,
): Promise<ApiResult | null> {
  const { store } = dependencies;
  const listing = await store.list(agent.id);
  if (listing === null) return agentNotFound();
  const local = listing.pointers.find((pointer) => pointer.environment === 'local');
  const localVersion =
    local === undefined
      ? undefined
      : listing.versions.find((version) => version.id === local.versionId);
  const localBody =
    localVersion === undefined ? undefined : toAgentVersionResource(localVersion).body;
  const versioned =
    localBody !== undefined && listing.materialisedVersionId === local?.versionId
      ? localBody
      : null;
  const row = versioned === null ? await dependencies.assignments() : null;

  const sent = editIds(edit);
  const wanted: Partial<Record<AgentDefinitionReferenceKind, string[]>> = {};
  for (const [kind, id] of [...sent, ...(row === null ? [] : rowIds(agent, row))]) {
    (wanted[kind] ??= []).push(id);
  }
  const found = await store.namesOf(wanted);
  const unknown = sent.find(([kind, id]) => !found[kind].has(id));
  if (unknown !== undefined) return unknownReference(...unknown);
  const names: Names = (kind, id) => {
    const name = found[kind].get(id);
    // The row's foreign keys keep its own references in the workspace; the edit's were checked.
    if (name === undefined) throw new Error(`The workspace has no ${kind} ${id} to name.`);
    return name;
  };
  const base =
    versioned ?? (row === null ? null : rowBody(agent, row, localBody?.surfaces ?? [], names));
  if (base === null) return agentNotFound();

  // ponytail: create then point is two transactions, as `aw push` is; a refused point leaves an
  // unpointed `ui` version. One transaction needs a store method that does both.
  const created = await createAgentVersion(
    { body: uiEditBody(base, edit, names), summary: SUMMARIES[edit.kind], via: 'ui' },
    agent,
    actor.principalId,
    dependencies,
  );
  if (created.status !== 201) return created;
  const { number } = AgentVersionResourceSchema.parse(created.body);
  const pointed = await setAgentPointer(
    { environment: 'local', version: number },
    agent,
    actor,
    dependencies,
  );
  return pointed.status === 200 ? null : pointed;
}
