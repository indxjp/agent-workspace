import { expect, it } from 'vitest';
import { agent, runId, runMain, successRoute } from './cli-runs-fixture.js';

it('reads stdin prompt, preserves model suffix, and refuses conflicting prompt sources', async () => {
  const observed = await runMain(
    ['runs', 'start', agent, '--prompt-file', '-', '--model', 'connection:model:variant', '--json'],
    successRoute,
    { stdin: 'from stdin' },
  );
  expect(observed.code).toBe(0);
  expect(observed.calls[0]?.body).toMatchObject({
    prompt: 'from stdin',
    modelConnectionId: 'connection',
    model: 'model:variant',
  });
  const conflict = await runMain(
    ['runs', 'start', agent, '--prompt', 'inline', '--prompt-file', '-'],
    successRoute,
  );
  expect(conflict.code).toBe(2);
  expect(conflict.calls).toHaveLength(0);
});

it('prints the whole list page for JSON and rows plus cursor notice for a human', async () => {
  const structured = await runMain(['runs', 'list', '--json'], successRoute);
  expect(JSON.parse(structured.stdout)).toMatchObject({ nextCursor: 'next' });
  const human = await runMain(['runs', 'list'], successRoute);
  expect(human.stdout).toContain('agentId');
  expect(human.stderr).toBe('next page: --cursor next\n');
  const jsonl = await runMain(['runs', 'list', '--jsonl', '--quiet'], successRoute);
  expect(jsonl.stdout.trimEnd().split('\n')).toHaveLength(1);
  expect(JSON.parse(jsonl.stdout)).toHaveProperty('agentId');
  expect(jsonl.stderr).toBe('');
});

it('forwards list filters and refuses a malformed status before fetch', async () => {
  const filtered = await runMain(
    [
      'runs',
      'list',
      '--status',
      'completed',
      '--agent',
      agent,
      '--project',
      'project',
      '--limit',
      '2',
      '--cursor',
      'next',
      '--json',
    ],
    successRoute,
  );
  expect(filtered.code).toBe(0);
  expect(filtered.calls[0]?.url.search).toBe(
    `?status=completed&agent=${agent}&project=project&limit=2&cursor=next`,
  );
  const refused = await runMain(['runs', 'list', '--status', 'unknown'], successRoute);
  expect(refused.code).toBe(2);
  expect(refused.calls).toHaveLength(0);
});

it('prioritizes interrupted exit over a transport failure', async () => {
  const controller = new AbortController();
  controller.abort();
  const observed = await runMain(
    ['runs', 'get', runId],
    () => {
      throw new TypeError('offline');
    },
    { signal: controller.signal },
  );
  expect(observed.code).toBe(130);
  expect(observed.stderr).toBe('interrupted\n');
});
