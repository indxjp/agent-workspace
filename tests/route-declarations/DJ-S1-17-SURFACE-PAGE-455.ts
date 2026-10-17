/**
 * DJ-S1-17-SURFACE-PAGE-455 · the hosted surface page and its local session bootstrap — issue #455
 * (developer journey S1-17), ADR-0105's slice-1 acceptance.
 *
 * Both are public pages under `/p/`, outside `/api`, so spec §34 prints them rather than a
 * `mandate` naming them: the `outside-api` rule admits only a path §34 prints.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  // `page.tsx` serves this GET. The route inventory deliberately counts route handlers only; the
  // screen inventory owns and verifies the public page.
  { method: 'GET', path: '/p/s/:name', owner: 'DJ-S1-17-SURFACE-PAGE-455', landed: false },
  { method: 'POST', path: '/p/s/:name/sessions', owner: 'DJ-S1-17-SURFACE-PAGE-455', landed: true },
];
