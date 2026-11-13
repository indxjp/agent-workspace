/**
 * A `node --test` reporter for the apps lane (`lane.mjs`, issue #1531): one JSON line per test
 * that settled, with its title and whether it passed, failed, was skipped or is a todo. The lane
 * reads it to require that the test an app's `agentOnData.ref` names really ran and passed, which
 * the exit code alone does not say (a skipped or todo test exits 0).
 *
 *   node --test --test-reporter=<this file> --test-reporter-destination=<file> <test files>
 *
 * @param {AsyncIterable<{ type: string, data: { name: string, skip?: unknown, todo?: unknown } }>} source
 */
export default async function* testResultsReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { name, skip, todo } = event.data;
    const settled = event.type === 'test:pass' ? 'passed' : 'failed';
    const status = isMarked(skip) ? 'skipped' : isMarked(todo) ? 'todo' : settled;
    yield `${JSON.stringify({ title: name, status })}\n`;
  }
}

/** `skip` and `todo` are `true` or a reason string when set. @param {unknown} mark */
const isMarked = (mark) => mark === true || (typeof mark === 'string' && mark !== '');
