/**
 * The `POST /api/agents` use case (W2-3): the three create forms of S1-06 — legacy fields, the
 * compound `{agent, assignments}`, and `{version, dryRun?}` — behind one function the route wires.
 *
 * The compound form writes the agent and its assignments through one store call,
 * `createWithAssignments`, which PostgreSQL runs as one transaction: a refused assignment leaves no
 * agent row, so there is no compensating delete to fail (F-05, F-06).
 */
import { AGENT_MUTABLE_FIELDS, type CreateAgentInput } from '../../contracts/agents';
import { createAgentFromVersion } from '../agent-versions/create-from-version';
import { openStorageConnectionLookup, readCreateAgentBody } from '../agent-versions/http';
import { applicationContext } from '../application-context';
import { DEFAULT_ENGINE_ID } from '../engines/session-engine';
import { problem, type ApiResult } from '../http/result';
import { judgeAgent } from '../policy-ceiling/ceiling';
import { installBuiltinSkillsNamedBy } from '../skills/builtin';
import { openToolBundleLookup } from '../tool-bundles/http';
import { parseAssignments } from './contract';
import { createAgent as createParsedAgent } from './handlers';
import { withAuthorisedWorkspaceStore } from './http';
import { demandsConnectors, demandsSkills, engineCapabilityRefusal } from './policy';

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
export async function createAgent(request: Request): Promise<ApiResult> {
  return withAuthorisedWorkspaceStore(
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
        actorLabel: principal.actor,
      };
      // Issue #535: every form is judged against the deployment's ceiling before it writes; the
      // legacy forms store no policy, so they are judged as the compiled default arm.
      const ceiling =
        runtime.ceiling.kind === 'enforced'
          ? runtime.ceiling.ceilingFor(request, workspaceId)
          : null;
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
        // The agents and versions runtimes are installed together, and this request already
        // reached the agents runtime through the installed context.
        const versions = applicationContext()?.agentVersions;
        if (versions === undefined) {
          throw new Error('The application context has an agents runtime but no versions runtime.');
        }
        const versionStore = await versions.versions.forWorkspace(workspaceId);
        if (versionStore === null) {
          throw new Error(
            `The version store does not resolve workspace ${workspaceId}, which RBAC verified.`,
          );
        }
        const { version: draft, dryRun } = body.value as {
          version?: { body?: unknown } | null;
          dryRun?: unknown;
        };
        // A dry run has no side effects, so it does not install the built-in it names.
        if (dryRun !== true) await installBuiltinSkillsNamedBy(draft?.body, principal);
        return createAgentFromVersion(body.value, versionOwner, {
          store: versionStore,
          agents: store,
          ceiling,
          toolBundles: openToolBundleLookup(workspaceId),
          storageConnections: openStorageConnectionLookup(workspaceId),
          toolHost: versions.toolHost,
          toolDomainsRefusal: versions.toolDomainsRefusal,
        });
      }
      const compound =
        typeof body.value === 'object' &&
        body.value !== null &&
        !Array.isArray(body.value) &&
        'agent' in body.value;
      if (!compound) return createParsedAgent(store, body.value, owner, judgeCreate([]));
      const record = body.value as Record<string, unknown>;
      const assignments = parseAssignments(record['assignments']);
      if (assignments === null) {
        return problem(
          400,
          'invalid_assignments',
          'The compound create requires valid assignment arrays.',
        );
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
      return createParsedAgent(
        store,
        record['agent'],
        owner,
        judgeCreate(assignments.connectorIds),
        assignments,
      );
    },
  );
}
