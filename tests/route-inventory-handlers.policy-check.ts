import { describe, expect, it } from 'vitest';
import { routeFiles } from './route-inventory-state.js';
import { exportedStringConstant, streamOffenders } from './route-source-reader.js';

describe('every route handler in the repository, whoever wrote it', () => {
  // These two invariants arrived as loops inside `apps/web/server/runs/routes.test.ts`, W1-CP-04's
  // file, where they ranged over every route under `apps/web/app/api` — including the two agent
  // route files W1-CP-05 owns, which is how they came to fail on the Wave 1a union. They are
  // repository-wide claims and they are correct; ADR-0019 says the fix is to move them to where
  // the whole tree is visible, not to narrow them to their author's subtree.

  it('runs every route on the Node runtime and never prerenders one', () => {
    // 'edge' is deprecated and cannot hold a long-lived stream (R-13). `force-dynamic` is what
    // stops Next from prerendering a handler that reads a session cookie.
    //
    // Read as exports, not as text the file happens to contain. Round 2 asked each file whether it
    // `includes` the two declarations spelled out in full, and round 3's counter-example turned the
    // real `apps/web/app/api/agents/route.ts` into `export const runtime = 'edge';` with the nodejs
    // spelling left above it on a commented-out line: the gate stayed at 35 passed.
    const wrong: string[] = [];
    for (const file of routeFiles) {
      for (const [name, required] of [
        ['runtime', 'nodejs'],
        ['dynamic', 'force-dynamic'],
      ] as const) {
        const declared = exportedStringConstant(file.source, name, file.repoPath);
        if (declared !== required) {
          wrong.push(`${file.repoPath}: ${name} is ${declared ?? 'not exported'}, not ${required}`);
        }
      }
    }
    expect(wrong, 'route files that do not declare their runtime').toEqual([]);
  });

  it('keeps the streaming pattern out of the route files', () => {
    // Spec §19.5 rule 5 forbids a second chat implementation; the same rule is applied to the
    // stream. A route handler that builds its own ReadableStream is a second SSE implementation
    // and the next one copied from it will drift.
    //
    // The rule is the identifier on a line of code, not the one spelling `new ReadableStream`.
    // Round 3 appended `new globalThis.ReadableStream<Uint8Array>({ start() {} })` to
    // `apps/web/app/api/runs/[id]/route.ts` and the gate stayed at 35 passed. A line that is
    // entirely a comment is exempt,
    // because naming the rule is how `apps/web/app/api/runs/[id]/events/route.ts` states it — a
    // trailing comment on a line of code is not exempt, which is the fail-closed direction.
    expect(streamOffenders(routeFiles), 'route files that build their own stream').toEqual([]);
  });
});
