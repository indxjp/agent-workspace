/**
 * `POST /api/agents` and `GET /api/agents` — two of the five agent routes of spec §34.
 *
 * The other three live in `[id]/route.ts`. Nothing else belongs in this directory: §34 names five
 * agent routes and `tests/route-inventory.test.ts` fails the build if a sixth appears, whether it
 * is a search endpoint, a bulk endpoint or a count endpoint.
 *
 * These functions are deliberately trivial. Everything worth testing is in
 * `apps/web/server/agents/`, which a test can import without the framework.
 *
 * The imports below are relative rather than `@/…` on purpose. The `@/` alias is a bundler
 * setting: `next build` resolves it and Vitest, which has no Next plugin configured for this
 * workspace member, does not. While these files used the alias they could not be imported by any
 * test in the repository, so "the route wires the handler to the store correctly" was an untested
 * claim. `apps/web/server/agents/routes.test.ts` imports this file and exercises all five routes;
 * a relative specifier is the price of that and it is a small one.
 */
import { AGENT_MUTABLE_FIELDS, type CreateAgentInput } from '../../../contracts/agents';
import { createAgent, listAgents, problem, type ApiResult } from '../../../server/agents/handlers';
import { judgeAgent } from '../../../server/policy-ceiling/ceiling';
import {
  demandsConnectors,
  demandsSkills,
  engineCapabilityRefusal,
} from '../../../server/agents/policy';
import { DEFAULT_ENGINE_ID } from '../../../server/engines/session-engine';
import { parseAssignments } from './[id]/resources/route';
import { toResponse, withAuthorisedWorkspaceStore } from '../../../server/agents/http';
import { createAgentFromVersion } from '../../../server/agent-versions/create-from-version';
import { readCreateAgentBody } from '../../../server/agent-versions/http';
import { currentAgentVersionsRuntime } from '../../../server/agent-versions/runtime';
import { openToolBundleLookup } from '../../../server/tool-bundles/http';

// The repository-wide route invariant (`tests/route-inventory.test.ts`, "runs every route on the
// Node runtime and never prerenders one"). Added by W1-INT-02: the assertion was written by
// W1-CP-04 over every file under `app/api` and had never run against this file, because the gate
// carrying it lived on a sibling branch. `force-dynamic` is right here independently of the gate —
// these handlers read the session cookie through `withWorkspaceStore`, so prerendering them is
// never correct — and 'edge' is deprecated and cannot hold a long-lived stream (R-13).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `GET /api/agents` — the agents of the caller's workspace, and no other workspace's (§25). */
export async function GET(request: Request): Promise<Response> {
  const result = await withAuthorisedWorkspaceStore(request, 'not-applicable', (store) =>
    listAgents(store),
  );
  return toResponse(result);
}

/**
 * Which of the create forms a body is (S1-06, issue #444), decided before any parser runs:
 *
 * - `version`: a plain object with an own `version` key, no `agent` key and none of the legacy
 *   fields (`AGENT_MUTABLE_FIELDS`). It goes to the create-from-version parser.
 * - `mixed`: an own `version` key beside `agent`. `version` has a meaning now, so the compound
 *   path does not ignore it (no option is accepted and ignored): `400 invalid_body`.
 * - `legacy`: everything else, including a legacy body that also carries `version`. The legacy
 *   parser refuses the unknown key with `400 invalid_body`, exactly as it did before `version`
 *   existed, so that body keeps its error code. `legacy` then splits into the legacy and
 *   compound forms on `agent`, as it always has.
 */
function createForm(value: unknown): 'version' | 'mixed' | 'legacy' {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'legacy';
  if (!Object.hasOwn(value, 'version')) return 'legacy';
  if (Object.hasOwn(value, 'agent')) return 'mixed';
  return AGENT_MUTABLE_FIELDS.some((field) => Object.hasOwn(value, field)) ? 'legacy' : 'version';
}

/**
 * `POST /api/agents` — create one agent in the caller's workspace: from the legacy fields, with its
 * assignments (`{agent, assignments}`), or from a first version (`{version, dryRun?}`, S1-06).
 *
 * The body is read *inside* `withWorkspaceStore`, so the workspace gate runs first. The order is
 * load-bearing: reading the body first would answer `400 malformed_body` to a caller who has no
 * business getting an answer about this route's body format at all, and once W1-CP-06 wires a
 * session that same ordering would answer `400` where it owes `401`. Authenticate, then parse.
 */
