/**
 * Per-subpath reference pages: one `##` section per export of a barrel `index.ts`
 * (`moduleExports` resolves each re-export to its real declaration). `reference/sdk/events.mdx`
 * (brief §C) and `reference/sdk/define.mdx` are both rendered through `renderSubpathPage`.
 */
import ts from 'typescript';

import { pageHeader, finalizePage, codeBlock } from './mdx.mjs';
import { mdxDoc, signatureText, moduleExports } from './ts-nodes.mjs';
import { renderTypeSection } from './type-render.mjs';

/** @param {ts.TypeChecker} checker @param {import('./ts-nodes.mjs').ModuleExport} entry */
function renderExport(checker, entry) {
  if (entry.kind === 'function' && ts.isFunctionDeclaration(entry.node)) {
    const signature = signatureText(checker, entry.name, entry.node);
    return [`## ${entry.name}`, '', mdxDoc(entry.node), '', codeBlock('ts', signature)].join(
      '\n\n',
    );
  }
  const type = checker.getTypeAtLocation(entry.node);
  return [
    `## ${entry.name}`,
    '',
    mdxDoc(entry.node),
    '',
    renderTypeSection(checker, type, entry.node),
  ].join('\n\n');
}

/**
 * Render every export of one subpath barrel as a reference page.
 * @param {ts.TypeChecker} checker
 * @param {ts.SourceFile} indexFile the subpath's barrel
 * @param {{ readonly title: string, readonly description: string, readonly sources: readonly string[] }} page
 */
export function renderSubpathPage(checker, indexFile, { title, description, sources }) {
  const header = pageHeader({ title, description, sources: [...sources] });
  const body = moduleExports(checker, indexFile)
    .map((entry) => renderExport(checker, entry))
    .join('\n\n');
  return finalizePage(`${header}\n${body}`);
}

/** @param {ts.TypeChecker} checker @param {ts.SourceFile} eventsIndexFile */
export function renderEventsPage(checker, eventsIndexFile) {
  return renderSubpathPage(checker, eventsIndexFile, {
    title: 'Events',
    description:
      'The `@indx-workspace/sdk/events` exports: the SSE parser and the neutral AgentEvent view.',
    sources: [
      'packages/sdk/src/events/index.ts',
      'packages/sdk/src/events/sse.ts',
      'packages/sdk/src/events/run-events.ts',
      'packages/sdk/src/events/agent-event.ts',
    ],
  });
}
