import ts from 'typescript';

import { withRecommendedAnswers, type SetupAnswers } from '@indx-workspace/contracts/setup';

import { ProjectRenderError } from './errors.js';
import { renderProjectFiles } from './render.js';

export const recommended = withRecommendedAnswers({});

/** The recommended answers with `answers` over them, rendered for `my-project`. */
export function rendered(answers: SetupAnswers): readonly { path: string; contents: string }[] {
  return renderProjectFiles(withRecommendedAnswers(answers), {
    name: 'my-project',
    version: '0.4.0',
  });
}

export const ORDERS_ANSWERS = {
  'content.internalTools': ['openapi'],
  'content.openapiDocument': 'apis/orders.openapi.json',
} as const satisfies SetupAnswers;

export function contentsOf(
  files: readonly { path: string; contents: string }[],
  path: string,
): string {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`no ${path} was rendered`);
  return file.contents;
}

export function renderError(render: () => unknown): ProjectRenderError {
  try {
    render();
  } catch (thrown) {
    if (thrown instanceof ProjectRenderError) return thrown;
    throw thrown;
  }
  throw new Error('expected a ProjectRenderError');
}

/** The value of the string literal a rendered file gives a property, read by TypeScript itself. */
export function literalOf(source: string, property: string): string {
  const file = ts.createSourceFile('main.ts', source, ts.ScriptTarget.ES2023, true);
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === property &&
      ts.isStringLiteral(node.initializer)
    ) {
      found = node.initializer.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (found === undefined) throw new Error(`no ${property} literal`);
  return found;
}
