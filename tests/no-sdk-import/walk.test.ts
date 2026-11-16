import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT, SDK_BOUNDARY, SDK_PACKAGE } from './boundaries.js';
import { markupReferences, markupTargetIsSdk, resolveMarkupReference } from './markup.js';
import { sourceReachesSdk } from './reach.js';
import { scanModuleSource } from './scan.js';
import { RECOGNISED, REFUSED } from './walk-samples.js';

const specifiersOf = (source: string, file = 'fixture.ts'): string[] =>
  scanModuleSource(file, source).references.map((reference) => reference.specifier);

function markupHitsSdk(markup: string): boolean[] {
  const document = path.join(REPO_ROOT, 'ui/index.html');
  return markupReferences('ui/index.html', markup).references.map((reference) =>
    markupTargetIsSdk(resolveMarkupReference(document, reference)),
  );
}

describe('the walk recognises the forms a module reference takes', () => {
  it.each(RECOGNISED)('detects %s', (_label, source) => {
    expect(sourceReachesSdk(SDK_BOUNDARY, source)).toBe(true);
  });

  it('hands over the cooked specifier, not the text it was written with', () => {
    // The unit behind two of the rows above, stated on the specifier itself so that a walk which
    // detected them for some other reason could not satisfy it. Both are the same string once the
    // parser is finished with them, and neither is that string in the file's raw bytes.
    const escaped = scanModuleSource(
      'fixture.ts',
      `import '\\u0040anthropic-ai/claude-agent-sdk';`,
    );
    expect(escaped.references.map((reference) => reference.specifier)).toEqual([SDK_PACKAGE]);
    const tight = scanModuleSource('fixture.ts', `import'@anthropic-ai/claude-agent-sdk';`);
    expect(tight.references.map((reference) => reference.specifier)).toEqual([SDK_PACKAGE]);
    expect(escaped.undecidable).toEqual([]);
    expect(tight.undecidable).toEqual([]);
  });

  it('detects a markup element that names the package on another origin', () => {
    // The markup arm is a URL arm: there is no module resolver for a remote origin, so a
    // reference that leaves this checkout is decided on the path the URL algorithm produced.
    const remote = `<script type="module" src="https://cdn.example.invalid/@anthropic-ai/claude-agent-sdk/sdk.mjs"></script>`;
    expect(markupReferences('ui/index.html', remote).undecidable).toEqual([]);
    expect(markupHitsSdk(remote)).toEqual([true]);
    // The shape the tracked pages really use stays innocent, so the assertion above is about the
    // package and not about the word `src`.
    expect(markupHitsSdk(`<link href="assets/app.css">`)).toEqual([false]);
  });

  it.each(REFUSED)('refuses %s rather than passing over it', (_label, source) => {
    expect(scanModuleSource('fixture.ts', source).undecidable).not.toEqual([]);
  });
});

describe('the walk recognises the forms a module reference takes', () => {
  it('decides a createRequire whose result is used immediately, and reads its specifier', () => {
    // The shape `apps/web/server/runs/acceptance/run-acceptance.mjs` uses. Nothing is reported as
    // undecidable, *and* the module it names is collected rather than dropped.
    const real = `const bin = createRequire(resolve(webRoot, 'package.json')).resolve('next/dist/bin/next');`;
    const scan = scanModuleSource('fixture.mjs', real);
    expect(scan.undecidable).toEqual([]);
    expect(specifiersOf(real, 'fixture.mjs')).toContain('next/dist/bin/next');

    // Importing the name is not a module reference at all, and used to be reported as one.
    const importsIt = `import { createRequire } from 'node:module';`;
    expect(scanModuleSource('fixture.mjs', importsIt).undecidable).toEqual([]);
    expect(specifiersOf(importsIt, 'fixture.mjs')).toEqual(['node:module']);
  });

  it('refuses a file it could not parse, rather than reporting what survived error recovery', () => {
    // The control for the `parseDiagnostics` read: a walk over a tree the parser gave up on finds
    // whatever survived, and calling that "no SDK import" is the fail-open shape ADR-0015
    // forbids. The second source parses cleanly and must not be refused, so the arm is about
    // syntax rather than about every file.
    expect(scanModuleSource('fixture.ts', `import { from ;\nconst x = ;`).undecidable).not.toEqual(
      [],
    );
    expect(scanModuleSource('fixture.ts', `export const x = 1;\n`).undecidable).toEqual([]);
  });

  it('leaves a plain mention of the package name alone', () => {
    const prose = `// see @anthropic-ai/claude-agent-sdk for details\nconst label = '@anthropic-ai/claude-agent-sdk 0.3.258';`;
    const scan = scanModuleSource('fixture.ts', prose);
    expect(scan.references).toEqual([]);
    expect(scan.undecidable).toEqual([]);
  });
});
