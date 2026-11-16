/**
 * The email link's landing page holds the contract the journeys rely on (spec "Email-link
 * sign-in"). Like the gate's check, it reads `verify.tsx` as TypeScript, because the repository's
 * test projects have no React to render it with: the page shows a status while it works, an alert
 * with a link back when it fails. What it decides (the missing-link case, where it links back to) is
 * `signInStep` and `afterSignInPath`, tested in `try-messages.test.ts` and `try-fragment.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FILE = path.join(
  fileURLToPath(new URL('../..', import.meta.url)),
  'examples',
  'store',
  'app',
  'sign-in',
  'verify.tsx',
);
const text = readFileSync(FILE, 'utf8');
const source = ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function tags(): { tag: string; attributes: Record<string, string | true> }[] {
  const found: { tag: string; attributes: Record<string, string | true> }[] = [];
  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (opening !== null) {
      const attributes: Record<string, string | true> = {};
      for (const attribute of opening.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const { initializer } = attribute;
        attributes[attribute.name.getText(source)] =
          initializer !== undefined && ts.isStringLiteral(initializer) ? initializer.text : true;
      }
      found.push({ tag: opening.tagName.getText(source), attributes });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the sign-in view', () => {
  const elements = tags();

  it('shows a status while it works and an alert when it fails', () => {
    expect(elements.filter((e) => e.tag === 'p' && e.attributes['role'] === 'status')).toHaveLength(
      1,
    );
    expect(elements.filter((e) => e.tag === 'p' && e.attributes['role'] === 'alert')).toHaveLength(
      1,
    );
  });

  it('links back from the failed state, to where the page says (`state.back`)', () => {
    const links = elements.filter((e) => e.tag === 'a');
    expect(links).toHaveLength(1);
    expect(links[0]?.attributes['href']).toBe(true);
  });
});
