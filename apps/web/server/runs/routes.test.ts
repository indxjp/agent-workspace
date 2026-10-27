/**
 * W1-CP-04's three §34 run endpoints, checked against the three files this task wrote.
 *
 * ## What moved out of this file, and why
 *
 * This file used to walk `apps/web/app/api` and assert a **closed world** over it: that the routes
 * found there were *exactly* the three W1-CP-04 owns, that nothing else existed under the agents
 * tree, and that every route file in the tree declared its runtime and built no stream of its own.
 * Every one of those assertions was correct and none of them was this task's to make: the walk saw
 * `apps/web/app/api/agents/route.ts` and `[id]/route.ts`, which belong to W1-CP-05, and on the
 * Wave 1a union three of them failed on files this task cannot see, let alone edit.
 *
 * [ADR-0019](../../../../docs/adr/0019-repo-wide-gates-belong-to-the-integration-level.md) rules
 * that a test asserting a property of the whole repository is owned at the integration level. All
 * four assertions therefore now live in `tests/route-inventory.test.ts`, over the tracked tree,
 * where the whole route surface is visible — the two whole-tree loops with their reasons intact, and
 * the two closed-world equalities as the stronger three-way comparison that file already makes
 * against spec §34 itself.
 *
 * They were **moved, not narrowed**. Narrowing a closed-world gate to its author's subtree is the
 * fail-open shape ADR-0015 exists to stop: a route-inventory gate that only checks part of the
 * inventory cannot catch the route nobody declared, which is its entire purpose.
 *
 * ## What is left here
 *
 * ADR-0019 §2: a feature task may still test its **own** files, as long as it does not assert
 * completeness over files it cannot see. So what remains is a positive existence claim — these
 * three files exist, at these paths, exporting exactly these methods — which is about W1-CP-04's
 * work and stays true no matter what any other task adds to the tree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const API_DIR = fileURLToPath(new URL('../../app/api', import.meta.url));

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

function exportedMethods(source: string): string[] {
  return HTTP_METHODS.filter((method) =>
    // Both forms Next.js serves: a declared handler, or one wrapped by `server/http/route.ts`.
    new RegExp(`export\\s+(?:(?:async\\s+)?function\\s+${method}\\b|const\\s+${method}\\s*=)`).test(
      source,
    ),
  );
}

/**
 * The route files W1-CP-04 wrote, and the two SDK-03-RUN-CONTROL-235 added (issue #235):
 * `runs/[id]/interrupt` (S-14) and `runs/[id]/revoke-tokens` (S-15, the same handler as the
 * deprecated `runs/[id]` `POST`). Each owes the §34 methods named beside it.
 */
const OWNED_ROUTES: ReadonlyArray<readonly [file: string, methods: readonly string[]]> = [
  ['runs/[id]/route.ts', ['GET', 'POST']],
  ['runs/[id]/events/route.ts', ['GET']],
  ['runs/[id]/interrupt/route.ts', ['POST']],
  ['runs/[id]/approval/route.ts', ['POST']],
  ['runs/[id]/revoke-tokens/route.ts', ['POST']],
  ['agents/[id]/runs/route.ts', ['POST']],
];

describe('the run endpoints these tasks own', () => {
  it.each(OWNED_ROUTES)('%s exports exactly %s', (file, methods) => {
    const absolute = `${API_DIR}/${file}`;
    expect(existsSync(absolute), `${file} is missing`).toBe(true);
    expect(exportedMethods(readFileSync(absolute, 'utf8'))).toEqual([...methods]);
  });

  it('puts exactly one file under the agents tree, the one ADR-0013 assigns here', () => {
    // A containment claim about this task's own footprint, not a closed world over `app/api`:
    // W1-CP-05 owns everything else beneath `agents/`, and `tests/route-inventory.test.ts` is
    // what asserts that nothing undeclared appears there.
    const mine = OWNED_ROUTES.map(([file]) => file).filter((file) => file.startsWith('agents/'));
    expect(mine).toEqual(['agents/[id]/runs/route.ts']);
  });
});
