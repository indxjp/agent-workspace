/**
 * `POST`/`GET /api/agents/:id/versions` (S1-05, issue #443; ADR-0101), apart from `Request` and
 * `Response` the way `../agents/handlers.ts` keeps the agent operations apart from them. RBAC has
 * already run when these are called: the route's ownership resolver loaded `agent` in the caller's
 * workspace and `decide()` allowed the caller onto it.
 */
import {
  AGENT_POINTER_MOVES_LISTED,
  AGENT_VERSION_PROBLEM_CODES,
  CreateAgentVersionRequestSchema,
  type AgentVersionCheckResponse,
  type AgentVersionEvaluation,
} from '@indx-workspace/contracts/agent-versions';

import type { AgentRecord } from '../agents/contract';
import { agentNotFound } from '../agents/handlers';
import { problem, type ApiResult } from '../http/result';
import { toAgentVersionListResponse, toAgentVersionResource } from './contract';
import { bodyToStore } from './materialise';
import { parseVersionRequest, validateAgentVersion } from './pipeline';
import type { RequestCeiling } from '../policy-ceiling/ceiling';
import type { ToolBundleLookup } from '../tool-bundles/handlers';
import type { StorageConnectionLookup } from './storage-grants';
import { narrowStorageGrants, type WorkspaceAgentVersionStore } from './store';

export interface CreateAgentVersionDependencies {
  readonly store: WorkspaceAgentVersionStore;
  /** The deployment's engine ids; defaults to the installed registry's (see the pipeline). */
  readonly registered?: readonly string[];
  /** The deployment's policy ceiling for this request (pipeline step 7, issue #535). */
  readonly ceiling?: RequestCeiling | null;
  /** The caller's tool bundles (pipeline step 4, issue #790). */
  readonly toolBundles?: ToolBundleLookup | null;
  /** The caller's storage connections (pipeline step 4a). */
  readonly storageConnections?: StorageConnectionLookup | null;
  /** Whether the deployment has a tool sandbox; `false` refuses a version that pins code tools. */
  readonly toolHost?: boolean;
  /** Why the tool sandbox cannot enforce a code tool's `allowedDomains` (#1018), or `null`. */
  readonly toolDomainsRefusal?: string | null;
}

/**
 * Where an in-process caller says a version came from. Never built from a request body. The Builder
 * origin may name its run; a create given one also writes its `agent-created` row. `quota` refuses a
 * create once the workspace has created `limit` agents since `since`.
 */
export type VersionOrigin = {
  readonly via: 'builder';
  readonly builderRunId?: string;
  readonly quota?: { readonly since: Date; readonly limit: number };
};

export const BUILDER_ORIGIN: VersionOrigin = { via: 'builder' };

/**
 * Save the next version of `agent`, or — with `dryRun: true` — run the same pipeline (C8) and
 * answer the number a save would take, writing nothing.
 *
 * The dry run's `number` is `max(existing) + 1` read from `list()`. It is not race-proof: a save
 * that lands between the dry run and the client's own save takes that number first, and the save
 * then answers the next one. A dry run is a check, not a reservation.
 *
 * `unknown-principal` throws: the caller is an authenticated principal of this workspace, so the
 * store refusing it as unknown is a broken invariant, which surfaces as `500 internal_error`.
 *
 * `number`, passed only by an in-process caller (never read from a request), saves the version
 * only if it takes that number; otherwise nothing is saved and the answer is a `409`.
 *
 * `origin`, likewise passed only by an in-process caller and never read from a request, stores
 * its `via` instead of the request's. The request schema refuses `via: 'builder'`, so this is the
 * only way a version gets it (issue #1847).
 */
export async function createAgentVersion(
  raw: unknown,
  agent: AgentRecord,
  principalId: string,
  dependencies: CreateAgentVersionDependencies,
  number?: number,
  origin?: VersionOrigin,
): Promise<ApiResult> {
  const parsed = parseVersionRequest(
    CreateAgentVersionRequestSchema,
    raw,
    'body',
    dependencies.registered,
  );
  if (!parsed.ok) return parsed.result;
  const { request } = parsed;
  const validated = await validateAgentVersion(request.body, {
    ...dependencies,
    subject: { kind: 'existing', agent },
    bodyPath: 'body',
    dryRun: request.dryRun === true,
  });
  if (!validated.ok) return validated.result;
  const { store } = dependencies;

  if (request.dryRun === true) {
    const listing = await store.list(agent.id);
    if (listing === null) return agentNotFound();
    const latest = listing.versions.reduce((max, version) => Math.max(max, version.number), 0);
    return {
      status: 200,
      body: { ok: true, number: latest + 1 } satisfies AgentVersionCheckResponse,
    };
  }

  // The version stores the policy the pipeline carried across an engine switch (step 6), so the
  // immutable body keeps every denial the owner set; a compiled policy carries nothing.
  const body = bodyToStore(request.body, validated.policyToStore);
  const outcome = await store.create(agent.id, {
    summary: request.summary,
    via: origin?.via ?? request.via,
    body,
    createdByPrincipalId: principalId,
    storageGrants: narrowStorageGrants(
      validated.references.storageGrants ?? [],
      request.body.definition.agent.permissions,
    ),
    ...(number === undefined ? {} : { number }),
  });
  switch (outcome.kind) {
    case 'created':
      return { status: 201, body: toAgentVersionResource(outcome.version) };
    case 'not-found':
      return agentNotFound();
    case 'number-taken':
      return problem(
        AGENT_VERSION_PROBLEM_CODES.agent_version_number_taken,
        'agent_version_number_taken',
        `Another save took version ${String(number)} of this agent first.`,
      );
    case 'unknown-principal':
      throw new Error(
        `The version store does not know principal ${principalId}, which RBAC authenticated in ` +
          'this workspace; the principal invariant is broken.',
      );
  }
}

/** Every version of the agent, oldest first, its environment pointers and its latest moves. */
export async function listAgentVersions(
  agentId: string,
  store: WorkspaceAgentVersionStore,
): Promise<ApiResult> {
  const listing = await store.list(agentId);
  if (listing === null) return agentNotFound();
  const moves = await store.listMoves(agentId, null, AGENT_POINTER_MOVES_LISTED);
  // ponytail: one indexed lookup per version, in sequence; a DISTINCT ON repository read when
  // agents reach hundreds of versions.
  const evaluations: AgentVersionEvaluation[] = [];
  for (const version of listing.versions) {
    const latest = await store.latestEvaluation(version.id);
    if (latest === null) continue;
    evaluations.push({
      version: version.number,
      score: latest.score,
      passed: latest.passed,
      total: latest.total,
    });
  }
  return { status: 200, body: toAgentVersionListResponse(listing, moves, evaluations) };
}
