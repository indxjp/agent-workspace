/**
 * The §42 boundary gate (plan §9.1, `no-sdk-import test`).
 *
 * Spec §42: *"Keep all SDK-specific translation concentrated in one small module"*, and the
 * programme states it as an absolute: each engine adapter's one `boundary.ts` is the only file in
 * this repository that may reach its confined SDK, and **a test enforces it**. Five things have
 * to hold for that sentence to mean anything, each a separate assertion:
 *
 *   1. the scan covers the **whole tracked tree**, and every file in it is *classified* — a file
 *      whose kind this gate does not recognise fails the gate rather than being skipped;
 *   2. every call site the scan walks past leaves with a **verdict**, and `new X(…)` is a call
 *      site: a reference whose specifier the gate read, a refusal naming the file and the
 *      construct, or the decision that a call handed no string this gate can read as a resolvable
 *      module is not naming one *here*. The third is a decision, not a skip, with the reach limits
 *      demonstrated in `no-sdk-import/reach-limits.test.ts`;
 *   3. the set of files that reach the SDK is compared as a **set equality**, so the gate fails
 *      both when a new importer appears and when the expected one disappears (ADR-0015: a check
 *      that cannot run must fail — `expect(offenders).toEqual([])` passes just as happily over a
 *      scan that found nothing at all);
 *   4. the boundary's **emitted declarations** name no SDK module, because an `import` scan cannot
 *      see an SDK type travelling out on an exported signature (`no-sdk-import/declarations.test.ts`);
 *   5. the one other thing permitted to reach the SDK — a research note's committed probes — is
 *      **derived from the tracked tree by shape**, not named in a list.
 *
 * ## A module specifier is an input to a resolution algorithm, not a string
 *
 * [ADR-0030](../docs/adr/0030-import-edges-are-resolved-by-the-compiler-not-matched-by-regex.md)
 * and [W2-INT-01](../docs/adr/W2-INT-01-a-module-reference-is-resolved-not-compared.md): six
 * escapes were built against a version that captured the raw text of a specifier with a regular
 * expression and compared it after expanding it through an alias table the gate maintained. This
 * gate asks the compiler instead: candidate references are found with the TypeScript AST (the
 * cooked specifier, whitespace-agnostic), each is resolved with `ts.resolveModuleName` against the
 * nearest real `tsconfig.json`, the answer is the `realpathSync`-canonical resolved path, and
 * whether that path is the SDK is decided by the `name` of its owning `package.json`. A reference
 * it cannot resolve fails the gate by name, and a failure prints `file: specifier -> path`.
 *
 * ## What a call site is decided by, and where the reach ends
 *
 * [ADR-0031](../docs/adr/0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md):
 * a static gate over a dynamic language cannot be complete, so this gate says exactly what it
 * decides and refuses the rest. A call site is decided by **what it is handed, not what its callee
 * is called**; `module.require('@anthropic-ai/claude-agent-sdk')` fails because the gate does not
 * know the callee, not because it learned the name. A string handed to a call together with an
 * absolute base URL is resolved and collected rather than refused. `eval` and `new Function` are
 * outside any static analysis and refused whole; a specifier arriving through a parameter or a
 * computation, and bindings that are by name over the whole file rather than by scope, are limits
 * stated and demonstrated rather than claimed away.
 *
 * ## Where resolution happens from, and fixtures that install for themselves
 *
 * A reference resolves from the file that writes it. Two narrow extra arms exist: a relative
 * specifier TypeScript declines is accepted when that exact file exists, and a bare specifier that
 * resolves nowhere is resolved once more from a boundary file. The committed probes are why: their
 * README tells a reader to install the SDK in a scratch directory, so the import resolves to
 * nothing *in this tree* while being a real SDK import where the permit applies. A package a
 * fixture installs for itself (ADR-0032, `@modelcontextprotocol/sdk`) is a **classified verdict,
 * not a refusal**, reached only for a bare specifier in a fixture whose README names the package,
 * and asserted as a set so it cannot grow or shrink silently.
 *
 * ## Markup, and what is read from where
 *
 * An HTML `src`/`href` is a URL a browser resolves, not a module specifier, so markup references
 * are resolved with `new URL` and decided on the resolved path. Names come from `git ls-files`
 * and contents from the working tree, so an uncommitted edit fails the gate while a person can
 * still act on it. There is no directory exclusion anywhere, **including for this file itself**:
 * fixtures here are string literals in a syntax tree, which the walk does not read as imports.
 * A comment is not a module reference either, which is why prose that merely names the package
 * does not flag.
 *
 * The scanner lives in `tests/no-sdk-import/`; this file asserts about the tree it scans.
 */