export async function POST(request: Request): Promise<Response> {
  const result = await withAuthorisedWorkspaceStore(
    request,
    'not-applicable',
    async (store, runtime, workspaceId, principal) => {
      // One bound for all three forms (S1-06 risk 2): the body is bounded while it streams, before
      // its form is known, so the bound is the larger of the legacy and the version-draft ones.
      const body = await readCreateAgentBody(request);
      if (!body.ok) return body.result;
      // Issue #117: every create path stamps `created_by` in the same request that inserts the
      // row. Resolved after the body parses, so a caller who sent an unparsable body still learns
      // that first — the malformed-body 400 does not depend on this route's ownership plumbing.
      // The agent is owned by `ownerPrincipalId` (a local runtime key writes for the member it acts
      // for, issue #509); its first version records `principalId`, the principal that acted.
      const owner = { principalId: principal.ownerPrincipalId, userId: principal.userId };
      const versionOwner = {
        principalId: principal.principalId,
        ownerPrincipalId: principal.ownerPrincipalId,
        userId: principal.userId,
      };
      // Issue #535: every form is judged against the deployment's ceiling before it writes; the
      // legacy forms store no policy, so they are judged as the compiled default arm.
      const ceiling = runtime.ceilingFor?.(request, workspaceId) ?? null;
      const judgeCreate =
        (connectorIds: readonly string[]) =>
        (input: CreateAgentInput): Promise<ApiResult | null> =>
          judgeAgent({ ...input, policy: null }, connectorIds, ceiling, {
            id: null,
            label: input.name,
          });
      const form = createForm(body.value);
      if (form === 'mixed') {
        return problem(
          400,
          'invalid_body',
          'A create body carries either agent (with assignments) or version, not both.',
          ['version: not accepted beside agent'],
        );
      }
      if (form === 'version') {
        const versions = currentAgentVersionsRuntime();
        if (versions === null) {
          return problem(
            503,
            'agent_policy_not_configured',
            'Agent versions are not configured for this deployment.',
          );
        }
        const versionStore = await versions.versions.forWorkspace(workspaceId);
        if (versionStore === null) {
          throw new Error(
            `The version store does not resolve workspace ${workspaceId}, which RBAC verified.`,
          );
        }
        return createAgentFromVersion(body.value, versionOwner, {
          store: versionStore,
          agents: store,
          ceiling,
          toolBundles: openToolBundleLookup(workspaceId),
          toolHost: versions.toolHost === true,
          toolDomainsRefusal: versions.toolDomainsRefusal ?? null,
        });
      }
      const compound =
        typeof body.value === 'object' &&
        body.value !== null &&
        !Array.isArray(body.value) &&
        'agent' in body.value;
      if (!compound) return createAgent(store, body.value, owner, judgeCreate([]));
      const record = body.value as Record<string, unknown>;
      const assignments = parseAssignments(record['assignments']);
      if (assignments === null) {
        return {
          status: 400,
          body: {
            error: {
              code: 'invalid_assignments',
              message: 'The compound create requires valid assignment arrays.',
            },
          },
        };
      }
      if (runtime.agentResources === undefined) {
        return {
          status: 503,
          body: {
            error: {
              code: 'agent_resources_not_configured',
              message: 'Agent resource assignments are not configured.',
            },
          },
        };
      }
      // ADR-0065 D3, at the one-call create: an agent is never *saved* with connectors or skills its
      // engine cannot honour. A create body carries no policy, so the engine is the default arm —
      // the same one `compiledPolicyFor` serves for the NULL column this insert leaves behind — and
      // the check runs before anything is written rather than after a create that must be undone.
      // The demand goes through the same two helpers `PUT /api/agents/:id/policy` uses, with the
      // NULL policy this insert leaves behind, so both save doors state the rule once. Under a NULL
      // policy `demandsSkills` reads only whether anything is assigned, so the ids stand in for
      // the names here.
      const unsupported = engineCapabilityRefusal(DEFAULT_ENGINE_ID, {
        connectors: demandsConnectors(assignments),
        skills: demandsSkills(null, new Set(assignments.skillIds)),
      });
      if (unsupported !== null) return unsupported;
      // ponytail: check-then-write race until V-2, same as SD11
      const created = await createAgent(
        store,
        record['agent'],
        owner,
        judgeCreate(assignments.connectorIds),
      );
      if (created.status !== 201) return created;
      const resource = created.body as { id: string };
      try {
        const assigned = await runtime.agentResources
          .forWorkspace(workspaceId)
          .replace(resource.id, assignments);
        if (assigned.kind === 'updated') {
          return { status: 201, body: { agent: created.body, assignments: assigned.assignments } };
        }
        await store.delete(resource.id);
        return {
          status: assigned.kind === 'not-found' ? 500 : 400,
          body: {
            error: {
              code: assigned.kind,
              message: 'The agent was not created because an assignment was unavailable.',
            },
          },
        };
      } catch (error) {
        await store.delete(resource.id).catch(() => undefined);
        throw error;
      }
    },
  );
  return toResponse(result);
}
