/**
 * W2-UI-08 · Files, from `ui/files.html` (the Wave 2 plan §2c, spec §16).
 *
 * Seeded by W2-INT-00 as `planned`, and seeded **into this task's own file** rather than into the
 * inventory's, so that flipping it to `shipped` is an edit inside W2-UI-08's `Owns` glob. Four
 * parallel UI tasks each editing one shared list is the union failure
 * [ADR-0019](../../docs/adr/0019-repo-wide-gates-belong-to-the-integration-level.md) describes,
 * in a different costume; the partition of
 * [ADR-0025](../../docs/adr/0025-the-route-inventory-is-partitioned-by-owner.md) is what avoids it,
 * and a deferral that lived anywhere else would put it straight back.
 *
 * To ship it: replace `status`, `wave` and `because` with `status: 'shipped'`, the `route` the page
 * serves and the `page` file that serves it. The gate checks both against the tracked tree.
 */
import type { ScreenDeclaration } from '../inventory-support.js';

export const screens: readonly ScreenDeclaration[] = [
  {
    mockup: 'ui/files.html',
    owner: 'W2-UI-08',
    status: 'shipped',
    route: '/files',
    page: 'apps/web/app/(shell)/files/page.tsx',
  },
];
