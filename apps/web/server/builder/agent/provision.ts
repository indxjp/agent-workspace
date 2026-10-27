/**
 * Provisioning of the Builder, the one built-in agent (#1848; design §04). `ensureBuilderAgent`
 * keeps a workspace's Builder on the shipped body: one row marked `builtin: 'builder'`, with
 * `local` and `production` both on the shipped version.
 *
 * Both pointers move together, and without a promotion bar, on purpose: the Builder is platform
 * owned, and the CI evals that gate a change to its prompt or model are its promotion (design
 * §07). A workspace cannot hold an old Builder on `production` while `local` moves.
 *
 * The shipped body comes from the caller (`deps.shippedBody`); `builderShippedBody()` in
 * `definition.ts` is the shipped one. Every write goes through the ordinary version pipeline and
 * pointer handlers, so the Builder gets versions and audit rows like any agent.
 */
import { isDeepStrictEqual } from 'node:util';

import { ApiProblemSchema } from '@indx-workspace/contracts';
import {
  AGENT_VERSION_PROBLEM_CODES,
  AgentVersionBodySchema,
  AgentVersionResourceSchema,
  type AgentVersionBodyInput,
} from '@indx-workspace/contracts/agent-versions';

import {
  createAgentFromVersion,
  type CreateAgentFromVersionDependencies,
  type CreateFromVersionOwner,
} from '../../agent-versions/create-from-version';
import { createAgentVersion } from '../../agent-versions/handlers';
import { setAgentPointer } from '../../agent-versions/pointers';
import type { AgentVersionStoreProvider } from '../../agent-versions/store';
import type { AgentRecord } from '../../agents/contract';
import { agentNotFound } from '../../agents/handlers';
import type { AgentStoreProvider } from '../../agents/store';
import type { ApiResult } from '../../http/result';
import { BUILDER_SHIPPED_SUMMARY } from './prompt-version';
import { isBuilderAgent } from './is-builder-agent';

export interface EnsureBuilderAgentDependencies extends Omit<
  CreateAgentFromVersionDependencies,
  'store' | 'agents'
> {
  /** The portable body the platform ships as the Builder. */
  readonly shippedBody: AgentVersionBodyInput;
  /** Who owns the Builder and acts for the writes: the workspace's Owner principal. */
  readonly owner: Omit<CreateFromVersionOwner, 'builtin'>;
  readonly versions: AgentVersionStoreProvider;
  readonly agents: AgentStoreProvider;
}

export type EnsureBuilderAgentOutcome =
  | {
      readonly kind: 'created' | 'updated' | 'unchanged';
      readonly agentId: string;
      readonly version: number;
    }
  | { readonly kind: 'refused'; readonly result: ApiResult };

const NUMBER_TAKEN =
  'agent_version_number_taken' satisfies keyof typeof AGENT_VERSION_PROBLEM_CODES;

/** How many times one call starts over after another call took its version number. */
const MAX_SAVE_ATTEMPTS = 3;

/**
 * Create the workspace's Builder, move it to a new shipped version, or do nothing. Idempotent:
 * a second call with the same body changes no row. A refusal (for example a user agent already
 * named like the Builder) writes nothing and answers the pipeline's problem. A call that loses the
 * version-number race {@link MAX_SAVE_ATTEMPTS} times in a row answers the `409` instead of looping.
 */
export async function ensureBuilderAgent(
  workspaceId: string,
  deps: EnsureBuilderAgentDependencies,
  attemptsLeft: number = MAX_SAVE_ATTEMPTS,
): Promise<EnsureBuilderAgentOutcome> {
  const { shippedBody, owner, versions, agents: agentProvider, ...options } = deps;
  const store = await versions.forWorkspace(workspaceId);
  if (store === null) throw new Error(`Workspace ${workspaceId} has no agent version store.`);
  const agents = agentProvider.forWorkspace(workspaceId);
  const pipeline = { ...options, store };
  const actor = {
    principalId: owner.principalId,
    userId: owner.userId,
    role: owner.role,
    actor: owner.actorLabel,
  };
  // ponytail: lists every agent per call; add a `findBuiltin` store method if it shows in a profile.
  const findBuilder = async (): Promise<AgentRecord | undefined> =>
    (await agents.list()).find(isBuilderAgent);

  /** Put both pointers on `number`, skipping one that is already there. */
  const pointBoth = async (agent: AgentRecord, number: number): Promise<ApiResult | null> => {
    const pointers = (await store.list(agent.id))?.pointers ?? [];
    for (const environment of ['local', 'production'] as const) {
      if (pointers.some((p) => p.environment === environment && p.number === number)) continue;
      const moved = await setAgentPointer({ environment, version: number }, agent, actor, pipeline);
      if (moved.status !== 200) return moved;
    }
    return null;
  };

  let builder = await findBuilder();
  let created = false;
  if (builder === undefined) {
    const result = await createAgentFromVersion(
      { version: { summary: BUILDER_SHIPPED_SUMMARY, via: 'api', body: shippedBody } },
      { ...owner, builtin: 'builder' },
      { ...pipeline, agents },
    );
    // A concurrent call may have created the Builder between our read and write; carry on with it.
    builder = await findBuilder();
    if (builder === undefined) return { kind: 'refused', result };
    created = result.status === 201;
  }

  const listing = await store.list(builder.id);
  if (listing === null) return { kind: 'refused', result: agentNotFound() };
  const latest = listing.versions.reduce<(typeof listing.versions)[number] | undefined>(
    (best, version) => (best === undefined || version.number > best.number ? version : best),
    undefined,
  );
  // ponytail: the stored body is the shipped one unless the pipeline rewrote its policy (an MCP
  // rule stored by connector id); such a body would count as changed on every call. Compare the
  // pipeline's stored form if a shipped definition ever needs that.
  const shipped: unknown = JSON.parse(JSON.stringify(AgentVersionBodySchema.parse(shippedBody)));
  if (latest !== undefined && isDeepStrictEqual(shipped, latest.body)) {
    // Only a pointer that a concurrent call has not moved yet, or one that drifted, is left.
    const refused = await pointBoth(builder, latest.number);
    if (refused !== null) return { kind: 'refused', result: refused };
    return {
      kind: created ? 'created' : 'unchanged',
      agentId: builder.id,
      version: latest.number,
    };
  }

  // Saved only as the number after the version compared above: a concurrent call that saved first
  // takes it, this one saves nothing and starts over, finding that call's version.
  const saved = await createAgentVersion(
    { summary: BUILDER_SHIPPED_SUMMARY, via: 'api', body: shippedBody },
    builder,
    owner.principalId,
    pipeline,
    (latest?.number ?? 0) + 1,
  );
  const taken = ApiProblemSchema.safeParse(saved.body).data?.error.code === NUMBER_TAKEN;
  if (taken && attemptsLeft > 1) {
    return ensureBuilderAgent(workspaceId, deps, attemptsLeft - 1);
  }
  if (saved.status !== 201) return { kind: 'refused', result: saved };
  const { number } = AgentVersionResourceSchema.parse(saved.body);
  const refused = await pointBoth(builder, number);
  if (refused !== null) return { kind: 'refused', result: refused };
  return { kind: 'updated', agentId: builder.id, version: number };
}
