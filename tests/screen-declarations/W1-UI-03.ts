/**
 * W1-UI-03 · the run view, from `ui/agent-run.html` (plan §6.3, spec §19).
 *
 * It is served at `/`, not at a route of its own, and that is spec §19.5 rule 5 rather than an
 * omission: `apps/web/components/composer/home-chat.tsx` returns `components/run/run-view.tsx`
 * once a run has started — *"if `screen.kind === 'run'` the component returns `RunView` and never
 * reaches the hero, the composer or the Recent list below"* — so the home page is the page that
 * serves this mockup. Two mockups naming one page file is therefore legal and is what the screen
 * inventory checks rather than assumes.
 *
 * See `docs/adr/W1-UI-03-the-seam-rule-5-needs-is-in-the-home-chat.md` and
 * `docs/adr/W1-UI-03-the-first-message-starts-a-screen-not-a-run.md`.
 */
import type { ScreenDeclaration } from '../inventory-support.js';

export const screens: readonly ScreenDeclaration[] = [
  {
    mockup: 'ui/agent-run.html',
    owner: 'W1-UI-03',
    status: 'shipped',
    route: '/',
    page: 'apps/web/app/(shell)/page.tsx',
  },
];
