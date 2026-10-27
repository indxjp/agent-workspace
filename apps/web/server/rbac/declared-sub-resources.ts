/**
 * Sub-resource classification, partitioned by the task that ships the routes needing it.
 *
 * ## Why this file exists
 *
 * Sub-wave 2b-1 ran four backend tracks in parallel with pairwise-disjoint `Owns` globs. Each was
 * green alone. On the union, `authorisation-matrix.test.ts` reported 64 undecided cells — measured,
 * not estimated: four routes W2-CP-07 shipped under `/api/sessions/:id/<sub>` (`transcript` three
 * times and `subkeys` once) crossed with §21's four roles and `decide.ts`'s four ownership answers.
 * `permissions.ts`'s `SUB_RESOURCES` classified `messages` under `sessions` and nothing else, so
 * `decide()` **refused** every one of them, which is exactly what
 * [ADR-0015](../../../../docs/adr/0015-a-gate-decides-on-a-positive-assertion.md) and
 * [ADR-0031](../../../../docs/adr/0031-a-static-check-cannot-be-complete.md) require of an
 * unclassified authorisation question. The gate was working. What was missing was a place for
 * W2-CP-07 to put its answer.
 *
 * There were only two ways to give it one. Either W2-CP-07 edits `permissions.ts` — a file inside
 * W2-CP-06's `Owns` glob, which is the four-tracks-editing-one-file failure
 * [ADR-0038](../../../../docs/adr/0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md)
 * was written about, one layer down from `instrumentation.ts` — or the classification is
 * partitioned by owner the way
 * [ADR-0025](../../../../docs/adr/0025-the-route-inventory-is-partitioned-by-owner.md) partitioned
 * the route inventory. This is that partition, and
 * [ADR-0040](../../../../docs/adr/0040-sub-resource-classification-is-partitioned-by-the-task-that-ships-the-routes.md)
 * records the decision.
 *
 * ## What a task may and may not decide here
 *
 * A declaration says **"this sub segment is a part of its parent resource"**, and nothing else. The
 * grants stay the parent's — they come from `permissions.ts`'s `POLICY`, which is §21's split and
 * stays W2-CP-06's — so a task cannot widen its own permissions from here. The most a wrong
 * declaration can do is attach a route to the wrong parent resource, which is a reviewable claim
 * written in one place with the sentence of §21 behind it.
 *
 * A task that ships a route on a **resource** nobody has classified still has no file here to write
 * in, and `decide()` still refuses it: adding a resource means writing four roles' grants, which is
 * a reading of §21 and belongs with §21's table. That is deliberate, and it is what keeps
 * `authorisation-matrix.test.ts`'s "an unclassified resource fails, and is never skipped" true.
 *
 * ## Why the index is here and the declarations are in a directory
 *
 * `decide()` runs in a Next.js server bundle, so the union has to be reachable through static
 * imports a bundler can follow — a directory read at run time is not available to it, and
 * `tests/no-sdk-import.test.ts` refuses a module reference whose argument is not a string literal
 * anyway. So the imports below are written out. That makes "somebody added a declaration file and
 * did not import it here" the failure mode this mechanism has to close, and
 * `tests/permission-declarations.test.ts` closes it: it derives the file set from
 * `git ls-files -- apps/web/server/rbac/declarations`, reads each file's entries as text, and fails
 * if the union this module composes is not exactly that set. An unimported declaration file is a
 * hard failure naming it, never a quietly smaller union.
 *
 * The declaration files live in `declarations/` and the index lives beside it rather than inside
 * it, because `tests/inventory-support.ts`'s `declarationOwner` — the reader that gate reuses —
 * refuses any file in a declaration directory that is not named for a task. An `index.ts` sitting
 * among them is a file the union would silently absorb.
 */
import { subResources as dj8008promoterollback615 } from './declarations/DJ-80-08-PROMOTE-ROLLBACK-615';
import { subResources as dj8011evaluations618 } from './declarations/DJ-80-11-EVALUATIONS-618';
import { subResources as dj8013feedbacklist620 } from './declarations/DJ-80-13-FEEDBACK-LIST-620';
import { subResources as djs105agentversions443 } from './declarations/DJ-S1-05-AGENT-VERSIONS-443';
import { subResources as djs106agentpointers444 } from './declarations/DJ-S1-06-AGENT-POINTERS-444';
import { subResources as djs205crunfeedback539 } from './declarations/DJ-S2-05C-RUN-FEEDBACK-539';
import { subResources as eng06sessionstate305 } from './declarations/ENG-06-SESSION-STATE-305';
import { subResources as p54runapproval1301 } from './declarations/P5-4-RUN-APPROVAL-1301';
import { subResources as p72surfaceattachments1308 } from './declarations/P7-2-SURFACE-ATTACHMENTS-1308';
import { subResources as p84filesearch1314 } from './declarations/P8-4-FILE-SEARCH-1314';
import { subResources as ptt1aendpointclients } from './declarations/PT-T1A-ENDPOINT-CLIENTS';
import { subResources as ptt1coauth } from './declarations/PT-T1C-OAUTH';
import { subResources as pttriggers1293 } from './declarations/PT-TRIGGERS-1293';
import { subResources as ptu5platformexports968 } from './declarations/PT-U5-PLATFORM-EXPORTS-968';
import { subResources as sdk02agentpolicy234 } from './declarations/SDK-02-AGENT-POLICY-234';
import { subResources as sdk03runcontrol235 } from './declarations/SDK-03-RUN-CONTROL-235';
import { subResources as sdk05auth237 } from './declarations/SDK-05-AUTH-237';
import { subResources as sdk19presignedfiles251 } from './declarations/SDK-19-PRESIGNED-FILES-251';
import { subResources as sdk19skillrevisions251 } from './declarations/SDK-19-SKILL-REVISIONS-251';
import { subResources as sto503storageconnections1690 } from './declarations/STO-503-STORAGE-CONNECTIONS-1690';
import { subResources as w1cp05 } from './declarations/W1-CP-05';
import { subResources as w2cp05 } from './declarations/W2-CP-05';
import { subResources as w2cp07 } from './declarations/W2-CP-07';
import { subResources as w4cp08 } from './declarations/W4-CP-08';
import { subResources as w5cp02 } from './declarations/W5-CP-02';
import { subResources as w9proj183 } from './declarations/W9-PROJ-183';
import { subResources as w9prov126 } from './declarations/W9-PROV-126';
import { subResources as w9team121 } from './declarations/W9-TEAM-121';
import type { Resource } from './resources';

