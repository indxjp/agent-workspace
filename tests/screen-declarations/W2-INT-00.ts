/**
 * W2-INT-00 · every `ui/*.html` that no Wave 2 task will touch.
 *
 * Three kinds of entry, and the difference between them is checked rather than asserted. The gate
 * reads the development plan and the wave plans and works out, for each mockup, whether a
 * wave's task cards name it:
 *
 *   * **`planned`** — a task card in a wave section names the mockup, and `wave` must be the wave
 *     that section is. The number is therefore derived from the plan, not estimated here.
 *   * **`unplanned`** — no wave section names the mockup at all. A finding, not a schedule. Writing
 *     a wave number would be a measured claim with no measurement behind it
 *     ([ADR-0016](../../docs/adr/0016-measured-numbers-do-not-live-in-prose.md)), and the gate
 *     refuses one here: an `unplanned` entry the plan *does* schedule fails, and so does a
 *     `planned` entry it does not.
 *   * **`not-a-screen`** — the file is in `ui/` and is not a product screen.
 *
 * Why the later waves' deferrals sit in this file rather than in a future task's: those waves are
 * not dispatched, so their task ids are the plan's guess rather than a dispatched fact. Wave 2's
 * four UI tasks *are* dispatched, and their deferrals were seeded into their own files
 * (`tests/screen-declarations/W2-UI-08.ts` and its siblings) so that flipping one to `shipped` is an
 * edit inside that task's own `Owns` glob. The wave that dispatches W3, W4, W5 or W7 repartitions
 * its rows out of here, exactly as W2-INT-00 repartitioned Wave 1's route entries out of
 * `tests/route-inventory.test.ts`.
 *
 * See `docs/adr/W2-INT-00-the-screen-inventory-declares-mockups-by-owner.md`.
 */
import type { ScreenDeclaration } from '../inventory-support.js';

export const screens: readonly ScreenDeclaration[] = [
  // ── Wave 3 — the runtime layer ────────────────────────────────────────────────────────────
  // ── Wave 4 — the model gateway ────────────────────────────────────────────────────────────
  // ── Wave 5 — projects and sharing ─────────────────────────────────────────────────────────
  // W2-plan.md's "What Wave 2 does not close" says the same thing a second time: projects and
  // sharing are §20.5, §20.6 and Wave 5, and this wave does not pre-create them.
  // ── No wave section names these three ─────────────────────────────────────────────────────
  // Not a judgement: the gate re-derives it, and an `unplanned` entry that the plan turns out to
  // schedule fails just as loudly as a `planned` entry it does not.
  {
    mockup: 'ui/agent.html',
    owner: 'W2-INT-00',
    status: 'shipped',
    route: '/agents/:id',
    page: 'apps/web/app/(shell)/agents/[id]/page.tsx',
  },
  {
    mockup: 'ui/run.html',
    owner: 'W2-INT-00',
    status: 'shipped',
    route: '/runs',
    page: 'apps/web/app/(shell)/runs/page.tsx',
  },

  // ── In ui/, not a product screen ──────────────────────────────────────────────────────────
  {
    mockup: 'ui/index.html',
    owner: 'W2-INT-00',
    status: 'not-a-screen',
    because:
      'The mockup index — the development plan §1.2 calls it the screen inventory. It links the screens; it is not one, and the gate checks that the links and the declarations agree.',
  },
];
