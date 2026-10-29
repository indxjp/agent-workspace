// scripts/docs/lib/literal-values.mjs: a reference page shows the value a constant resolves to when
// its initializer only names another constant (#1745, from the STO-101 follow-up review).
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { renderLiteralConst } from '../../scripts/docs/lib/literal-values.mjs';

const SOURCE = [
  'const MiB = 1024 * 1024;',
  'export const ATTACHMENT_MAX_BYTES = 10485760;',
  "export const CONNECTOR = 'aw-control';",
  'export const PATTERN = /^[a-z]+$/u;',
  'export const ALIAS_NUMBER = ATTACHMENT_MAX_BYTES;',
  'export const ALIAS_STRING = CONNECTOR as typeof CONNECTOR;',
  'export const ALIAS_PATTERN = PATTERN;',
  'export const COMPUTED = 64 * MiB;',
  'export const ALIAS_COMPUTED = COMPUTED;',
  'export const ALIAS_OF_ALIAS = ALIAS_COMPUTED;',
  "const PREFIX = 'aw-';",
  "export const JOINED = PREFIX + 'control';",
  'export const ALIAS_JOINED = JOINED;',
  'let mutable = 1;',
  'export const ALIAS_MUTABLE = mutable;',
  '',
].join('\n');

function initializers(): { checker: ts.TypeChecker; of: (name: string) => ts.Expression } {
  const fileName = '/virtual/limits.ts';
  const host = ts.createCompilerHost({ strict: true, noEmit: true });
  const readFile = host.readFile.bind(host);
  host.readFile = (file) => (file === fileName ? SOURCE : readFile(file));
  host.fileExists = (file) => file === fileName || ts.sys.fileExists(file);
  const program = ts.createProgram([fileName], { strict: true, noEmit: true }, host);
  const source = program.getSourceFile(fileName);
  if (source === undefined) throw new Error('the virtual source did not load');
  const declarations = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
        declarations.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return {
    checker: program.getTypeChecker(),
    of: (name) => {
      const initializer = declarations.get(name);
      if (initializer === undefined) throw new Error(`${name} is not declared`);
      return initializer;
    },
  };
}

describe('reference values', () => {
  const { checker, of } = initializers();

  it('shows the literal a named constant resolves to', () => {
    expect(renderLiteralConst(of('ALIAS_NUMBER'), checker)).toBe(
      'Value: `ATTACHMENT_MAX_BYTES` (`10485760`)',
    );
    expect(renderLiteralConst(of('ALIAS_STRING'), checker)).toBe(
      "Value: `CONNECTOR` (`'aw-control'`)",
    );
  });

  it('folds a named constant whose own value is computed', () => {
    expect(renderLiteralConst(of('ALIAS_COMPUTED'), checker)).toBe(
      'Value: `COMPUTED` (`67108864`)',
    );
    expect(renderLiteralConst(of('ALIAS_OF_ALIAS'), checker)).toBe(
      'Value: `ALIAS_COMPUTED` (`67108864`)',
    );
    expect(renderLiteralConst(of('ALIAS_JOINED'), checker)).toBe(
      "Value: `JOINED` (`'aw-control'`)",
    );
  });

  it('leaves a literal, a computed value and a non-literal name as written', () => {
    expect(renderLiteralConst(of('ATTACHMENT_MAX_BYTES'), checker)).toBe('Value: `10485760`');
    expect(renderLiteralConst(of('COMPUTED'), checker)).toBe('Value: `64 * MiB`');
    expect(renderLiteralConst(of('ALIAS_PATTERN'), checker)).toBe('Value: `PATTERN`');
    expect(renderLiteralConst(of('ALIAS_MUTABLE'), checker)).toBe('Value: `mutable`');
    expect(renderLiteralConst(of('ALIAS_NUMBER'))).toBe('Value: `ATTACHMENT_MAX_BYTES`');
  });
});
