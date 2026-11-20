// The RF-001 expected-failure register's reader: every tracked `it.fails` / `test.fails` call, the
// modifiers that make one non-evidence, and the expiry ids of the register's table. Its fixture
// cases are tests/refactoring-characterization-register.test.ts; the comparison over the tracked
// tree is tests/refactoring-characterization-register.policy-check.ts (`pnpm policy:check`).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const decisionLedger = path.join(
  repositoryRoot,
  'docs/20-design/architecture/refactoring/claude-agent-workspace-refactoring-decisions.md',
);
const RF_ID = /RF-[0-9]{3}/gu;
const SOURCE_PATHSPECS = [
  '*.ts',
  '*.tsx',
  '*.mts',
  '*.cts',
  '*.js',
  '*.jsx',
  '*.mjs',
  '*.cjs',
] as const;

interface ExpectedFailureCall {
  readonly file: string;
  readonly line: number;
  readonly rfIds: readonly string[];
  readonly modifiers: readonly string[];
  readonly unconditionalSkipModifiers: readonly string[];
}

export function trackedSourceFiles(): readonly string[] {
  const output = execFileSync('git', ['ls-files', '-z', '--', ...SOURCE_PATHSPECS], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return output.split('\0').filter((file) => file !== '');
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

interface TestModifierChain {
  readonly root: 'it' | 'test';
  readonly modifiers: readonly string[];
}

function testModifierChain(node: ts.Node): TestModifierChain | null {
  if (ts.isIdentifier(node)) {
    return node.text === 'it' || node.text === 'test' ? { root: node.text, modifiers: [] } : null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const chain = testModifierChain(node.expression);
    return chain === null
      ? null
      : { root: chain.root, modifiers: [...chain.modifiers, node.name.text] };
  }
  if (ts.isCallExpression(node)) return testModifierChain(node.expression);
  if (ts.isTaggedTemplateExpression(node)) return testModifierChain(node.tag);
  return null;
}

interface ExpectedFailureChain {
  readonly title: ts.Expression;
  readonly modifiers: readonly string[];
}

function expectedFailureChain(call: ts.CallExpression): ExpectedFailureChain | null {
  const chain = testModifierChain(call.expression);
  if (chain === null || !chain.modifiers.includes('fails')) return null;

  // Modifiers that take an argument and return a chainable test API are factories, not test
  // declarations. Their parent calls (or the call after a tagged table) own the title. Other
  // trailing modifiers such as `.only` and `.skip` are declarations themselves and therefore keep
  // their first argument.
  const finalModifier = chain.modifiers.at(-1);
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    (finalModifier === 'each' ||
      finalModifier === 'for' ||
      finalModifier === 'skipIf' ||
      finalModifier === 'runIf')
  ) {
    return null;
  }
  const title = call.arguments[0];
  return title === undefined ? null : { title, modifiers: chain.modifiers };
}

function unconditionalSkipModifiers(expression: ts.Expression): readonly string[] {
  const modifiers: string[] = [];

  function visit(node: ts.Expression): void {
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) {
        const modifier = node.expression.name.text;
        const condition = node.arguments[0];
        if (modifier === 'skipIf' && condition?.kind === ts.SyntaxKind.TrueKeyword) {
          modifiers.push('skipIf(true)');
        }
        if (modifier === 'runIf' && condition?.kind === ts.SyntaxKind.FalseKeyword) {
          modifiers.push('runIf(false)');
        }
      }
      visit(node.expression);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression);
      return;
    }
    if (ts.isTaggedTemplateExpression(node)) visit(node.tag);
  }

  visit(expression);
  return modifiers;
}

export function expectedFailureCallsInSource(
  file: string,
  source: string,
): readonly ExpectedFailureCall[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const calls: ExpectedFailureCall[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const chain = expectedFailureChain(node);
      if (chain !== null) {
        const { title } = chain;
        const line = sourceFile.getLineAndCharacterOfPosition(title.getStart(sourceFile)).line + 1;
        calls.push({
          file,
          line,
          rfIds: [...new Set(title.getText(sourceFile).match(RF_ID) ?? [])].sort(),
          modifiers: chain.modifiers,
          unconditionalSkipModifiers: unconditionalSkipModifiers(node.expression),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return calls;
}

export function expectedFailureCalls(file: string): readonly ExpectedFailureCall[] {
  return expectedFailureCallsInSource(file, readFileSync(path.join(repositoryRoot, file), 'utf8'));
}

export function skippedExpectedFailureDiagnostics(
  calls: readonly ExpectedFailureCall[],
): readonly string[] {
  return calls
    .map((call) => ({
      call,
      ignoredModifiers: [
        ...call.modifiers.filter((modifier) => modifier === 'skip' || modifier === 'todo'),
        ...call.unconditionalSkipModifiers,
      ],
    }))
    .filter(({ ignoredModifiers }) => ignoredModifiers.length > 0)
    .map(
      ({ call, ignoredModifiers }) =>
        `${call.file}:${String(call.line)} -> ${ignoredModifiers.join(', ')}`,
    );
}

function registerSection(markdown: string): string {
  const heading = '## RF-001 characterization register';
  const start = markdown.indexOf(heading);
  if (start === -1) throw new Error(`Decision ledger has no ${JSON.stringify(heading)} heading.`);
  const nextHeading = markdown.indexOf('\n## ', start + heading.length);
  return markdown.slice(start, nextHeading === -1 ? markdown.length : nextHeading);
}

function markdownTableCells(line: string): readonly string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

export function registeredExpiryIds(markdown: string): readonly string[] {
  const lines = registerSection(markdown).split('\n');
  const headerIndex = lines.findIndex((line) => markdownTableCells(line)?.includes('Expires in'));
  if (headerIndex === -1) {
    throw new Error('RF-001 characterization register has no `Expires in` column.');
  }

  const header = markdownTableCells(lines[headerIndex] ?? '');
  if (header === null) throw new Error('RF-001 characterization register header is not a table.');
  const expiryColumn = header.indexOf('Expires in');
  const separator = markdownTableCells(lines[headerIndex + 1] ?? '');
  if (separator === null) {
    throw new Error('RF-001 characterization register has no table separator.');
  }
  if (separator.length !== header.length) {
    throw new Error('RF-001 characterization register separator has the wrong column count.');
  }
  if (separator.some((cell) => !/^:?-{3,}:?$/u.test(cell))) {
    throw new Error('RF-001 characterization register has a malformed table separator.');
  }

  const ids: string[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (line.trim() === '') break;
    const cells = markdownTableCells(line);
    if (cells === null)
      throw new Error('RF-001 characterization register has a malformed data row.');
    if (cells.length !== header.length) {
      throw new Error('RF-001 characterization register data row has the wrong column count.');
    }
    const expiryId = cells[expiryColumn] ?? '';
    if (/^RF-[0-9]{3}$/u.test(expiryId)) ids.push(expiryId);
  }
  return [...new Set(ids)].sort();
}
