import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import { requestOutcome, type RequestOutcome } from '../../lib/request-outcome';
import {
  USER_FILTER_PROBE_ID,
  catalogFromList,
  isCanonicalRunId,
  parseRunResource,
  runListQuery,
  type Catalog,
  type CatalogKind,
  type RequestProblem,
  type RunListFilters,
  type RunListItem,
  type RunListPage,
  type UserFilterAvailability,
} from './history';
import { parseRunTree, type RunTree } from './run-tree-model';

/**
 * The run screens' reads through the SDK client. Each resolves with what the screen shows: a
 * value, or the {@link RequestProblem} the screen renders for a refused or unanswered request.
 */

/** What the run detail screen shows for one `GET /api/runs/:id`. */
export type DetailLoad =
  | { readonly kind: 'loading' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'problem'; readonly problem: RequestProblem }
  | { readonly kind: 'loaded'; readonly run: RunListItem; readonly tree: RunTree };

/**
 * `GET /api/runs` for one filter set and cursor. The SDK validates the page; each run then passes
 * the screen's own `parseRunResource`, which also refuses the accounting figures that contradict
 * each other.
 */
export function loadRunPage(
  client: AgentWorkspaceClient,
  filters: RunListFilters,
  cursor: string | null,
): Promise<RequestOutcome<RunListPage>> {
  return requestOutcome(
    client.runs.list(runListQuery(filters, cursor)).then((page) => ({
      runs: page.runs.map((run, index) => parseRunResource(run, `runs[${String(index)}]`)),
      nextCursor: page.nextCursor,
    })),
    'The run list could not be loaded',
    'The server returned an invalid run list.',
  );
}

/**
 * The read's run without `children` and `treeCost` (ADR-0104): the list's shape, which
 * `parseRunResource` checks exactly. The tree is parsed apart by `parseRunTree`.
 */
function withoutTree(detail: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const run: Record<string, unknown> = { ...detail };
  delete run['children'];
  delete run['treeCost'];
  return run;
}

/** One detail read: the run, then its tree, which names the run as every child's parent. */
function parseRunDetail(detail: object): { readonly run: RunListItem; readonly tree: RunTree } {
  const record = { ...detail } as Readonly<Record<string, unknown>>;
  const run = parseRunResource(withoutTree(record));
  return { run, tree: parseRunTree(record, run) };
}

/**
 * `GET /api/runs/:id`. A `404` is one `not-found` arm: the route answers a foreign id exactly like
 * a missing one (issue #117's concealment rule). An id that is not a canonical UUID never reaches
 * the network.
 */
export async function loadRunDetail(
  client: AgentWorkspaceClient,
  runId: string,
): Promise<DetailLoad> {
  if (!isCanonicalRunId(runId)) {
    return {
      kind: 'problem',
      problem: { kind: 'transport', reason: 'The selected run id is not a canonical UUID.' },
    };
  }
  const outcome = await requestOutcome(
    client.runs.get(runId).then(parseRunDetail),
    'The run could not be loaded',
    'The server returned an invalid run.',
  );
  if (outcome.ok) return { kind: 'loaded', ...outcome.value };
  const { problem } = outcome;
  return problem.kind === 'api' && problem.status === 404
    ? { kind: 'not-found' }
    : { kind: 'problem', problem };
}

/** One workspace catalogue (id to name). Rejects on any failure; the screen shows `unavailable`. */
export async function loadCatalog(
  client: AgentWorkspaceClient,
  kind: CatalogKind,
): Promise<Catalog> {
  // `archived: 'all'` so an archived project keeps its name in run history (issue #184).
  const list =
    kind === 'agents'
      ? await client.agents.list()
      : kind === 'projects'
        ? await client.projects.list({ archived: 'all' })
        : kind === 'users'
          ? await client.team.users.list()
          : await client.workspaces.list();
  return catalogFromList(kind, list);
}

/**
 * Whether to offer the `user` filter, from a real answer to a probe (see `./history.ts`): a clean
 * `200` means yes; the `403 user_filter_forbidden` and every other failure mean no (ADR-0015).
 */
export async function probeUserFilter(
  client: AgentWorkspaceClient,
): Promise<UserFilterAvailability> {
  try {
    await client.runs.list({ limit: 1, user: USER_FILTER_PROBE_ID });
    return 'available';
  } catch {
    return 'unavailable';
  }
}
