import { expect, it } from 'vitest';
import { agent, runId, run, json, stream, runMain } from './cli-runs-fixture.js';

it('sends the events resume header and gives raw frames precedence over JSON', async () => {
  const observed = await runMain(['runs', 'events', runId, '--after', '7', '--raw', '--json'], () =>
    stream(
      'event: run.status\nid: 8\ndata: {"status":"running","error":null}\n\nevent: done\ndata: null\n\n',
    ),
  );
  expect(observed.code).toBe(0);
  expect(observed.calls[0]?.headers.get('last-event-id')).toBe('7');
  const lines = observed.stdout.trimEnd().split('\n');
  expect(lines.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual(['run-status']);
});

it('uses a fresh signal for courtesy interrupt after cancelled follow', async () => {
  const controller = new AbortController();
  const observed = await runMain(
    ['runs', 'follow', runId, '--interrupt-on-cancel'],
    ({ url }) => {
      if (url.pathname.endsWith('/events')) {
        controller.abort();
        throw new TypeError('stream dropped');
      }
      return json(200, { run: run('cancelled') });
    },
    { signal: controller.signal },
  );
  expect(observed.code).toBe(130);
  expect(observed.calls.map((call) => call.url.pathname)).toEqual([
    `/api/runs/${runId}/events`,
    `/api/runs/${runId}/interrupt`,
  ]);
  expect(observed.calls[1]?.signal?.aborted).toBe(false);
});

it('retains interrupted exit when the courtesy interrupt is refused', async () => {
  const controller = new AbortController();
  const observed = await runMain(
    ['runs', 'follow', runId, '--interrupt-on-cancel'],
    ({ url }) => {
      if (url.pathname.endsWith('/events')) {
        controller.abort();
        throw new TypeError('stream dropped');
      }
      return json(503, { error: { code: 'service_unavailable', message: 'later' } });
    },
    { signal: controller.signal },
  );
  expect(observed.code).toBe(130);
  expect(observed.calls).toHaveLength(2);
  expect(observed.stderr).toBe('interrupted\n');
});

it('start --wait exits zero after a failed settled run', async () => {
  const observed = await runMain(
    ['runs', 'start', agent, '--prompt', 'go', '--wait', '--json'],
    ({ url, method }) => {
      if (method === 'POST')
        return json(202, { run: run('queued'), events: `/api/runs/${runId}/events` });
      if (url.pathname.endsWith('/events')) return stream();
      return json(200, { run: run('failed') });
    },
  );
  expect(observed.code).toBe(0);
  expect(JSON.parse(observed.stdout)).toMatchObject({ status: 'failed' });
});
