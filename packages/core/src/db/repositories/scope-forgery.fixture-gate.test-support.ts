/**
 * The shared runner behind the compile-time forgery gates (`scope-forgery.test.ts` and
 * `scope-forgery.surface.test.ts`): write a fixture whose every line is tagged `FORBIDDEN`,
 * `PERMITTED` or `DECLARED`, run `tsc` over it under the repository's own `tsconfig.json`, and decide
 * on positive assertions in both directions (ADR-0015).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** `…/packages/core/src/db/repositories/<this file>` → the repository root, six levels up. */
export const repoRoot = path.resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
);

/** Repository-relative, forward slashes, so a `git` pathspec means the same thing on either OS. */
export const posixPath = (value: string): string => value.split(path.sep).join('/');

interface Diagnostic {
  readonly line: number;
  readonly text: string;
}

interface CompileResult {
  readonly diagnostics: readonly Diagnostic[];
  /** Diagnostics tsc raised outside the fixture. Asserted empty; never dropped. */
  readonly elsewhere: readonly string[];
  readonly rawOutput: string;
}

interface FixtureGate {
  readonly title: string;
  readonly fixtureDir: string;
  /** The fixture's file name inside `fixtureDir`; diagnostics are partitioned on it. */
  readonly fixtureName: string;
  readonly fixtureSource: string;
  /** Extra files the fixture directory needs, by name. */
  readonly extraFiles?: Readonly<Record<string, string>>;
  readonly testTitles: {
    readonly inventory: string;
    readonly forbidden: string;
    readonly permitted: string;
  };
  /** Builds the assertion message for a PERMITTED line that tsc rejected, if it has one. */
  readonly permittedMessage?: (line: number, rawOutput: string) => string;
}

const diagnosticPattern = /^(?<file>.+?)\((?<line>\d+),\d+\): (?<text>error TS\d+: .*)$/u;

const numberedLines = (source: string, matches: (line: string) => boolean): readonly number[] =>
  source
    .split('\n')
    .map((line, index) => (matches(line) ? index + 1 : 0))
    .filter((lineNumber) => lineNumber > 0);

/**
 * Line numbers are read back out of the fixture, never written down in the test (W0-DOC-01). The
 * tag is matched on a word boundary.
 */
const linesTagged = (source: string, tag: string): readonly number[] => {
  const marker = new RegExp(`//\\s*${tag}\\b`, 'u');
  return numberedLines(source, (line) => marker.test(line));
};

/**
 * Every line that so much as *mentions* a tag must have been matched as carrying it — otherwise a
 * forgery tagged `// FORBIDDEN` with no trailing description would generate no assertion and go
 * unchecked, which is ADR-0015's failure inside the gate written to enforce ADR-0015.
 */
const linesMentioning = (source: string, tag: string): readonly number[] =>
  numberedLines(source, (line) => line.includes(tag));

const writeFixture = (gate: FixtureGate): void => {
  mkdirSync(gate.fixtureDir, { recursive: true });
  for (const [name, content] of Object.entries(gate.extraFiles ?? {})) {
    writeFileSync(path.join(gate.fixtureDir, name), content, 'utf8');
  }
  writeFileSync(path.join(gate.fixtureDir, gate.fixtureName), gate.fixtureSource, 'utf8');
  const config = {
    extends: posixPath(path.join(repoRoot, 'tsconfig.json')),
    compilerOptions: { noEmit: true, types: ['node'] },
    files: [`./${gate.fixtureName}`],
  };
  writeFileSync(
    path.join(gate.fixtureDir, 'tsconfig.json'),
    JSON.stringify(config, null, 2),
    'utf8',
  );
};

