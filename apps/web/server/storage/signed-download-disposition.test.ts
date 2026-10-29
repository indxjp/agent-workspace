import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../../../tests/inventory-support';

/**
 * Every `createSignedUrl(…)` call that may sign a GET without naming the `Content-Disposition`
 * the store answers with. A request that is not an object literal is reported too: the check
 * cannot prove what it carries. The backends forward a disposition they are given (the
 * signed-URL tests); this proves every caller gives one, so a signed download is always an
 * attachment (the storage design, §05).
 */
function signedGetsWithoutDisposition(fileName: string, text: string): number[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const propertyNamed = (
    literal: ts.ObjectLiteralExpression,
    name: string,
  ): ts.ObjectLiteralElementLike | undefined =>
    literal.properties.find(
      (property) =>
        property.name !== undefined &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === name,
    );
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'createSignedUrl'
    ) {
      const request = node.arguments[1];
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      if (request === undefined || !ts.isObjectLiteralExpression(request)) {
        lines.push(line);
      } else {
        const method = propertyNamed(request, 'method');
        const signsPut =
          method !== undefined &&
          ts.isPropertyAssignment(method) &&
          ts.isStringLiteral(method.initializer) &&
          method.initializer.text === 'PUT';
        if (!signsPut && propertyNamed(request, 'responseDisposition') === undefined) {
          lines.push(line);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

describe('a signed download link always names its Content-Disposition (#1746)', () => {
  it('flags a GET, or a request it cannot read, that names no disposition', () => {
    const text = [
      "store.createSignedUrl(key, { method: 'GET', expiresInSeconds });",
      "store.createSignedUrl(key, { method: 'GET', responseDisposition: 'attachment' });",
      "store.createSignedUrl(key, { method: 'PUT', contentLength: 3 });",
      'store.createSignedUrl(key, request);',
    ].join('\n');
    expect(signedGetsWithoutDisposition('planted.ts', text)).toEqual([1, 4]);
  });

  // @story US-STO-05
  it('[US-STO-05][api][sdk] every production signing call names one for a GET', () => {
    const files = execFileSync(
      'git',
      [
        'grep',
        '-l',
        'createSignedUrl(',
        '--',
        'apps',
        'packages',
        ':(exclude)*.test.ts',
        ':(exclude)*.test.tsx',
        // The backends and the scoping wrappers forward a request; they do not compose one.
        ':(exclude)packages/core/src/storage/*',
        ':(exclude)apps/web/server/files/store.ts',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter((file) => file !== '');

    expect(files).toContain('apps/web/server/storage/service.ts');
    for (const file of files) {
      expect(
        signedGetsWithoutDisposition(file, readFileSync(`${REPO_ROOT}/${file}`, 'utf8')),
        `${file} signs a link without a responseDisposition`,
      ).toEqual([]);
    }
  });
});