import { describe, expect, it } from 'vitest';

import {
  BOUNDARY_PROJECT,
  ENGINE_SDK_BOUNDARIES,
  isResearchFixture,
  PACKAGES_A_FIXTURE_INSTALLS_FOR_ITSELF,
  COMPUTED_IMPORT_DECISIONS,
  PROSE_ONLY_CONTROL,
  RESEARCH_FIXTURE_ROOT,
  SDK_BOUNDARY_FILES,
  SDK_PACKAGE,
} from './no-sdk-import/boundaries.js';
import {
  classifyFile,
  classifyResearchFixture,
  MARKUP_EXTENSIONS,
  MODULE_SOURCE_EXTENSIONS,
  PROBE_EXTENSIONS,
  type FileClass,
} from './no-sdk-import/classify.js';
import { PERMITTED, treeScan } from './no-sdk-import/tree-scan.js';
import {
  packageManifests,
  readTracked,
  researchFixtures,
  researchProbes,
  scanned,
  tracked,
  unclassified,
  unrecognisedFixtures,
} from './no-sdk-import/tracked.js';

const {
  detectedEdges,
  fixtureConsumers,
  importers,
  undecidable,
  undeclaredFixtureEdges,
  undeclaredFixturePackages,
} = treeScan;

describe('the §42 boundary gate can actually run', () => {
  it('scanned the tracked tree, including the file it is asserting about', () => {
    // These names are what make the assertions below mean something: if the boundary file is
    // missing from the scan, every "no other file reaches the SDK" claim is true and worthless.
    for (const row of ENGINE_SDK_BOUNDARIES) expect(scanned).toContain(row.boundaryFile);
    expect(scanned).toContain(PROSE_ONLY_CONTROL);
    expect(scanned).toContain('tests/no-sdk-import.test.ts');
    for (const row of ENGINE_SDK_BOUNDARIES) expect(packageManifests).toContain(row.manifest);
    expect(tracked).toContain(BOUNDARY_PROJECT);
  });

  it('classified every tracked file, with no default that lets one through', () => {
    // An extension nobody has thought about is the Wave 1a route-file failure in another
    // costume: adding it to one of the classification tables is the fix, skipping it is not.
    expect(unclassified, 'tracked files whose kind this gate does not recognise').toEqual([]);
  });

  /**
   * Each name is asserted together with the rule that decides it. `apps/web/handler.ts.example`
   * is the negative that keeps the template rule honest: a `.ts` template is TypeScript wearing
   * a suffix and is scanned. The last row keeps the fall-through rejecting, which is what makes
   * the assertion above a gate: a suffix the template list does not carry stays on the name.
   */
  const CLASSIFICATIONS: ReadonlyArray<readonly [string, FileClass]> = [
    ['apps/web/server/runs/acceptance/nginx.conf', 'inert'],
    ['runtime.Dockerfile', 'inert'],
    ['Dockerfile', 'inert'],
    ['.env.example', 'inert'],
    ['.env', 'inert'],
    // The same document with its leading dot removed so `.gitignore` keeps its hands off it.
    ['packages/cli/src/fixtures/local/env', 'inert'],
    ['apps/web/handler.ts.example', 'module-source'],
    ['docs/page.html.template', 'markup'],
    ['apps/runner/src/claude.ts', 'module-source'],
    ['package.json', 'structured-data'],
    ['docs/spec.md', 'inert'],
    ['deploy/service.unitfile', 'unclassified'],
    ['apps/web/handler.ts.dist', 'unclassified'],
  ];

  it('classifies each kind by what loads it, not by what its name failed to match', () => {
    for (const [file, kind] of CLASSIFICATIONS) expect(classifyFile(file), file).toBe(kind);
  });
});

