/**
 * DJ-S1-18-WIDGET-LOADER-456 · the one-tag widget loader and its try page — issue #456
 * (developer journey S1-18), ADR-0105's look, layout and loader.
 *
 * Both are public paths under `/p/`, outside `/api`, so spec §34 prints them rather than a
 * `mandate` naming them: the `outside-api` rule admits only a path §34 prints.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  // `widget.js/route.ts` serves the loader script.
  {
    method: 'GET',
    path: '/p/s/:name/widget.js',
    owner: 'DJ-S1-18-WIDGET-LOADER-456',
    landed: true,
  },
  // `try/page.tsx` serves this GET. The route inventory deliberately counts route handlers only; the
  // screen inventory owns and verifies the public page.
  { method: 'GET', path: '/p/s/:name/try', owner: 'DJ-S1-18-WIDGET-LOADER-456', landed: false },
];
