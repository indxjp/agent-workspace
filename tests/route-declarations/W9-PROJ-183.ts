import type { RouteDeclaration } from '../inventory-support.js';

/**
 * Issue #183's two project lifecycle routes.
 *
 * Both cite spec **§3**, per
 * `docs/adr/W9-PLAN-project-lifecycle-routes-need-their-inventory-declaration.md`: §3 requires the
 * platform to manage Projects, and issue #124 is the binding work item that makes the missing
 * lifecycle management concrete as archive and restore while preserving history. Neither route is
 * printed by §34, and neither `because` claims it is.
 *
 * That ADR assigned the file to `W9-PROJ-124` before #124 was split into its W9-R children; the
 * routes ship from #183, so the declaration is named for the task that ships them, matching the
 * `W9-PROJ-182` id its sibling repository task used.
 */
export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/projects/:id/archive',
    owner: 'W9-PROJ-183',
    landed: true,
    mandate: {
      section: '3',
      because:
        'Section 3 names Projects among what the platform must manage; issue #124 refines that management to a non-destructive archive that keeps session and run history attributed.',
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/restore',
    owner: 'W9-PROJ-183',
    landed: true,
    mandate: {
      section: '3',
      because:
        'The inverse transition of the same Section 3 management requirement: an archive a workspace cannot undo is the deletion issue #124 explicitly refuses to perform.',
    },
  },
];