describe('the §42 boundary gate can actually run', () => {
  it('derived a non-empty research-probe set from the tracked tree', () => {
    // ADR-0015 on the derivation itself: every assertion about the permit is quantified over
    // `researchProbes`, and an empty array satisfies all of them. The names are not asserted
    // (that would be the literal list again), only that the rule resolves against the tree.
    expect(
      researchFixtures,
      `no tracked file under ${RESEARCH_FIXTURE_ROOT}/, so the §42 permit derives from nothing`,
    ).not.toEqual([]);
    expect(
      researchProbes,
      `no probe under ${RESEARCH_FIXTURE_ROOT}/ matched ${[...PROBE_EXTENSIONS].join(', ')}; derived fixtures were: ${researchFixtures.join(', ')}`,
    ).not.toEqual([]);
  });

  it('classified every research fixture, with no default that grants or withholds a permit', () => {
    // ADR-0027 clauses 2 and 3: the shape rule is a classifier and its `else` rejects by name.
    expect(
      unrecognisedFixtures,
      `tracked files under ${RESEARCH_FIXTURE_ROOT}/ that are neither a runnable probe nor an inert capture`,
    ).toEqual([]);
  });

  it('inspects every file it permits', () => {
    // A permit for a file this gate never reads is a permit whose effect nobody can see.
    expect(
      researchProbes.filter((probe) => !scanned.includes(probe)),
      'permitted probes this gate never reads, so the permit could hide an import',
    ).toEqual([]);
  });

  it('gives a capture verdict to no kind it scans, asserted where that can fail', () => {
    // Asserted on the classifier over constructed names, not over the tree: `capture` is derived
    // from the kinds `scanned` excludes, so a capture arm that grew a scanned kind would not
    // show up over the tree. The names are built from the two extension tables `scanned` is
    // derived from, so the property covers every kind this gate scans, not the ones remembered.
    const scannedExtensions = [...MODULE_SOURCE_EXTENSIONS, ...MARKUP_EXTENSIONS];
    expect(
      scannedExtensions,
      'no extension is scanned, so the loop below would assert nothing (ADR-0015)',
    ).not.toEqual([]);
    for (const extension of scannedExtensions) {
      const file = `${RESEARCH_FIXTURE_ROOT}/r-06/probe${extension}`;
      expect(['module-source', 'markup'], `${file} is not a kind this gate scans`).toContain(
        classifyFile(file),
      );
      expect(
        classifyResearchFixture(file).kind,
        `${file} is scanned as module source or markup, so calling it an inert capture would hand a §42 permit to a file that can name a module`,
      ).not.toBe('capture');
    }
  });
});

