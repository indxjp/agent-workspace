import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import { renderReferencePages } from '../../scripts/docs/generate-sdk-reference.mjs';
import {
  COMMAND_FACTORIES,
  commandArrayOrder,
  commandCalls,
  importSpecifiers,
  renderCliPage,
} from '../../scripts/docs/lib/render-cli.mjs';

// Issue #484: the CLI reference matched only `command(...)` calls, so `aw login` and `aw logout`
// (built with `credentialFreeCommand(...)`) were missing from `reference/cli/commands.mdx`.
const repoRoot = path.resolve(import.meta.dirname, '../..');
const awSourceDir = path.join(repoRoot, 'packages', 'aw', 'src');
const commandsDir = path.join(awSourceDir, 'commands');
const COMMAND_RETURN_TYPES: ReadonlySet<string> = new Set([
  'ApiCommand',
  'LocalCommand',
  'Command',
]);

function parseFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

function syntheticFile(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
}

function isExported(declaration: ts.FunctionDeclaration): boolean {
  return (
    ts
      .getModifiers(declaration)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
  );
}

/** Every exported function of `command.ts` declared (on any overload) to return a command. */
function commandFactoriesDeclaredIn(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
    if (!isExported(statement) || statement.type === undefined) continue;
    if (COMMAND_RETURN_TYPES.has(statement.type.getText(sourceFile))) {
      names.add(statement.name.text);
    }
  }
  return names;
}

function commandHeadings(page: string): ReadonlySet<string> {
  return new Set(
    page
      .split('\n')
      .filter((line) => line.startsWith('## aw '))
      .map((line) => line.slice('## aw '.length)),
  );
}

describe('renderCliPage', () => {
  // The direct regression test for #484: it fails on the old `=== 'command'` matcher.
  it('renders command(...) and credentialFreeCommand(...) calls alike', () => {
    const indexFile = syntheticFile(
      'index.ts',
      "import { sampleCommands } from './sample.js';\nexport const COMMANDS = [...sampleCommands];\n",
    );
    const helpFile = syntheticFile('help.ts', 'const GLOBAL_FLAGS = `--url <url>`;\n');
    const outputFile = syntheticFile('output.ts', 'export const EXIT_CODE = { ok: 0 } as const;\n');
    const sampleFile = syntheticFile(
      'sample.ts',
      [
        'export const sampleCommands = [',
        "  command('a b', '', 'A', async () => undefined),",
        "  credentialFreeCommand('c', '<x>', 'C', async () => undefined),",
        '];',
        '',
      ].join('\n'),
    );

    const page = renderCliPage(
      { indexFile, helpFile, outputFile },
      new Map([['sampleCommands', sampleFile]]),
    );

    expect(page).toContain('## aw a b\n\nA\n\n```\naw a b\n```');
    expect(page).toContain('## aw c\n\nC\n\n```\naw c <x>\n```');
    expect(page.indexOf('## aw a b')).toBeLessThan(page.indexOf('## aw c'));
  });

  it('refuses a factory call whose path, usage or summary is not a string literal', () => {
    const sampleFile = syntheticFile(
      'sample.ts',
      "const path = 'p';\nexport const sampleCommands = [credentialFreeCommand(path, '', 'S', run)];\n",
    );
    expect(() => commandCalls(sampleFile)).toThrow(/sample\.ts:2:\d+: credentialFreeCommand/u);
  });
});

describe('the CLI reference is complete', () => {
  let page: string;

  beforeAll(async () => {
    const pages = await renderReferencePages(repoRoot);
    const rendered = pages.get('cli/commands.mdx');
    if (rendered === undefined) throw new Error('cli/commands.mdx was not rendered');
    page = rendered;
  }, 60_000);

  it('lists aw login and aw logout', () => {
    expect(page).toContain('## aw login');
    expect(page).toContain('## aw logout');
  });

  it('matches every command factory command.ts exports', () => {
    const declared = commandFactoriesDeclaredIn(parseFile(path.join(awSourceDir, 'command.ts')));
    expect([...declared].sort()).toEqual([...COMMAND_FACTORIES].sort());
  });

  it('has a heading for every factory call in every file COMMANDS names', () => {
    const indexFile = parseFile(path.join(commandsDir, 'index.ts'));
    const specifiers = importSpecifiers(indexFile);
    const headings = commandHeadings(page);
    const order = commandArrayOrder(indexFile);
    expect(order.length).toBeGreaterThan(0);
    let callCount = 0;
    for (const identifier of order) {
      const specifier = specifiers.get(identifier);
      if (specifier === undefined) throw new Error(`no import declares ${identifier}`);
      const fileName = path.basename(specifier).replace(/\.js$/u, '.ts');
      for (const call of commandCalls(parseFile(path.join(commandsDir, fileName)))) {
        callCount += 1;
        expect(headings, `${fileName}: aw ${call.path}`).toContain(call.path);
      }
    }
    expect(callCount).toBe(headings.size);
  });
});
