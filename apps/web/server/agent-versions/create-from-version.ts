/**
 * `POST /api/agents {version, dryRun?}` (S1-06, issue #444; ADR-0101): create an agent from its
 * first version. The route dispatches here when the body is a plain object with an own `version`
 * key (and no `agent` key — see `app/api/agents/route.ts`); the legacy and compound forms are
 * untouched.
 *
 * ## The same pipeline, and dry run parity (C8)
 *
 * `parseVersionRequest` and `validateAgentVersion` run steps 1–7 with subject `{ kind: 'new' }`;
 * parse issues keep their `version.` prefix. A save then hands core's `createAgentWithFirstVersion`
 * one transaction: the agent row, its assignments, version `1` and the `local` pointer at it, C9
 * checked.
 *
 * A dry run cannot run that transaction, so after the pipeline it asks the two questions the
 * transaction would refuse on, in the same order:
 *
 * 1. is the agent name another agent's — exact match, the `agents_workspace_name_key` mirror →
 *    `409 agent_name_conflict`;
 * 2. is a body surface served by a version some agent points `local` at
 *    ({@link firstPointedSurface}) → `409 surface_name_taken`, `details: [surface:<name>]`.
 *
 * So a dry run and a save answer the same problem for the same body. Like S1-05's dry run, it is a
 * check and not a reservation: an agent created between the dry run and the save takes the name.
 *
 * Core's C9 check inside the save names the first conflicting surface in the database's collation
 * order, which this process cannot reproduce (a hyphen sorts differently under `C` and under
 * `en_US`). So both paths name the surface through one function, {@link firstPointedSurface}: the
 * first body surface, in body order, that a pointed version serves. The save calls it after core
 * refused (nothing was written) and falls back to core's name only when the conflict went away in
 * between, so with any number of conflicting surfaces the dry run and the save answer the same
 * `details`.
 *
 * `unknown-principal` throws: the caller is an authenticated principal of this workspace, so the
 * store refusing it is a broken invariant (`500 internal_error`).
 */
import {
  CreateAgentFromVersionRequestSchema,
  type AgentVersionCheckResponse,
  type CreateAgentFromVersionResponse,
} from '@indx-workspace/contracts/agent-versions';

import { toAgentResource } from '../agents/contract';
import type { WorkspaceAgentStore } from '../agents/store';
import type { ApiResult } from '../agents/handlers';
import { toAgentVersionResource } from './contract';
import { bodyToStore, materialise } from './materialise';
import { definitionReferences, parseVersionRequest, validateAgentVersion } from './pipeline';
import {
  agentNameConflict,
  subagentNestingRefusal,
  surfaceNameTaken,
  withReferenceRetry,
} from './problems';
import type { RequestCeiling } from '../policy-ceiling/ceiling';
import type { ToolBundleLookup } from '../tool-bundles/handlers';
import type { WorkspaceAgentVersionStore } from './store';

/** The environment a created agent's first version is pointed at (slice 1 has only `local`). */
const FIRST_ENVIRONMENT = 'local';

/** Who creates the agent: its owner principal, and the user `created_by` names (or `null`). */
/**
 * Who creates the agent. `principalId` is the principal that acted, recorded as the first
 * version's `createdByPrincipalId`; `ownerPrincipalId` owns the agent (`Principal.ownerPrincipalId`:
 * the same principal except for a local runtime key, which writes for the member it acts for,
 * issue #509, S1-24).
 */
export interface CreateFromVersionOwner {
  readonly principalId: string;
  readonly ownerPrincipalId: string;
  readonly userId: string | null;
}

