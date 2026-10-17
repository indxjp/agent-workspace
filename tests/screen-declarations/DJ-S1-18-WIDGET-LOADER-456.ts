import type { ScreenDeclaration } from '../inventory-support.js';

// Developer-journey unit S1-18 (issue #456): the try page at /p/s/<name>/try, a host page whose body
// is the one widget.js script tag (ADR-0105). It renders under the /p layout, which carries the
// driver banner.
export const screens: readonly ScreenDeclaration[] = [
  {
    mockup: 'ui/surface-widget.html',
    owner: 'DJ-S1-18-WIDGET-LOADER-456',
    status: 'shipped',
    route: '/p/s/:name/try',
    page: 'apps/web/app/p/s/[name]/try/page.tsx',
  },
];
