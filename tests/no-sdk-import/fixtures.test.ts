import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT, RESEARCH_FIXTURE_ROOT } from './boundaries.js';
import { classifyResearchFixture } from './classify.js';
import { insideResearchFixtures, namesPackage, packageNameOf } from './packages.js';
import { resolveSpecifier } from './resolve.js';
import { scanModuleSource, type ModuleReference } from './scan.js';
import { readTracked } from './tracked.js';
import {
  decideUnresolvedReference,
  researchFixtureReadme,
  type FixtureReadme,
  type UnresolvedVerdict,
} from './unresolved.js';

const fixturePath = (relative: string): string => `${RESEARCH_FIXTURE_ROOT}/${relative}`;

const verdictKind = (file: string): string => classifyResearchFixture(file).kind;

/**
 * The classifier is exercised on names directly, so the assertions over the shipped tree cannot
 * pass because the rule stopped deciding. Every arm is covered, including both rejections.
 */
describe('the shape rule that derives the research-probe permit', () => {
  it('recognises a runnable probe', () => {
    expect(verdictKind(fixturePath('r-06/probe-1.mjs'))).toBe('probe');
    expect(verdictKind(fixturePath('r-06/probe-1.mjs.example'))).toBe('probe');
  });

  it('recognises an inert capture, which needs no permit', () => {
    expect(verdictKind(fixturePath('r-06/README.md'))).toBe('capture');
    expect(verdictKind(fixturePath('r-06/stream.json'))).toBe('capture');
    expect(verdictKind(fixturePath('r-06/.gitkeep'))).toBe('capture');
  });

  it('rejects module source that is not a runnable probe, by name', () => {
    // A `.ts` beside the probes is module source this gate scans, so leaving it out of the permit
    // quietly would make it an unexplained offender.
    const verdict = classifyResearchFixture(fixturePath('r-06/probe.ts'));
    expect(verdict.kind).toBe('unrecognised');
    expect(verdict.kind === 'unrecognised' ? verdict.reason : '').toContain('.mjs');
  });

  it('rejects a kind nobody has decided about, rather than defaulting it either way', () => {
    // Markup can name a module through `src`/`href`, so it is neither a probe nor a capture, and
    // an extension no table knows is the fall-through ADR-0015 asks for.
    expect(verdictKind(fixturePath('r-06/page.html'))).toBe('unrecognised');
    expect(verdictKind(fixturePath('r-06/capture.unitfile'))).toBe('unrecognised');
  });

  it('detects product code that resolves into the fixture tree, by whatever route', () => {
    // The positive control for the consumer assertion, which is otherwise a `toEqual([])` that a
    // broken walk would satisfy: both a relative specifier and a bare one through the `@/` alias
    // `apps/web/tsconfig.json` really declares, decided by the compiler.
    const importer = path.join(REPO_ROOT, 'apps/web/app/api/runs/[id]/route.ts');
    const probe = fixturePath('agent-sdk/probe-1-session-store.mjs');
    const insideFixtures = (specifier: string): boolean => {
      const resolution = resolveSpecifier(importer, specifier);
      return resolution.kind === 'resolved' && insideResearchFixtures(resolution.file);
    };
    expect(insideFixtures(`../../../../../../${probe}`)).toBe(true);
    // `@/*` maps onto `apps/web/*`, so a specifier that climbs out of it lands in the fixture
    // tree without spelling an alias target anywhere.
    expect(insideFixtures(`@/../../${probe}`)).toBe(true);
    // The negative that keeps it about the fixture tree rather than about the word `docs`.
    expect(insideFixtures('@/server/runs/api')).toBe(false);
  });
});

/**
 * ADR-0032, one assertion per clause, each written as something that runs rather than as prose.
 * The fixture paths are constructed rather than committed, so nothing plants a file under a tree
 * a parallel worker is walking (ADR-0019 clause 4) and no committed fixture or README is edited
 * to prove a red.
 */
const FIXTURE = fixturePath('r-06/probe.mjs');
const OUTSIDE = 'apps/runner/src/probe.mjs';
const MCP = '@modelcontextprotocol/sdk/client/stdio.js';
const README_FILE = fixturePath('r-06/README.md');
const UNRESOLVED_TITLE =
  'an unresolvable bare specifier in a fixture is a classified verdict, not a refusal';

const readme = (text: string): FixtureReadme => ({ file: README_FILE, text });
/** A README shaped like the real one: an install line that names the package. */
const DOCUMENTS_IT = readme(
  'npm init -y && npm install @anthropic-ai/claude-agent-sdk@0.3.258 @modelcontextprotocol/sdk@1.30.0\n',
);
/** The same README with the package name taken out, which is the clause-3 red proof. */
const DOCUMENTS_NOTHING = readme(
  'npm init -y && npm install @anthropic-ai/claude-agent-sdk@0.3.258\n',
);
const reference = (specifier: string): ModuleReference => ({
  specifier,
  form: 'an import declaration',
});

const decide = (
  file: string,
  specifier: string,
  readmeFor: FixtureReadme | null = DOCUMENTS_IT,
): UnresolvedVerdict => decideUnresolvedReference(file, reference(specifier), () => readmeFor);

const reasonOf = (verdict: UnresolvedVerdict): string =>
  verdict.kind === 'refused' ? verdict.reason : '';