describe('the §42 boundary gate can actually run', () => {
  it('holds exactly one decided computed dynamic import: the one ADR-0115 names', () => {
    expect([...COMPUTED_IMPORT_DECISIONS.keys()]).toEqual(['packages/aw/src/tools/host-child.ts']);
  });

  it('found no module reference it cannot decide', () => {
    expect(
      undecidable.map((entry) => `${entry.file}: ${entry.reason}`),
      'module references this gate cannot resolve; it refuses to pass over them',
    ).toEqual([]);
  });

  it('names every package a fixture imports that this repository does not declare', () => {
    // ADR-0032 clause 1: the classification is sound only because it is *stated* as a set
    // equality against a literal, so a new package fails until the name and README are written,
    // and a package that stops being imported fails the other way.
    expect(
      undeclaredFixturePackages,
      `packages a committed fixture imports and no package.json here declares. Every reference ` +
        `that produced this verdict, as file: specifier -> package: ` +
        undeclaredFixtureEdges.join(' | '),
    ).toEqual(PACKAGES_A_FIXTURE_INSTALLS_FOR_ITSELF);
    // Asserted on the edges, which are the evidence rather than the name: a verdict that silently
    // stopped firing would leave the equality above quantified over nothing.
    expect(
      undeclaredFixtureEdges,
      'no reference reached the ADR-0032 classification, so the assertion above is quantified over nothing',
    ).not.toEqual([]);
    // The control that makes the verdict safe rather than merely narrow. The SDK never arrives
    // here because a fixture's bare specifier is resolved a second time from the confining
    // package; if that arm broke, every probe's SDK import would land here instead of in
    // `importers` and §42 would go quiet. Repair that arm, not the literal.
    expect(
      undeclaredFixturePackages,
      `${SDK_PACKAGE} is the package §42 confines. Classifying it as one this repository does ` +
        `not declare would take every probe's SDK import out of the detected set, so the ` +
        `confined-package resolution arm has stopped working — repair that, not this list.`,
    ).not.toContain(SDK_PACKAGE);
  });

  it('distinguishes a reference to the package from a mention of its name', () => {
    const prose = readTracked(PROSE_ONLY_CONTROL);
    expect(prose, `${PROSE_ONLY_CONTROL} no longer mentions the package`).toContain(SDK_PACKAGE);
    expect(importers, `${PROSE_ONLY_CONTROL} is prose, not an import`).not.toContain(
      PROSE_ONLY_CONTROL,
    );
    for (const row of ENGINE_SDK_BOUNDARIES) {
      expect(importers, `${row.boundaryFile} must import ${row.sdkPackage}`).toContain(
        row.boundaryFile,
      );
    }
  });
});

describe(`spec §42 — one file reaches the SDK`, () => {
  it('is reached, outside the research fixtures, by exactly the boundary file', () => {
    // A set equality, not "no offenders": the failure is the diff between two arrays, naming
    // both a new importer and a lost one, and it cannot pass on a scan that found nothing because
    // the boundary files have to be in the result. It is stated over the tree *outside* the
    // fixtures because a probe is permitted to import the SDK, not obliged to.
    const outsideFixtures = importers.filter((file) => !isResearchFixture(file));
    expect(
      outsideFixtures,
      `permitted set was: ${PERMITTED.join(', ')}. ` +
        `Every reference that put a file in the detected set, as specifier -> resolved path: ` +
        detectedEdges.join(' | '),
    ).toEqual(SDK_BOUNDARY_FILES);
  });

  it('is reached, inside the research fixtures, by nothing that is not a derived probe', () => {
    // An SDK-importing `.js` dropped beside the probes is `unrecognised`, so it is not in the
    // permitted set and fails here by name as well as in the classifier assertion.
    const insideFixtures = importers.filter(isResearchFixture);
    expect(
      insideFixtures.filter((file) => !researchProbes.includes(file)),
      `SDK importers under ${RESEARCH_FIXTURE_ROOT}/ that the shape rule did not recognise as probes; derived probes were: ${researchProbes.join(', ')}`,
    ).toEqual([]);
    // The permit is not theoretical: without this the assertion above passes on a walk that
    // resolved nothing under `docs/`, which is what happens if the boundary re-resolution arm is
    // removed, since the SDK is installed for the adapter package and nothing else.
    expect(
      insideFixtures,
      `no committed probe was detected importing the SDK, so the assertion above is quantified over an empty set; derived probes were: ${researchProbes.join(', ')}`,
    ).not.toEqual([]);
  });

  it('permits the fixtures because nothing consumes them, and checks that rather than assuming it', () => {
    // What makes `anything under docs/research/fixtures/` a sound §42 boundary and not simply a
    // wider hole: the permit rests on a probe being evidence a human runs by hand, out of tree,
    // and a probe that product code imports is product code holding a §42 permit. Read this
    // assertion first if the boundary is ever widened.
    expect(
      fixtureConsumers,
      `files outside ${RESEARCH_FIXTURE_ROOT}/ that resolve to a module inside it: a probe they ` +
        `import is not evidence any more, it is a dependency with an SDK permit. Every reference ` +
        `that put a file in the detected set, as specifier -> resolved path: ` +
        detectedEdges.join(' | '),
    ).toEqual([]);
  });
});
