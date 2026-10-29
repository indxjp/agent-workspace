import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../../../tests/inventory-support';

import { toResponse } from './http';

/** The header name `name` names, lower-cased, when it is a string-literal property or argument. */
function headerName(node: ts.Node | undefined): string | null {
  if (node === undefined) return null;
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text.toLowerCase()
    : null;
}

function isNosniff(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    node.text.toLowerCase() === 'nosniff'
  );
}

/** A headers object literal that sets `x-content-type-options: nosniff` itself. */
function literalSetsNosniff(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      headerName(property.name) === 'x-content-type-options' &&
      isNosniff(property.initializer),
  );
}

/** A `<receiver>.set(...)` / `.append(...)` call and the header it sets. */
function headerSetCall(
  node: ts.Node,
): { receiver: string; name: string; value: ts.Node | undefined } | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  if (!['set', 'append'].includes(node.expression.name.text)) return null;
  const name = headerName(node.arguments[0]);
  return name === null
    ? null
    : { receiver: node.expression.expression.getText(), name, value: node.arguments[1] };
}

/** The enclosing function body (or the file) a `.set` call runs in. */
function scopeOf(node: ts.Node): ts.Node {
  let current = node.parent;
  while (current !== undefined && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) {
    current = current.parent;
  }
  return current ?? node.getSourceFile();
}

function setsNosniffOn(scope: ts.Node, receiver: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    const call = headerSetCall(node);
    if (
      call !== null &&
      call.receiver === receiver &&
      call.name === 'x-content-type-options' &&
      isNosniff(call.value)
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/**
 * Every place the source sets `content-disposition` without `nosniff` beside it: in the same
 * headers object literal, or a `.set` on the same receiver in the same function. Read from the
 * syntax tree, so the distance between the two lines does not matter, and a `nosniff` in a
 * neighbouring literal does not count.
 */
function dispositionsWithoutNosniff(fileName: string, text: string): number[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      headerName(node.name) === 'content-disposition' &&
      ts.isObjectLiteralExpression(node.parent) &&
      !literalSetsNosniff(node.parent)
    ) {
      lines.push(lineOf(node));
    }
    const call = headerSetCall(node);
    if (call?.name === 'content-disposition' && !setsNosniffOn(scopeOf(node), call.receiver)) {
      lines.push(lineOf(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

describe('the content-disposition check reads the syntax tree (#1746)', () => {
  it('accepts a headers literal that sets nosniff far from the disposition', () => {
    const text = [
      'const headers = {',
      "  'content-disposition': 'attachment',",
      "  'a': '1',",
      "  'b': '2',",
      "  'c': '3',",
      "  'd': '4',",
      "  'x-content-type-options': 'nosniff',",
      '};',
    ].join('\n');
    expect(dispositionsWithoutNosniff('far.ts', text)).toEqual([]);
  });

  it('flags a disposition whose nosniff sits in a neighbouring literal', () => {
    const text = [
      "const page = { 'content-disposition': 'inline' };",
      "const other = { 'x-content-type-options': 'nosniff' };",
    ].join('\n');
    expect(dispositionsWithoutNosniff('neighbour.ts', text)).toEqual([1]);
  });

  it('accepts Headers.set calls on one receiver, and flags a set without nosniff', () => {
    const covered = [
      'function serve(headers: Headers) {',
      "  headers.set('Content-Disposition', 'attachment');",
      "  headers.set('X-Content-Type-Options', 'nosniff');",
      '}',
    ].join('\n');
    const uncovered = [
      'function serve(headers: Headers, other: Headers) {',
      "  headers.set('content-disposition', 'attachment');",
      "  other.set('x-content-type-options', 'nosniff');",
      '}',
    ].join('\n');
    expect(dispositionsWithoutNosniff('covered.ts', covered)).toEqual([]);
    expect(dispositionsWithoutNosniff('uncovered.ts', uncovered)).toEqual([2]);
  });
});

describe('stored bytes are never served as a page from the app origin (the storage design, §05)', () => {
  // @story US-STO-05
  it('[US-STO-05][api][sdk] every stored-bytes response is an attachment with nosniff', () => {
    const files = execFileSync(
      'git',
      ['grep', '-l', '-i', 'content-disposition', '--', 'apps/web/server', ':(exclude)*.test.ts'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter((file) => file !== '');

    expect(files).toEqual(
      expect.arrayContaining([
        'apps/web/server/files/http.ts',
        'apps/web/server/platforms/http.ts',
      ]),
    );
    for (const file of files) {
      expect(
        dispositionsWithoutNosniff(file, readFileSync(`${REPO_ROOT}/${file}`, 'utf8')),
        `${file} sets content-disposition without x-content-type-options: nosniff beside it`,
      ).toEqual([]);
    }

    const response = toResponse({
      kind: 'binary',
      status: 200,
      body: new Uint8Array([1, 2, 3]),
      contentType: 'application/octet-stream',
      filename: 'q3.pdf',
    });
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/u);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
