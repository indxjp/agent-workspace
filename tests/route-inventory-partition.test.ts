import { describe, expect, it } from 'vitest';
import { declarationOwner, readDeclarationArray } from './inventory-support.js';
import type { DeclarationFile } from './inventory-support.js';
import {
  ROUTE_DECLARATIONS,
  unionRoutes,
  key,
  validateRouteEntry,
} from './route-declaration-reader.js';

describe('the partition fails closed, in both of the two ways it can fail open', () => {
  // ADR-0025 §3's two guards, executed rather than described. Both are proved against the same
  // functions the live gate went through at module scope, on synthetic inputs, so neither proof
  // needs a file planted in the repository — this file's oldest rule (ADR-0019 §4).

  it('refuses a declaration file that exports nothing readable', () => {
    // Four spellings of "nothing readable", each a different way a file could arrive empty-handed:
    // no export, a misnamed export, an array of no entries, and a body that is not data at all.
    // A gate that treated any of them as "this task ships no routes" would be deciding on the
    // absence of a negative (ADR-0015).
    expect(() =>
      readDeclarationArray(
        'export const other = [];\n',
        'tests/route-declarations/W9-XX-01.ts',
        'routes',
      ),
    ).toThrow(/exports no readable "routes" array/);
    expect(() =>
      readDeclarationArray(
        '// nothing here at all\n',
        'tests/route-declarations/W9-XX-01.ts',
        'routes',
      ),
    ).toThrow(/exports no readable "routes" array/);
    expect(() =>
      readDeclarationArray(
        'export const routes = [];\n',
        'tests/route-declarations/W9-XX-01.ts',
        'routes',
      ),
    ).toThrow(/declares no entries/);
    expect(() =>
      readDeclarationArray(
        'export const routes = [buildRoutes()];\n',
        'tests/route-declarations/W9-XX-01.ts',
        'routes',
      ),
    ).toThrow(/is not a value this reader can read/);
  });

  it('refuses a file in the declaration directory that is not a task’s declaration', () => {
    // ADR-0027 §2 and §3: the rule that enumerates the partition is a classifier, so a file at the
    // right path with the wrong shape is a hard failure naming it, never a skip. If it were a
    // filter over the `git ls-files` listing, each of these would be dropped and the gate would
    // stay green — which is how a literal member list came to look like the safer option.
    expect(() =>
      declarationOwner('tests/route-declarations/README.md', ROUTE_DECLARATIONS),
    ).toThrow(/holds one TypeScript declaration file per owning task/);
    expect(() => declarationOwner('tests/route-declarations/types.ts', ROUTE_DECLARATIONS)).toThrow(
      /"types" is not a task id/,
    );
    expect(() =>
      declarationOwner('tests/route-declarations/wave2/W2-CP-02.ts', ROUTE_DECLARATIONS),
    ).toThrow(/one flat directory of <TASK-ID>\.ts files/);
    expect(() => declarationOwner('tests/inventory-support.ts', ROUTE_DECLARATIONS)).toThrow(
      /is not under tests\/route-declarations\//,
    );
    // …and a real declaration file is accepted, so the classifier is not satisfied by rejecting
    // everything. `W2-CP-02` is a task that has not landed: the rule is about the shape of the
    // name, not about a list of the names that exist today.
    expect(declarationOwner('tests/route-declarations/W2-CP-02.ts', ROUTE_DECLARATIONS)).toBe(
      'W2-CP-02',
    );
  });

  it('refuses two files declaring the same route, and names both owners', () => {
    const first: DeclarationFile = {
      repoPath: 'tests/route-declarations/W2-CP-03.ts',
      owner: 'W2-CP-03',
      entries: [{ method: 'GET', path: '/api/files', owner: 'W2-CP-03', landed: false }],
    };
    const second: DeclarationFile = {
      repoPath: 'tests/route-declarations/W2-CP-04.ts',
      owner: 'W2-CP-04',
      entries: [{ method: 'GET', path: '/api/files', owner: 'W2-CP-04', landed: false }],
    };
    expect(() => unionRoutes([first, second])).toThrow(/W2-CP-03/);
    expect(() => unionRoutes([first, second])).toThrow(/W2-CP-04/);
    expect(() => unionRoutes([first, second])).toThrow(
      /GET \/api\/files is declared twice: by W2-CP-03 in tests\/route-declarations\/W2-CP-03\.ts and by W2-CP-04 in tests\/route-declarations\/W2-CP-04\.ts/,
    );
    // …and the same route declared once is not a duplicate, which is what stops the guard from
    // being satisfied by rejecting everything.
    expect(unionRoutes([first]).map(key)).toEqual(['GET /api/files']);
  });

  it('refuses a declaration file that speaks for another task', () => {
    expect(() =>
      validateRouteEntry(
        { method: 'GET', path: '/api/files', owner: 'W2-CP-03', landed: false },
        'tests/route-declarations/W2-CP-04.ts',
        'W2-CP-04',
      ),
    ).toThrow(/declares owner "W2-CP-03" in tests\/route-declarations\/W2-CP-04\.ts/);
  });

  it('refuses an entry whose fields are absent, mistyped, or unread', () => {
    const file = 'tests/route-declarations/W2-CP-03.ts';
    expect(() =>
      validateRouteEntry({ path: '/api/files', owner: 'W2-CP-03', landed: true }, file, 'W2-CP-03'),
    ).toThrow(/"method" must be a non-empty string/);
    expect(() =>
      validateRouteEntry(
        { method: 'FETCH', path: '/api/files', owner: 'W2-CP-03', landed: true },
        file,
        'W2-CP-03',
      ),
    ).toThrow(/is not an HTTP method Next\.js serves/);
    expect(() =>
      validateRouteEntry(
        { method: 'GET', path: '/api/files', owner: 'W2-CP-03' },
        file,
        'W2-CP-03',
      ),
    ).toThrow(/"landed" must be true or false/);
    expect(() =>
      validateRouteEntry(
        { method: 'GET', path: '/api/files', owner: 'W2-CP-03', landed: true, note: 'later' },
        file,
        'W2-CP-03',
      ),
    ).toThrow(/carries note, which no part of this gate reads/);
  });
});
