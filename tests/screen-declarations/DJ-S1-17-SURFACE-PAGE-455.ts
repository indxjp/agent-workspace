import type { ScreenDeclaration } from '../inventory-support.js';

// Developer-journey unit S1-17 (issue #455): the hosted surface page that defineSurface() serves at
// /p/s/<name>, same origin and loopback only in slice 1 (ADR-0105). It renders under the /p layout,
// which carries the driver banner.
export const screens: readonly ScreenDeclaration[] = [
  {
    mockup: 'ui/surface-chat.html',
    owner: 'DJ-S1-17-SURFACE-PAGE-455',
    status: 'shipped',
    route: '/p/s/:name',
    page: 'apps/web/app/p/s/[name]/page.tsx',
  },
];
