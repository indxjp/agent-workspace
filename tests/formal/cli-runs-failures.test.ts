import { expect, it } from 'vitest';
import { asRecord, asString, loadVectors } from './vectors.js';
import { agent, runId, run, json, stream, runMain, successRoute } from './cli-runs-fixture.js';
const waitVectors = loadVectors('cli-runs', 'wait.json');
const exitVectors = loadVectors('cli-runs', 'exits.json');
const stderrVectors = loadVectors('cli-runs', 'stderr.json');

it.each(waitVectors)(
  'replays $id settled wait exit divergence',
  async ({ id, input, expected }) => {
    const status = asString(asRecord(input, id)['status'], 'status');
    const current = asRecord(expected, id)['currentExit'];
    const observed = await runMain(['runs', 'wait', runId, '--json'], ({ url }) =>
      url.pathname.endsWith('/events') ? stream() : json(200, { run: run(status) }),
    );
    expect(observed.code).toBe(current);
    expect(JSON.parse(observed.stdout)).toMatchObject({ status });
  },
);

it.each(exitVectors)('replays $id failure exit', async ({ id, input, expected }) => {
  const failure = asString(asRecord(input, id)['failure'], 'failure');
  const modeledExit = asRecord(expected, id)['exit'];
  const observed =
    failure === 'usage'
      ? await runMain(['runs', 'start', agent], successRoute)
      : failure === 'unexpected'
        ? await runMain(['runs', 'get', runId], successRoute, { throwOnStdout: true })
        : await runMain(['runs', 'get', runId], () => {
            if (failure === 'transport') throw new TypeError('offline');
            if (failure === 'contractViolation') return json(200, { run: { status: 'bad' } });
            return json(409, { error: { code: 'refused', message: 'no' } });
          });
  expect(observed.code).toBe(modeledExit);
  expect(observed.stderr).not.toBe('');
});

it('prints API details after the headline and suppresses them on SIGINT', async () => {
  const route = () =>
    json(409, {
      error: { code: 'conflict', message: 'try later', details: ['field: bad'] },
    });
  const refused = await runMain(['runs', 'get', runId], route);
  expect(refused.code).toBe(1);
  expect(refused.stdout).toBe('');
  expect(refused.stderr).toBe('error: conflict: try later\n  field: bad\n');
  const controller = new AbortController();
  controller.abort();
  const interrupted = await runMain(['runs', 'get', runId], route, {
    signal: controller.signal,
  });
  expect(interrupted.code).toBe(130);
  expect(interrupted.stderr).toBe('interrupted\n');
});

it.each(stderrVectors)('replays $id failure lines', async ({ id, input, expected }) => {
  const interrupted = asRecord(input, id)['interrupted'] === true;
  const controller = new AbortController();
  if (interrupted) controller.abort();
  const observed = await runMain(
    ['runs', 'get', runId],
    () =>
      json(409, {
        error: { code: 'conflict', message: 'try later', details: ['field: bad'] },
      }),
    { signal: controller.signal },
  );
  expect(observed.stderr.trimEnd().split('\n')).toEqual(expected);
});