/**
 * One task's claim that a sub segment belongs to a resource §21's table already classifies.
 *
 * `because` is not decoration. `permissions.ts`'s every entry carries the sentence of §21 it comes
 * from, and a declaration written elsewhere has to carry the same evidence or the partition would
 * be a way to add classifications without stating a reason for them.
 */
export interface SubResourceDeclaration {
  /** The task that ships the routes. Must equal the declaring file's name stem. */
  readonly owner: string;
  /** The parent resource, which §21's table must already classify. */
  readonly resource: Resource;
  /** The `<sub>` segment of `/api/<resource>/:id/<sub>`. */
  readonly sub: string;
  /** The reading of §21 that puts this segment inside its parent rather than beside it. */
  readonly because: string;
}

/**
 * Every declaration, from every tracked file under `declarations/`.
 *
 * One entry per import above. `tests/permission-declarations.test.ts` asserts this list against the
 * tracked tree, so a file added without a line here fails rather than contributing nothing.
 */
export const DECLARED_SUB_RESOURCES: readonly SubResourceDeclaration[] = [
  ...dj8008promoterollback615,
  ...dj8011evaluations618,
  ...dj8013feedbacklist620,
  ...djs105agentversions443,
  ...djs106agentpointers444,
  ...djs205crunfeedback539,
  ...eng06sessionstate305,
  ...p54runapproval1301,
  ...p72surfaceattachments1308,
  ...p84filesearch1314,
  ...ptt1aendpointclients,
  ...ptt1coauth,
  ...pttriggers1293,
  ...ptu5platformexports968,
  ...sdk02agentpolicy234,
  ...sdk03runcontrol235,
  ...sdk05auth237,
  ...sdk19presignedfiles251,
  ...sdk19skillrevisions251,
  ...sto503storageconnections1690,
  ...w1cp05,
  ...w2cp05,
  ...w2cp07,
  ...w4cp08,
  ...w5cp02,
  ...w9proj183,
  ...w9prov126,
  ...w9team121,
];

/**
 * §21's table plus the declarations, as one total record.
 *
 * Total over `Resource` by construction: the result is a spread of `base`, which `permissions.ts`
 * declares as a total record literal, so a resource with no declaration keeps its own list and a
 * resource nobody thought about is still the empty list that refuses every sub segment under it.
 *
 * A duplicate **throws**, and the throw is the point. Two tasks classifying the same
 * `(resource, sub)` pair is two tasks having made the same decision separately, which is the state
 * the partition exists to make impossible; silently de-duplicating would keep the program running
 * and lose the fact that it happened. The condition is static — it depends on nothing but the
 * tracked files — so this cannot fire in production without having fired in `pnpm build` and
 * `pnpm test` on the same commit first.
 */
export function composeSubResources(
  base: Readonly<Record<Resource, readonly string[]>>,
  declarations: readonly SubResourceDeclaration[],
): Readonly<Record<Resource, readonly string[]>> {
  const composed = { ...base };
  const seen = new Map<string, string>();
  // `Object.entries`, not a list of resources imported from `permissions.ts`: that import would be
  // a value edge back into the module this one is imported by, and the cycle is avoidable by
  // reading the record this function was handed instead of a second copy of its key set.
  for (const [resource, subs] of Object.entries(base)) {
    for (const sub of subs) seen.set(`${resource}/${sub}`, 'apps/web/server/rbac/permissions.ts');
  }
  for (const declaration of declarations) {
    const pair = `${declaration.resource}/${declaration.sub}`;
    const already = seen.get(pair);
    if (already !== undefined) {
      throw new Error(
        `${declaration.owner} declares "${declaration.sub}" as a sub-resource of ` +
          `"${declaration.resource}", and ${already} already classifies it. One classification per ` +
          `(resource, sub) pair: two tasks deciding the same thing separately is what ` +
          `apps/web/server/rbac/declared-sub-resources.ts exists to prevent, so this is refused ` +
          `rather than de-duplicated.`,
      );
    }
    seen.set(pair, `apps/web/server/rbac/declarations/${declaration.owner}.ts`);
    composed[declaration.resource] = [...composed[declaration.resource], declaration.sub];
  }
  return Object.freeze(composed);
}
