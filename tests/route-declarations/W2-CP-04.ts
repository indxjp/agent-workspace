/**
 * W2-CP-04 · skills · spec §7, §34.
 *
 * `GET`/`POST /api/skills` are printed verbatim in spec §34, so neither carries a `mandate`
 * (ADR-0026 decision 2). `GET`/`PATCH /api/skills/:name` are not in §34's own list — only bare
 * `/api/skills` is — so each cites §7, which is where "create a skill", "edit a skill", "upload
 * supporting files", "enable/disable it", "export it" and "import an existing Claude skill
 * directory" are the specification's own words for what these four routes do.
 * `apps/web/server/skills/handlers.ts`'s header explains why four routes cover six of the seven
 * §7 bullets, and why "assign it to agents" has no route at all (a declared gap, not an
 * oversight). `GET /api/skills/:name`'s own header explains why "export it" is a query flag
 * (`?export=true`) on this same route rather than a fifth, `/:name/export`-shaped one.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  { method: 'GET', path: '/api/skills', owner: 'W2-CP-04', landed: true },
  { method: 'POST', path: '/api/skills', owner: 'W2-CP-04', landed: true },
  {
    method: 'GET',
    path: '/api/skills/:name',
    owner: 'W2-CP-04',
    landed: true,
    mandate: {
      section: '7',
      because:
        'spec §7 says selecting a skill shows its name, description, instructions, supporting files and allowed tools, and separately lists "export it"; both are this one route (plain, and with ?export=true respectively). §34 prints only bare GET/POST /api/skills.',
    },
  },
  {
    method: 'PATCH',
    path: '/api/skills/:name',
    owner: 'W2-CP-04',
    landed: true,
    mandate: {
      section: '7',
      because:
        'spec §7 lists "edit a skill", "upload supporting files" and "enable/disable it" among the Skills UI operations; §34 prints only bare GET/POST /api/skills.',
    },
  },
];
