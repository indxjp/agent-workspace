/**
 * W1-UI-04 · the agent list and the new-agent form (spec §17).
 *
 * `ui/agent-new.html` is the mockup for a five-step wizard; what shipped is one step, and that is
 * `docs/adr/W1-UI-04-a-simplified-form-not-the-wizard.md`. The screen inventory asserts that the
 * mockup has a route, not that the route is finished — W2-CP-12 completes the wizard behind the
 * same URL, and the declaration does not move when it does.
 */
import type { ScreenDeclaration } from '../inventory-support.js';

export const screens: readonly ScreenDeclaration[] = [
  {
    mockup: 'ui/agents.html',
    owner: 'W1-UI-04',
    status: 'shipped',
    route: '/agents',
    page: 'apps/web/app/(shell)/agents/page.tsx',
  },
  {
    mockup: 'ui/agent-new.html',
    owner: 'W1-UI-04',
    status: 'shipped',
    route: '/agents/new',
    page: 'apps/web/app/(shell)/agents/new/page.tsx',
  },
];
