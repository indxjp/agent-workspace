/**
 * The Try tab's sign-up gate holds the contract the journeys and the detail page rely on (spec "How
 * Try it works", "Email-link sign-in"). The check reads `gate.tsx` as TypeScript, because the
 * repository's test projects have no React to render it with (the apps lane's `node:test` cannot
 * load TSX either): the form, its fields, the consent label's link to the privacy notice, the
 * challenge slot, the alert, the platform's message slot and the body the form sends.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TRY_DIR = path.join(REPOSITORY_ROOT, 'examples', 'store', 'app', 'agents', '[slug]', 'try');

function parse(file: string): ts.SourceFile {
  const full = path.join(TRY_DIR, file);
  return ts.createSourceFile(
    full,
    readFileSync(full, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

/** One JSX element: its tag, its string attributes (a bare attribute is `true`) and its parent chain. */
interface Element {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string | true>>;
  readonly ancestors: readonly string[];
}

function elementsOf(source: ts.SourceFile): Element[] {
  const found: Element[] = [];
  const visit = (node: ts.Node, ancestors: readonly string[]): void => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    let chain = ancestors;
    if (opening !== null) {
      const tag = opening.tagName.getText(source);
      const attributes: Record<string, string | true> = {};
      for (const attribute of opening.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const { initializer } = attribute;
        attributes[attribute.name.getText(source)] =
          initializer !== undefined && ts.isStringLiteral(initializer) ? initializer.text : true;
      }
      found.push({ tag, attributes, ancestors });
      chain = [...ancestors, tag];
    }
    ts.forEachChild(node, (child) => {
      visit(child, chain);
    });
  };
  visit(source, []);
  return found;
}

const gate = elementsOf(parse('gate.tsx'));
const named = (tag: string, attributes: Record<string, string>) =>
  gate.filter(
    (element) =>
      element.tag === tag &&
      Object.entries(attributes).every(([k, v]) => element.attributes[k] === v),
  );

describe('the sign-up gate', () => {
  it('is a form with the test id the journeys use, checked by us rather than the browser', () => {
    const [form] = named('form', { 'data-testid': 'try-gate' });
    expect(form?.attributes['noValidate']).toBe(true);
  });

  it('asks for an email address and a consent tick, by the names the platform uses', () => {
    expect(named('input', { type: 'email', name: 'email' })).toHaveLength(1);
    expect(named('input', { type: 'checkbox', name: 'consent' })).toHaveLength(1);
  });

  it('puts the consent copy and its link to /privacy in the checkbox label', () => {
    const [checkbox] = named('input', { type: 'checkbox', name: 'consent' });
    expect(checkbox?.ancestors.at(-1)).toBe('label');
    expect(named('Consent', {}).some((element) => element.ancestors.at(-1) === 'label')).toBe(true);
    expect(named('a', { href: '/privacy' }).length).toBeGreaterThan(0);
  });

  it('has the challenge slot, a submit button, an alert and the platform-message slot', () => {
    expect(named('ChallengeSlot', {})).toHaveLength(1);
    expect(named('button', { type: 'submit' })).toHaveLength(1);
    expect(named('p', { role: 'alert' })).toHaveLength(1);
    expect(named('p', { 'data-testid': 'try-gate-message' })).toHaveLength(1);
  });
});
