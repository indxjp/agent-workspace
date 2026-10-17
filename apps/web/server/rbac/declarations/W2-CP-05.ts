/**
 * W2-CP-05 · the one sub segment of `/api/connectors/:id/**` this task ships — spec §8, §21.
 *
 * `test-connection` is not printed by spec §34 under `connectors` (§34 prints only the collection
 * routes, `GET`/`POST /api/connectors`), so — per ADR-0040 — this task declares it here rather than
 * editing `apps/web/server/rbac/permissions.ts`'s `SPEC_34_SUB_RESOURCES` (W2-CP-06's file) or
 * `apps/web/server/rbac/decide.ts`'s `parseOperation` (also W2-CP-06's).
 *
 * ## Why this is `write`, not `run`, and why that is not routed around
 *
 * `decide.ts`'s `parseOperation` special-cases `sub === 'runs' || sub === 'messages'` as the `run`
 * operation, because those two are where this control plane spends money and executes an agent
 * (§21's own verb, "Create/edit/**run** agents"). `POST …/test-connection` does neither: it opens
 * a transport, completes the MCP handshake, and reports the result — no model call, no spend. So
 * it falls through `parseOperation`'s generic `POST → write` mapping, which this declaration
 * accepts rather than asks W2-CP-06's file to special-case, for a reason worth stating: Test
 * Connection resolves and USES the connector's stored credential (`apps/web/server/connectors/store.ts`'s
 * `resolveForProbe`), which is at least as sensitive as writing the connector row itself — a
 * capability §21 gives Builder over their own connectors ("Create/edit/run agents, skills, files,
 * **connectors** where permitted") and Admin over every connector ("Users, agents, models, API
 * keys, **connectors**, runtimes"). Treating it as `read` would under-grant nothing dangerous, but
 * treating it as anything narrower than `write` would be a guess about §21 this task has no
 * evidence for; `write` is the width `parseOperation` already assigns every POST that is not one of
 * the two named exceptions, and this declaration's whole content is "yes, that default is right
 * here" rather than a request to change it.
 *
 * The wizard's PRE-save probe (spec §8's `[ Test Connection ]`, driven before `[ Save ]`) is not a
 * route of its own and so needs no entry here either: it rides `POST /api/connectors` itself, via
 * a `"dryRun": true` field on the same body — see `apps/web/server/connectors/handlers.ts`'s header
 * for why a standalone `/api/connectors/test-connection` route does not exist (the shape rule
 * refuses a literal second segment with no id first, and this task cannot add a new top-level
 * resource to `permissions.ts` to work around that).
 */
import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'W2-CP-05',
    resource: 'connectors',
    sub: 'test-connection',
    because:
      '§21 Builder — "Create/edit/run agents, skills, files, connectors where permitted" — and Admin — "Users, agents, models, API keys, connectors, runtimes." Test Connection resolves and uses the connector\'s own stored credential, which is at least as sensitive as writing the connector row, so it is classified under the parent resource\'s generic write width rather than carved out narrower with no evidence for a different one.',
  },
];