describe(UNRESOLVED_TITLE, () => {
  it('classifies a bare specifier whose package the fixture README names', () => {
    // Clause 1: a named verdict carrying the package and the README it rests on, never a skip.
    const verdict = decide(FIXTURE, MCP);
    expect(verdict.kind).toBe('undeclared-package');
    expect(verdict.kind === 'undeclared-package' ? verdict.packageName : '').toBe(
      '@modelcontextprotocol/sdk',
    );
    expect(verdict.kind === 'undeclared-package' ? verdict.readme : '').toBe(README_FILE);
    // The same specifier outside the fixture tree is still refused, so the verdict is about where
    // the file is and not about the package's name.
    expect(decide(OUTSIDE, MCP).kind).toBe('refused');
  });

  it('refuses a relative specifier that resolves nowhere, fixtures included', () => {
    // Clause 2, run end to end on a fixture path: the walk finds the reference, the compiler
    // places it nowhere, and the verdict is a refusal even though the README beside it documents
    // a package. A relative reference names a file this repository contains; one that resolves
    // to nothing is a broken link, and no installation elsewhere explains it.
    const scan = scanModuleSource(FIXTURE, `import './no-such-sibling.mjs';`);
    expect(
      scan.undecidable,
      'the reference itself is readable; only its target is missing',
    ).toEqual([]);
    expect(scan.references[0]?.specifier).toBe('./no-such-sibling.mjs');
    expect(resolveSpecifier(path.join(REPO_ROOT, FIXTURE), './no-such-sibling.mjs').kind).toBe(
      'unresolved',
    );
    const verdict = decide(FIXTURE, './no-such-sibling.mjs');
    expect(verdict.kind, 'a broken relative import inside a fixture is still a hard failure').toBe(
      'refused',
    );
    expect(reasonOf(verdict)).toContain('ADR-0032 clause 2');
    // The two other shapes that are not packages either, for the same reason.
    for (const specifier of ['../../elsewhere/gone.mjs', '#internal/missing']) {
      expect(decide(FIXTURE, specifier).kind, specifier).toBe('refused');
    }
  });

  it('refuses when the fixture README does not name the package', () => {
    // Clause 3, the assertion that stops the verdict becoming a hole. The only difference from
    // the passing case is the README text: with the package name taken out of a copy, the
    // verdict goes from a classification to a refusal that says which file to write it into.
    const verdict = decide(FIXTURE, MCP, DOCUMENTS_NOTHING);
    expect(verdict.kind).toBe('refused');
    expect(reasonOf(verdict)).toContain('@modelcontextprotocol/sdk');
    expect(reasonOf(verdict)).toContain(README_FILE);
    expect(reasonOf(verdict)).toContain('ADR-0032 clause 3');

    // A fixture no README covers at all is refused rather than classified, because there is then
    // nothing for the verdict to rest on.
    const uncovered = decide(FIXTURE, MCP, null);
    expect(uncovered.kind).toBe('refused');
    expect(reasonOf(uncovered)).toContain('ADR-0032 clause 3');
  });
});

describe(UNRESOLVED_TITLE, () => {
  it('reads a README name as a name, not as a prefix of a longer one', () => {
    // The unit behind clause 3, in both directions. An `includes` would let a README documenting
    // a different package satisfy the clause, which is the fail-open shape it exists to stop.
    const names = (text: string): boolean => namesPackage(text, '@modelcontextprotocol/sdk');
    expect(names('install @modelcontextprotocol/sdk@1.30.0')).toBe(true);
    expect(names('import … from @modelcontextprotocol/sdk/types.js')).toBe(true);
    expect(
      names('install @modelcontextprotocol/sdk-experimental'),
      'a longer package name documents itself, not this one',
    ).toBe(false);
    expect(names('install vendor/@modelcontextprotocol/sdk')).toBe(false);
    expect(names('nothing here')).toBe(false);
    // The real README, which is what the shipped classification rests on.
    expect(names(readTracked(fixturePath('R-06-mcp/README.md')))).toBe(true);
  });

  it('reads a package name off a bare specifier and nothing else off anything else', () => {
    expect(packageNameOf('@modelcontextprotocol/sdk/client/stdio.js')).toBe(
      '@modelcontextprotocol/sdk',
    );
    expect(packageNameOf('@modelcontextprotocol/sdk')).toBe('@modelcontextprotocol/sdk');
    expect(packageNameOf('express/lib/router')).toBe('express');
    expect(packageNameOf('express')).toBe('express');
    // Every arm that must answer `null`, so the refusal is by rule rather than by fall-through.
    for (const specifier of [
      '',
      './sibling.mjs',
      '../up.mjs',
      '#internal/missing',
      '/absolute/path.mjs',
      'node:fs',
      'https://cdn.example.invalid/x.mjs',
      '@scope-with-no-name',
    ]) {
      expect(packageNameOf(specifier), specifier).toBeNull();
    }
  });

  it('reads the README that really covers the R-06 probes, from the tracked tree', () => {
    // The lookup, asserted against the shipped tree rather than a stub: without this the clause
    // assertions are about a function nothing calls with real arguments.
    const found = researchFixtureReadme(fixturePath('R-06-mcp/probe-wire.mjs'));
    expect(found?.file).toBe(fixturePath('R-06-mcp/README.md'));
    expect(found?.text).toContain('npm install');
    // The search stops at the fixture root rather than climbing out of it into `docs/`.
    expect(researchFixtureReadme('docs/research/README.md')).toBeNull();
  });
});
