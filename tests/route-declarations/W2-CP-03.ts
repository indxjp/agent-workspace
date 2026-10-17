/**
 * W2-CP-03 · files · spec §16, §34.
 *
 * `GET`/`POST /api/files` are printed verbatim in spec §34, so neither carries a `mandate`
 * (ADR-0026 decision 2). `GET`, `DELETE` and `PATCH /api/files/:id` are not in §34's own list —
 * only bare `/api/files` is — so each cites §16, which is where "download", "delete" and "rename"
 * are the specification's own words for what these three do.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  { method: 'GET', path: '/api/files', owner: 'W2-CP-03', landed: true },
  { method: 'POST', path: '/api/files', owner: 'W2-CP-03', landed: true },
  {
    method: 'GET',
    path: '/api/files/:id',
    owner: 'W2-CP-03',
    landed: true,
    mandate: {
      section: '16',
      because:
        'spec §16 lists "download" among the Files UI operations; §34 prints only bare GET/POST /api/files.',
    },
  },
  {
    method: 'DELETE',
    path: '/api/files/:id',
    owner: 'W2-CP-03',
    landed: true,
    mandate: {
      section: '16',
      because:
        'spec §16 lists "delete" among the Files UI operations; §34 prints only bare GET/POST /api/files.',
    },
  },
  {
    method: 'PATCH',
    path: '/api/files/:id',
    owner: 'W2-CP-03',
    landed: true,
    mandate: {
      section: '16',
      because:
        'spec §16 lists "rename" among the Files UI operations; §34 prints only bare GET/POST /api/files.',
    },
  },
];
