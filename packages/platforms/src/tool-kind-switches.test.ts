import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Refactoring part 11: each target keeps its own `switch (tool.kind)` instead of a shared
// descriptor table, because each says something different for the same kind. What makes that safe
// is the type checker: every switch is the body of a function with a declared return type, so with
// `noImplicitReturns` a tool kind a target does not handle fails the build. A `default:` branch
// would silently swallow a new kind, so none of these switches may have one.

const SWITCH = /switch \(tool\.kind\) \{/gu;

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/** The text between a switch's opening brace and its matching closing brace. */
function switchBody(source: string, open: number): string {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error('unbalanced braces after a switch (tool.kind)');
}

/** One entry per `switch (tool.kind)` in the package: where it is, and its body. */
function toolKindSwitches(): { where: string; body: string }[] {
  return sourceFiles(join(packageRoot, 'src')).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(SWITCH)].map((match) => ({
      where: `${file.slice(packageRoot.length + 1)}:${String(source.slice(0, match.index).split('\n').length)}`,
      body: switchBody(source, match.index + match[0].length - 1),
    }));
  });
}

describe('switch (tool.kind) in the platform targets', () => {
  const switches = toolKindSwitches();

  it('finds every target switch, so the rule below cannot pass on nothing', () => {
    expect(switches.length).toBeGreaterThanOrEqual(8);
  });

  it('has no default branch, so a new tool kind fails the typecheck in every target', () => {
    expect(
      switches.filter(({ body }) => /\bdefault\s*:/u.test(body)).map(({ where }) => where),
    ).toEqual([]);
  });
});