export interface CreateAgentFromVersionDependencies {
  readonly store: WorkspaceAgentVersionStore;
  /** The workspace's agents, read by the dry run's name check. */
  readonly agents: Pick<WorkspaceAgentStore, 'list'>;
  /** The deployment's engine ids; defaults to the installed registry's (see the pipeline). */
  readonly registered?: readonly string[];
  /** The deployment's policy ceiling for this request (pipeline step 7, issue #535). */
  readonly ceiling?: RequestCeiling | null;
  /** The caller's tool bundles (pipeline step 4, issue #790). */
  readonly toolBundles?: ToolBundleLookup | null;
  /** Whether the deployment has a tool sandbox; `false` refuses a version that pins code tools. */
  readonly toolHost?: boolean;
  /** Why the tool sandbox cannot enforce a code tool's `allowedDomains` (#1018), or `null`. */
  readonly toolDomainsRefusal?: string | null;
}

/**
 * The first surface of `surfaces`, in body order, that a version some agent points
 * {@link FIRST_ENVIRONMENT} at already serves, or `null`. The one rule both the dry run and the
 * save's `surface_name_taken` use to name the surface (C8).
 */
async function firstPointedSurface(
  store: Pick<WorkspaceAgentVersionStore, 'findPointedSurface'>,
  surfaces: readonly { readonly name: string }[],
): Promise<string | null> {
  for (const surface of surfaces) {
    if ((await store.findPointedSurface(FIRST_ENVIRONMENT, surface.name)) !== null) {
      return surface.name;
    }
  }
  return null;
}

/** Create an agent from `raw`'s first version, or — with `dryRun: true` — check that it would. */
export async function createAgentFromVersion(
  raw: unknown,
  owner: CreateFromVersionOwner,
  dependencies: CreateAgentFromVersionDependencies,
): Promise<ApiResult> {
  const parsed = parseVersionRequest(
    CreateAgentFromVersionRequestSchema,
    raw,
    'version.body',
    dependencies.registered,
  );
  if (!parsed.ok) return parsed.result;
  const { request } = parsed;
  const draft = request.version;
  const validated = await validateAgentVersion(draft.body, {
    ...dependencies,
    subject: { kind: 'new' },
    bodyPath: 'version.body',
    dryRun: request.dryRun === true,
  });
  if (!validated.ok) return validated.result;
  const { policyToStore } = validated;
  const { store } = dependencies;
  const { definition } = draft.body;

  if (request.dryRun === true) {
    const name = definition.agent.name;
    if ((await dependencies.agents.list()).some((agent) => agent.name === name)) {
      return agentNameConflict(name);
    }
    const taken = await firstPointedSurface(store, draft.body.surfaces);
    if (taken !== null) return surfaceNameTaken(taken);
    return { status: 200, body: { ok: true, number: 1 } satisfies AgentVersionCheckResponse };
  }

  const body = bodyToStore(draft.body, policyToStore);
  const outcome = await withReferenceRetry(
    validated.references,
    () => store.resolveDefinition(definitionReferences(definition)),
    (references) =>
      store.createAgentWithFirstVersion({
        agent: {
          ...materialise(definition, references, policyToStore),
          ownerPrincipalId: owner.ownerPrincipalId,
          createdBy: owner.userId,
        },
        version: {
          summary: draft.summary,
          via: draft.via,
          body,
          createdByPrincipalId: owner.principalId,
        },
        environment: FIRST_ENVIRONMENT,
      }),
  );
  switch (outcome.kind) {
    case 'refused':
      return outcome.result;
    case 'name-conflict':
      return agentNameConflict(outcome.name);
    case 'surface-name-taken':
      return surfaceNameTaken(
        (await firstPointedSurface(store, draft.body.surfaces)) ?? outcome.name,
      );
    case 'subagent-nesting':
      return subagentNestingRefusal(outcome.unusable, outcome.parents);
    case 'reference-gone':
      throw new Error('withReferenceRetry answered reference-gone, which it never returns.');
    case 'unknown-principal':
      throw new Error(
        `The version store does not know principal ${owner.principalId}, which RBAC ` +
          'authenticated in this workspace; the principal invariant is broken.',
      );
    case 'created':
      return {
        status: 201,
        body: {
          agent: toAgentResource(outcome.agent),
          version: toAgentVersionResource(outcome.version),
        } satisfies CreateAgentFromVersionResponse,
      };
  }
}
