import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_PREFIX,
  DEFAULT_PAGE_EXTENSIONS,
  NEXT_CONFIG_FILENAMES,
  PAGE_EXTENSIONS_KNOB,
  REPO_ROOT,
  WEB_DIR,
  filterPageFiles,
  gateModules,
  nonReadingFsAccess,
  pageExtensions,
  trackedFiles,
} from './inventory-support.js';
import { classifyAppFile, key } from './route-declaration-reader.js';
import { filterRouteFiles, routeSurface } from './route-files.js';
import { routeFiles, EXPECTED_ROUTES, actual } from './route-inventory-state.js';

describe('the set of files treated as route handlers is derived, not transcribed', () => {
  it('refuses to guess when apps/web configures a pageExtensions of its own', () => {
    const extensions = pageExtensions();
    // Positive assertions about the extensions that decide this gate's blind spots. `jsx` is
    // named literally because omitting it is the defect this describe block exists to prevent:
    // `apps/web/app/api/agents/sneaky/route.jsx` was served by Next (`next typegen` emitted
    // "/api/agents/sneaky") while the gate stayed green at 13/13.
    expect(extensions.has('jsx')).toBe(true);
    expect(extensions.has('ts')).toBe(true);
    expect([...extensions].sort()).toEqual([...DEFAULT_PAGE_EXTENSIONS].sort());
    // And the guard that makes the line above an assertion rather than an assumption: the config
    // this gate read really does leave the knob unset, checked by reading it.
    const configs = NEXT_CONFIG_FILENAMES.map((name) => path.join(WEB_DIR, name)).filter((file) =>
      existsSync(file),
    );
    expect(configs.map((file) => path.basename(file))).toEqual(['next.config.ts']);
    expect(readFileSync(configs[0] as string, 'utf8')).not.toContain(PAGE_EXTENSIONS_KNOB);
  });

  it('treats every configured extension as a route handler, and rejects the rest', () => {
    const extensions = pageExtensions();
    for (const extension of extensions) {
      expect(classifyAppFile(`route.${extension}`, extensions, 'x'), `route.${extension}`).toBe(
        'route',
      );
    }
    // Not a route file name at all: skipped quietly, which is correct — Next serves neither as a
    // route handler and neither is called `route.*`.
    expect(classifyAppFile('page.tsx', extensions, 'x')).toBe('ignore');
    expect(classifyAppFile('layout.tsx', extensions, 'x')).toBe('ignore');
    // Named `route.*` but not an extension this application serves. Rejected loudly rather than
    // skipped: the reader cannot decide, so it must not decide "not a route". `route.mjs` is the
    // concrete case — the previous hand-written list read it, and `next typegen` proves Next does
    // not serve it under the default pageExtensions.
    expect(() => classifyAppFile('route.mjs', new Set(['tsx', 'ts', 'jsx', 'js']), 'x')).toThrow(
      /not one of the pageExtensions/,
    );
    expect(() => classifyAppFile('route.test.ts', extensions, 'x')).toThrow(
      /not one of the pageExtensions/,
    );
    expect(() => classifyAppFile('route.', extensions, 'x')).toThrow(
      /not one of the pageExtensions/,
    );
  });

  it('excludes every tracked page file, which is the screen inventory’s half', () => {
    // Stated in this file's header since W1-INT-02 — "`page.tsx` is a screen, not an API route" —
    // and asserted here since W2-INT-00, over the real tracked pages rather than one literal name.
    // `tests/screen-inventory.test.ts` asserts the other direction: that each of these pages is
    // declared as a screen. Neither gate may quietly stop seeing what the other assumes it sees,
    // and since the repair of ADR-0027 they read the page set through one function —
    // `filterPageFiles`, the twin of `filterRouteFiles` — rather than each applying its own filter.
    const extensions = pageExtensions();
    const pages = filterPageFiles(trackedFiles(APP_PREFIX), extensions);
    expect(pages.length, 'apps/web/app tracks no page file at all').toBeGreaterThan(0);
    expect(filterRouteFiles(pages, extensions), 'a page is not a route handler').toEqual([]);
  });

  it('reports an undeclared route.jsx that Next.js would serve', () => {
    // The acceptance criterion, executed rather than asserted in prose: hand the live gate's own
    // two functions the exact file that defeated the first version of this gate — a `route.jsx`
    // under `apps/web/app/api/agents/` — and prove it is seen, and that it is not in the union of
    // the declaration files, which is what turns the equality assertion above red.
    //
    // It is a synthetic entry rather than a real file on disk, and that is the whole repair of the
    // Wave 1a race: the previous version planted it under `apps/web/app/api/agents/` with
    // `mkdtempSync` while `tests/auth.test.ts` was walking that directory in a parallel worker.
    // See ADR-0019 §4 and this file's header.
    const probePath = `${APP_PREFIX}/api/agents/inventory-probe/route.jsx`;
    const kept = filterRouteFiles(
      [...routeFiles.map((file) => file.repoPath), probePath],
      pageExtensions(),
    );
    expect(kept, 'the filter must not drop a route.jsx').toContain(probePath);

    const withProbe = routeSurface([
      ...routeFiles,
      {
        repoPath: probePath,
        source: 'export async function GET() { return new Response("undeclared"); }\n',
      },
    ]);
    const probeRoute = 'GET /api/agents/inventory-probe';
    expect([...withProbe]).toContain(probeRoute);

    const landed = new Set(EXPECTED_ROUTES.filter((entry) => entry.landed).map(key));
    expect(landed.has(probeRoute)).toBe(false);
    expect([...withProbe].filter((route) => !landed.has(route))).toEqual([probeRoute]);

    // …and the real surface, with no probe in it, is exactly the declared one. This is the same
    // comparison the gate makes above, repeated here so that the two halves of the proof — "the
    // probe is reported" and "nothing else is" — sit next to each other.
    expect([...actual].filter((route) => !landed.has(route))).toEqual([]);
  });

  it('does not report a route file that Next.js serves from no URL', () => {
    // The other side of the filter: a `route.ts` under an underscore-prefixed folder is not
    // served, and a gate that reported it would fail on a file that ships nothing.
    const hidden = `${APP_PREFIX}/api/_hidden/leak/route.ts`;
    expect(filterRouteFiles([hidden], pageExtensions())).toEqual([]);
  });

  it('writes nothing into the repository tree', () => {
    // Asserted mechanically, not promised in a comment. The Wave 1a race was this file planting a
    // fixture under `apps/web/app` while a sibling walked it; the repair is structural, and this
    // is the assertion that keeps it structural. `readFileSync` and `existsSync` are the only fs
    // calls it needs.
    //
    // The scanned set is this gate's import graph. Round 2 wrote the two file names down instead,
    // and a verifier walked out of the list: a tracked `tests/inventory-extra.ts` holding a
    // `mkdirSync` call, imported from `tests/inventory-support.ts`, left both gates at 61 passed.
    const modules = gateModules('tests/route-inventory.test.ts');
    expect(modules, 'the import scan found no module beyond the gate itself').not.toEqual([
      'tests/route-inventory.test.ts',
    ]);
    for (const module of modules) {
      const source = readFileSync(path.join(REPO_ROOT, module), 'utf8');
      expect(
        nonReadingFsAccess(source),
        `${module} must not mutate the tree it asserts over — ADR-0019 §4`,
      ).toEqual([]);
    }
  });
});