const runTsc = (fixtureDir: string): string => {
  const tsc = path.join(repoRoot, 'node_modules', '@typescript', 'native', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error('typescript is not installed — run `pnpm install`');
  try {
    return execFileSync(process.execPath, [tsc, '-p', fixtureDir, '--pretty', 'false'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // A non-zero exit is the expected outcome; tsc writes its diagnostics to stdout.
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }
};

/**
 * Partitioned, not filtered. A diagnostic raised in an imported module means the fixture is not
 * compiling for the reason claimed, and dropping those rows is how a gate that proves nothing stays
 * green (ADR-0027 clause 3). They are asserted empty by the caller.
 */
const partitionDiagnostics = (rawOutput: string, fixtureName: string): CompileResult => {
  const mine: Diagnostic[] = [];
  const theirs: string[] = [];
  for (const line of rawOutput.split(/\r?\n/u)) {
    const match = diagnosticPattern.exec(line);
    if (match === null) continue; // a blank line, or tsc's own "Found N errors." summary
    if (posixPath(match.groups?.['file'] ?? '').endsWith(fixtureName)) {
      mine.push({ line: Number(match.groups?.['line']), text: match.groups?.['text'] ?? '' });
    } else {
      theirs.push(line);
    }
  }
  return { diagnostics: mine, elsewhere: theirs, rawOutput };
};

const compileFixture = (gate: FixtureGate): CompileResult => {
  writeFixture(gate);
  return partitionDiagnostics(runTsc(gate.fixtureDir), gate.fixtureName);
};

const DECLARED_STALE_HINT =
  'is tagged DECLARED but the compiler now rejects it. That is good news: close the gap in the PR ' +
  'body and retag the line FORBIDDEN.';

/** Registers one compile-time gate as a `describe` block. */
export function defineFixtureGate(gate: FixtureGate): void {
  describe(gate.title, () => {
    let result: CompileResult = { diagnostics: [], elsewhere: [], rawOutput: '' };
    const onLine = (line: number): readonly Diagnostic[] =>
      result.diagnostics.filter((diagnostic) => diagnostic.line === line);
    const tagged = (tag: string): readonly number[] => linesTagged(gate.fixtureSource, tag);

    beforeAll(() => {
      result = compileFixture(gate);
    }, 300_000);

    afterAll(() => {
      rmSync(gate.fixtureDir, { recursive: true, force: true });
    });

    it(gate.testTitles.inventory, () => {
      for (const tag of ['FORBIDDEN', 'PERMITTED', 'DECLARED']) {
        expect(tagged(tag).length).toBeGreaterThan(0);
      }
      for (const tag of ['FORBIDDEN', 'PERMITTED', 'DECLARED']) {
        expect(tagged(tag)).toEqual(linesMentioning(gate.fixtureSource, tag));
      }
    });

    it.each(tagged('FORBIDDEN'))(gate.testTitles.forbidden, (line) => {
      expect(
        onLine(line).length,
        `no compile error on fixture line ${String(line)}. tsc said:\n${result.rawOutput}`,
      ).toBeGreaterThan(0);
    });

    it.each(tagged('PERMITTED'))(gate.testTitles.permitted, (line) => {
      const message = gate.permittedMessage?.(line, result.rawOutput);
      if (message === undefined) expect(onLine(line)).toEqual([]);
      else expect(onLine(line), message).toEqual([]);
    });

    it.each(tagged('DECLARED'))(
      'still compiles the declared escape on line %i, so the declared gap is not stale',
      (line) => {
        expect(onLine(line), `fixture line ${String(line)} ${DECLARED_STALE_HINT}`).toEqual([]);
      },
    );

    it('reports nothing on any line that is not tagged FORBIDDEN', () => {
      const expected = new Set(tagged('FORBIDDEN'));
      const unexpected = result.diagnostics.filter((diagnostic) => !expected.has(diagnostic.line));
      // The explicit else. Without it a fixture that failed to parse would satisfy every assertion
      // above and this gate would pass while proving nothing (ADR-0015).
      expect(unexpected, `unexpected diagnostics:\n${result.rawOutput}`).toEqual([]);
    });

    it('reports nothing in any file other than the fixture', () => {
      expect(
        result.elsewhere,
        'tsc raised a diagnostic outside the fixture, so the FORBIDDEN lines above may be failing ' +
          `for a reason this gate did not claim. tsc said:\n${result.rawOutput}`,
      ).toEqual([]);
    });
  });
}
