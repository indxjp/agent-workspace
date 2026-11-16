import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  repoRoot,
  OWNING_PACKAGE,
  PACKAGE,
  MANIFEST,
  allTargets,
  sourceRoot,
  underRoot,
  insideLayer,
  escapeSubpaths,
  trackedFiles,
  classifyTrackedFile,
} from './database-reachability-manifest.test-support.js';
import {
  COMPUTED_IMPORT_DECISIONS,
  specifiersIn,
} from './database-reachability-specifiers.test-support.js';
import {
  edgesFor,
  decideUnvouchedCall,
  type Edge,
} from './database-reachability-resolution.test-support.js';
import { defineDatabaseSurfaceTests } from './database-reachability-surfaces.test-support.js';

const modules: string[] = [];
const data: string[] = [];
for (const file of trackedFiles()) {
  if (classifyTrackedFile(file) === 'module') modules.push(file);
  else data.push(file);
}

const edges: Edge[] = [];
for (const file of modules) {
  const read = specifiersIn(file);
  for (const specifier of read.specifiers) {
    edges.push(...edgesFor(file, specifier));
  }
  // The other half of the walk's verdict. A call site the reader took no specifier out of is
  // decided here rather than left behind it (ADR-0031 clause 1).
  for (const call of read.unvouched) decideUnvouchedCall(file, call);
}

/** An importer that lives inside the database layer may reach any part of it. */
const insideDatabaseLayer = (from: string): boolean => insideLayer(from);
/** An importer inside the owning package is on the same side of the module boundary. */
const insideOwningPackage = (from: string): boolean => from.startsWith(OWNING_PACKAGE);
/** The shape rule for an escape's admitted importer: a Vitest suite, by filename. */
const isSuite = (from: string): boolean => /\.test(?:-support)?\.tsx?$/u.test(from);

interface Verdict {
  readonly edge: Edge;
  readonly permitted: boolean;
  readonly rule: string;
}

function decide(edge: Edge): Verdict {
  if (insideDatabaseLayer(edge.from)) {
    return { edge, permitted: true, rule: 'the database layer may reach its own modules' };
  }
  if (insideOwningPackage(edge.from) && edge.via === 'path' && underRoot(edge.target, sourceRoot)) {
    return {
      edge,
      permitted: true,
      rule: "a path into the layer's source from inside the package that owns it",
    };
  }
  if (edge.via === 'subpath' && edge.subpath === './db') {
    return { edge, permitted: true, rule: 'the public surface, through the package export' };
  }
  if (edge.via === 'subpath' && edge.subpath !== null && escapeSubpaths.has(edge.subpath)) {
    if (isSuite(edge.from)) {
      return { edge, permitted: true, rule: 'a declared escape, imported by a test suite' };
    }
    return {
      edge,
      permitted: false,
      rule: 'a declared escape imported by something that is not a *.test.ts suite',
    };
  }
  const spelling = edge.via === 'path' ? 'a specifier resolving to' : 'a package subpath naming';
  const half = !underRoot(edge.target, sourceRoot)
    ? "the layer's BUILD OUTPUT, which skips both the export map and the source tree this gate reads"
    : 'the database layer from outside it, which skips the package export map entirely';
  return { edge, permitted: false, rule: `${spelling} ${half}` };
}

const verdicts = edges.map(decide);

const describeSet = (rows: readonly Verdict[]): string =>
  rows
    .map((row) => `  ${row.edge.from} → ${row.edge.specifier} (${row.edge.target})   [${row.rule}]`)
    .join('\n');

