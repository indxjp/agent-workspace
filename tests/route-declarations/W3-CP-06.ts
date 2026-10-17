/**
 * W3-CP-06 · runtime profiles CRUD and runtime connections — spec §15, §14.9, §34.
 *
 * `GET /api/runtime-profiles` and `POST /api/runtime-profiles` are printed verbatim in spec §34's
 * example list and therefore carry no `mandate` — under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2, a mandate on a route §34 already prints fails the gate.
 *
 * The three `/:id` routes are not in §34's list (only the collection routes are), so each cites
 * §15.1: a runtime profile is a persisted, named resource with individually-editable fields — the
 * "CRUD" this task's cell asks for is reading, changing and removing one profile at a time, which
 * needs routes §34's own printed list does not carry.
 *
 * `/api/runtime-connections` is not in §34 at all. Both of its routes cite §14.9's own words: "A
 * runtime connection exists — endpoint + credentials, stored as a secret" — the sentence that
 * requires connections to be creatable and listable in the first place. See
 * `apps/web/server/runtimes/connections.ts`'s header for why this resource has no table of its own.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  { method: 'GET', path: '/api/runtime-profiles', owner: 'W3-CP-06', landed: true },
  { method: 'POST', path: '/api/runtime-profiles', owner: 'W3-CP-06', landed: true },
  {
    method: 'GET',
    path: '/api/runtime-profiles/:id',
    owner: 'W3-CP-06',
    landed: true,
    mandate: {
      section: '15',
      because:
        'A runtime profile is a persisted, named resource with individually-editable fields; reading one by id is part of the CRUD this task asks for.',
    },
  },
  {
    method: 'PATCH',
    path: '/api/runtime-profiles/:id',
    owner: 'W3-CP-06',
    landed: true,
    mandate: {
      section: '15',
      because:
        "Operators change a profile's resource limits and network policy over time; section 15.1's schema is what a PATCH body is validated against.",
    },
  },
  {
    method: 'DELETE',
    path: '/api/runtime-profiles/:id',
    owner: 'W3-CP-06',
    landed: true,
    mandate: {
      section: '15',
      because:
        "A profile no longer in use must be removable; section 14.9's profile-reference design means deleting one leaves any agent that named it pointing at nothing, never blocked.",
    },
  },
  {
    method: 'GET',
    path: '/api/runtime-connections',
    owner: 'W3-CP-06',
    landed: true,
    mandate: {
      section: '14',
      because:
        "A runtime connection existing is a fact the runtime picker and this task's own second test need to check, which needs a way to list what is configured.",
    },
  },
  {
    method: 'POST',
    path: '/api/runtime-connections',
    owner: 'W3-CP-06',
    landed: true,
    mandate: {
      section: '14',
      because:
        'A runtime connection exists, endpoint plus credentials, stored as a secret is the sentence this route exists to satisfy: an operator must be able to create one.',
    },
  },
];
