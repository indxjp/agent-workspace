/** The tracked route surface must equal the declared, specification-backed API. */
import { readFileSync } from 'node:fs';

import { API_ROUTE_EXCLUSIONS } from '@indx-workspace/contracts/routes';
import { describe, expect, it } from 'vitest';
import {
  SPEC_PATH,
  declarationPaths,
  pageExtensions,
  specSections,
  trackedFiles,
} from './inventory-support.js';

import { ROUTE_DECLARATIONS, key } from './route-declaration-reader.js';
import { declarationFiles, EXPECTED_ROUTES, routeFiles, actual } from './route-inventory-state.js';
import { specRoutes, unparsedRequestLines, mandateFaults } from './route-specification.js';
import { filterRouteFiles } from './route-files.js';

describe('the route inventory equals the declared subset of spec §34', () => {
  it('reads every declaration file the tracked tree holds, derived by shape', () => {
    // ADR-0027 §1. This assertion used to be a literal list of the two declaration files that
    // existed when it was written, which is the alternative ADR-0025 rejected in writing: five of
    // Wave 2b's six tracks add `tests/route-declarations/<TASK-ID>.ts`, that file is outside every
    // one of their `Owns` globs, and a literal here would have turned this gate red on all five
    // with no branch able to make it green. The set is now `git ls-files` plus the filename rule.
    //
    // It is derived a second time and from a *wider* pathspec than `readDeclarationFiles` uses,
    // because the failure this assertion exists to catch is the enumerating call going narrow: a
    // `git ls-files` that returned a shorter list would satisfy every assertion below by having
    // nothing left to compare. The shape rule throws rather than filtering, so a `README.md` in
    // the directory is a failure naming the file (proved on a fixture below).
    const derived = declarationPaths(ROUTE_DECLARATIONS, 'tests');
    expect(
      declarationFiles.map((file) => file.repoPath),
      `derived from \`git ls-files -- tests\`: ${derived.join(', ')}`,
    ).toEqual(derived);
    expect(derived.length, `${ROUTE_DECLARATIONS} tracks no declaration file`).toBeGreaterThan(0);
    // …and every one of them contributed. A file read but silently empty is the other way the
    // union goes short, and `readDeclarationArray` refuses it — this is the assertion that says so.
    expect(
      declarationFiles.filter((file) => file.entries.length === 0).map((file) => file.repoPath),
      'these declaration files were read but declared nothing',
    ).toEqual([]);
    expect(EXPECTED_ROUTES.length).toBeGreaterThan(0);
  });

  it('reads spec §34 and finds the routes it prints', () => {
    const routes = specRoutes();
    // A positive assertion that the parse worked, rather than a transcribed count that would rot
    // the next time §34 is amended, and rather than a comparison against the declared surface —
    // which ADR-0026 makes structurally false, since a route §34 does not print ships legally with
    // a mandate. See `unparsedRequestLines` and ADR-0043.
    expect(routes.has('GET /api/agents')).toBe(true);
    // Every request line §34 prints became a route, decided by a second and looser reading of the
    // same fences. A parser that silently dropped one would shrink the spec side of every
    // comparison in this file and turn a mandate fault into a pass — the fail-open shape ADR-0015
    // exists to stop.
    expect(
      unparsedRequestLines(readFileSync(SPEC_PATH, 'utf8')),
      'lines in §34’s fenced blocks that look like request lines and yielded no route',
    ).toEqual([]);
  });

  it('reads the specification’s headings, so a mandate citation can be looked up', () => {
    const sections = specSections();
    expect(sections.has('34')).toBe(true);
    expect(sections.has('19.5')).toBe(true);
    expect(sections.has('16')).toBe(true);
    expect(sections.has('999')).toBe(false);
  });

  it('declares no route without the specification’s mandate, and none against its shape', () => {
    expect(
      mandateFaults(EXPECTED_ROUTES, specRoutes(), specSections()),
      'ADR-0026: a route spec §34 does not print ships only with a checkable mandate, and every ' +
        'declared path obeys the shape rule',
    ).toEqual([]);
  });

  it('declares each route exactly once, across every declaration file', () => {
    // The union is built at module scope and throws on a duplicate, so reaching this line at all is
    // half the assertion. The other half is that the union really is the sum of the parts: a map
    // that silently overwrote would make the two agree by losing an entry.
    const declared = declarationFiles.reduce((total, file) => total + file.entries.length, 0);
    expect(EXPECTED_ROUTES.length).toBe(declared);
    expect(new Set(EXPECTED_ROUTES.map(key)).size).toBe(declared);
  });

  it('read every route file the tracked tree holds, derived by shape', () => {
    // The same repair as the declaration files above, and the same reason it was needed: this was
    // a literal list of the five route files that existed when it was written, and every Wave 2b
    // track that ships a route adds one — inside its own `Owns` globs, while this file is inside
    // nobody's but the integrator's. A literal member list is not a partition (ADR-0027 §1).
    //
    // Derived from a wider pathspec than `trackedRouteFiles` uses, so a `git ls-files` that
    // returned a shorter list is caught rather than satisfied, and through the same
    // `filterRouteFiles`, whose classifier throws on a `route.<unknown-ext>` rather than skipping
    // it. What makes the equality below mean something is that this set is non-empty and complete.
    const derived = filterRouteFiles(trackedFiles('apps/web'), pageExtensions());
    expect(
      routeFiles.map((file) => file.repoPath),
      `derived from \`git ls-files -- apps/web\`: ${derived.join(', ')}`,
    ).toEqual(derived);
    expect(derived.length, 'apps/web tracks no route handler at all').toBeGreaterThan(0);
    expect(actual.size).toBeGreaterThan(0);
  });

  it('serves exactly the routes declared as landed — no more, no fewer', () => {
    const landed = new Set(EXPECTED_ROUTES.filter((entry) => entry.landed).map(key));

    const undeclared = [...actual].filter((route) => !landed.has(route)).sort();
    const notLandedButPresent = EXPECTED_ROUTES.filter(
      (entry) => !entry.landed && actual.has(key(entry)),
    ).map((entry) => `${key(entry)} — set landed: true (owner ${entry.owner})`);

    expect(
      undeclared,
      'these route handlers exist but are declared by no file in tests/route-declarations/. Spec ' +
        '§34 says "expose a very small control-plane API"; add the entry to your task\'s own ' +
        'declaration file deliberately, or delete the route.\n' +
        (notLandedButPresent.length > 0
          ? `Some of them are already declared with landed: false —\n  ${notLandedButPresent.join('\n  ')}`
          : ''),
    ).toEqual([]);

    const missing = [...landed].filter((route) => !actual.has(route)).sort();
    expect(missing, 'these routes are declared as landed but no route handler serves them').toEqual(
      [],
    );
  });

  it('declares POST /api/builder/mcp as the one run-caller route (issue #1846)', () => {
    const runCaller = API_ROUTE_EXCLUSIONS.filter(
      (route) => route.because === 'run-caller route (per-run token, aw-control tools)',
    ).map(key);
    expect(runCaller).toEqual(['POST /api/builder/mcp']);
    const declared = EXPECTED_ROUTES.filter((entry) => key(entry) === 'POST /api/builder/mcp');
    expect(declared.map((entry) => entry.landed)).toEqual([true]);
  });

  it('serves all five agent routes of spec §34, and no sixth under /api/agents', () => {
    const five = [
      'POST /api/agents',
      'GET /api/agents',
      'GET /api/agents/:id',
      'PATCH /api/agents/:id',
      'DELETE /api/agents/:id',
    ];
    for (const route of five) {
      expect(actual.has(route), `spec §34 requires ${route}`).toBe(true);
    }
    // Everything currently served under /api/agents. No search, bulk or count endpoint can slip
    // in unnoticed, and the run route ADR-0013 puts here is allowed through only by its entry.
    const declaredUnderAgents = new Set(
      EXPECTED_ROUTES.filter((entry) => entry.path.startsWith('/api/agents')).map(key),
    );
    const servedUnderAgents = [...actual].filter((route) => route.includes(' /api/agents')).sort();
    expect(servedUnderAgents.filter((route) => !declaredUnderAgents.has(route))).toEqual([]);
  });

  it('serves the three run routes of spec §34 plus the security-mandated revocation operation, and nothing undeclared under /api/runs', () => {
    // W1-CP-04's slice, asserted here rather than in `apps/web/server/runs/routes.test.ts`, which
    // used to make the same claim over the whole `app/api` tree from inside one task's directory.
    // ADR-0019: a closed world over the tree is asserted once, where the tree is visible.
    for (const route of [
      'POST /api/agents/:id/runs',
      'GET /api/runs/:id',
      'GET /api/runs/:id/events',
    ]) {
      expect(actual.has(route), `spec §34 requires ${route}`).toBe(true);
    }
    expect(actual.has('POST /api/runs/:id'), 'the revocation operation must be served').toBe(true);
    // Everything currently served under /api/runs, allowed through only by its own declaration —
    // the same derivation the agents assertion above uses. A literal list stood here until
    // W9-RUNS-135 shipped the durable `GET /api/runs` its declaration file mandates and this
    // gate refused it by name; a closed world enumerated by a literal has not been partitioned
    // (ADR-0027, ADR-0025), and the declarations directory is where the partition lives.
    const declaredUnderRuns = new Set(
      EXPECTED_ROUTES.filter((entry) => entry.path.startsWith('/api/runs')).map(key),
    );
    const servedUnderRuns = [...actual].filter((route) => route.includes(' /api/runs')).sort();
    expect(servedUnderRuns.filter((route) => !declaredUnderRuns.has(route))).toEqual([]);
  });
});