describe('nothing outside the database layer reaches past its public barrel', () => {
  it('holds exactly one decided computed dynamic import: the one ADR-0115 names', () => {
    expect([...COMPUTED_IMPORT_DECISIONS.keys()]).toEqual(['packages/aw/src/tools/host-child.ts']);
  });

  it('classified every tracked path, and parsed a non-empty set of modules', () => {
    expect(modules.length, '`git ls-files` yielded no module to parse').toBeGreaterThan(0);
    expect(
      data.length,
      '`git ls-files` yielded no non-module file, which cannot be true of this ' +
        'repository and means the extension classifier is mis-reading paths',
    ).toBeGreaterThan(0);
  });

  it('derived a non-empty set of import edges from the tracked tree', () => {
    expect(
      edges.length,
      'no import edge into the database layer was found in the tracked tree. Either the ' +
        'specifier reader is broken or `git ls-files` returned nothing; either way this gate ' +
        'proved nothing.',
    ).toBeGreaterThan(0);
  });

  it('found the public surface actually being imported from outside the database layer', () => {
    const publicEdges = verdicts.filter(
      (row) => row.permitted && row.edge.subpath === './db' && !insideOwningPackage(row.edge.from),
    );
    expect(
      publicEdges.length,
      `no file outside ${OWNING_PACKAGE} imports the public barrel. The derived set was:\n${describeSet(verdicts)}`,
    ).toBeGreaterThan(0);
  });

  it('found every declared escape being imported by a suite, so no subpath is declared unused', () => {
    for (const subpath of escapeSubpaths) {
      const importers = verdicts.filter(
        (row) => row.edge.subpath === subpath && isSuite(row.edge.from),
      );
      expect(
        importers.length,
        `${MANIFEST} declares the escape subpath "${subpath}", and no *.test.ts imports it. An ` +
          'escape nothing uses should be deleted from the manifest, not left for the next author ' +
          `to find. The derived set was:\n${describeSet(verdicts)}`,
      ).toBeGreaterThan(0);
    }
  });

  it('admits no edge that skips the public barrel', () => {
    const refused = verdicts.filter((row) => !row.permitted);
    expect(
      refused.map((row) => `${row.edge.from} → ${row.edge.specifier}   [${row.rule}]`),
      'These files reach into the database layer without going through ' +
        `${PACKAGE}/db. Application code obtains a database through openDatabaseRoot(); ` +
        'a suite that must build a fixture imports a declared escape subpath. The whole derived ' +
        `set, permitted and refused:\n${describeSet(verdicts)}`,
    ).toEqual([]);
  });
});

defineDatabaseSurfaceTests();

describe('the declared escape refuses to load outside a test process', () => {
  // The cold import of the database layer takes seconds under CI load, so it is paid here, under the
  // hook timeout, and not inside the timed case. The import runs in a real test process, where the
  // module's own guard passes; the case then drives the exported guard under a modified env.
  let assertTestProcess: () => void;
  beforeAll(async () => {
    ({ assertTestProcess } = await import('./unscoped.js'));
  }, 60_000);

  it('calls its guard as a top-level statement, so the refusal runs at import', () => {
    expect(
      escapeSubpaths.size,
      'no escape subpath is declared, so there is no guard to check',
    ).toBeGreaterThan(0);
    for (const escape of escapeSubpaths) {
      const relative = allTargets.find(
        (row) => row.subpath === escape && row.condition === 'types',
      )?.target;
      expect(
        relative,
        `${MANIFEST} declares "${escape}" with no "types" condition, so this gate cannot find ` +
          'its source.',
      ).toBeDefined();
      const absolute = path.join(repoRoot, relative ?? '');
      const source = ts.createSourceFile(
        absolute,
        readFileSync(absolute, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const topLevelCalls = source.statements
        .filter(ts.isExpressionStatement)
        .map((statement) => statement.expression)
        .filter(ts.isCallExpression)
        .filter((call) => ts.isIdentifier(call.expression))
        .map((call) => (call.expression as ts.Identifier).text);
      expect(
        topLevelCalls,
        `${relative ?? ''} declares a guard but does not call it at module scope, so importing it ` +
          'would refuse nothing.',
      ).toContain('assertTestProcess');
    }
  });

  it('throws when the process has not identified itself as a test runner', () => {
    const before = { vitest: process.env['VITEST'], node: process.env['NODE_ENV'] };
    try {
      delete process.env['VITEST'];
      process.env['NODE_ENV'] = 'production';
      expect(() => {
        assertTestProcess();
      }).toThrow(/loadable\s+only from a test process/u);

      process.env['NODE_ENV'] = 'development';
      expect(() => {
        assertTestProcess();
      }).toThrow(/@agent-workspace\/core\/db\/unscoped/u);

      // The positive arm, so the guard is not passing by refusing everything.
      process.env['VITEST'] = 'true';
      expect(() => {
        assertTestProcess();
      }).not.toThrow();
      delete process.env['VITEST'];
      process.env['NODE_ENV'] = 'test';
      expect(() => {
        assertTestProcess();
      }).not.toThrow();
    } finally {
      if (before.vitest === undefined) delete process.env['VITEST'];
      else process.env['VITEST'] = before.vitest;
      if (before.node === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = before.node;
    }
  });
});
