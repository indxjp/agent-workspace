import { expect, it } from 'vitest';
import { asRecord, asString, loadVectors } from './vectors.js';
import { agent, runId, runMain, successRoute } from './cli-runs-fixture.js';
const commandVectors = loadVectors('cli-runs', 'commands.json');
const startVectors = loadVectors('cli-runs', 'start.json');
const promptVectors = loadVectors('cli-runs', 'prompt.json');

it.each(commandVectors)('replays $id command dispatch', async ({ id, input, expected }) => {
  const command = asString(asRecord(input, id)['command'], 'command');
  const argv =
    command === 'start'
      ? ['runs', 'start', agent, '--prompt', 'go', '--json']
      : command === 'list'
        ? ['runs', 'list', '--json']
        : ['runs', command, runId, '--json'];
  const observed = await runMain(argv, successRoute);
  expect(observed.code).toBe(0);
  const sdkCall = asString(asRecord(expected, id)['sdkCall'], 'sdkCall');
  expect(observed.calls.length).toBeGreaterThan(0);
  const first = observed.calls[0];
  if (first === undefined) throw new Error('command made no request');
  if (sdkCall === 'start') expect(first.url.pathname).toBe(`/api/agents/${agent}/runs`);
  else if (sdkCall === 'list') expect(first.url.pathname).toBe('/api/runs');
  else if (sdkCall === 'events' || sdkCall === 'follow' || sdkCall === 'waitForOutcome')
    expect(first.url.pathname).toBe(`/api/runs/${runId}/events`);
  else if (sdkCall === 'interrupt') expect(first.url.pathname).toBe(`/api/runs/${runId}/interrupt`);
  else expect(first.url.pathname).toBe(`/api/runs/${runId}`);
});

it.each(startVectors)('replays $id start mode', async ({ id, input, expected }) => {
  const fields = asRecord(input, id);
  const mode = asString(asRecord(expected, id)['mode'], 'mode');
  const argv = ['runs', 'start', agent, '--prompt', 'go', '--json'];
  if (fields['wait'] === true) argv.push('--wait');
  if (fields['follow'] === true) argv.push('--follow');
  const observed = await runMain(argv, successRoute);
  expect(observed.code).toBe(mode === 'invalid' ? 2 : 0);
  expect(observed.calls.map((call) => call.url.pathname)).toEqual(
    mode === 'invalid'
      ? []
      : mode === 'plain'
        ? [`/api/agents/${agent}/runs`]
        : mode === 'follow'
          ? [`/api/agents/${agent}/runs`, `/api/runs/${runId}/events`]
          : [`/api/agents/${agent}/runs`, `/api/runs/${runId}/events`, `/api/runs/${runId}`],
  );
  const modeledCalls = asRecord(expected, id)['calls'];
  expect(modeledCalls).toEqual(
    mode === 'invalid'
      ? []
      : mode === 'plain'
        ? ['start']
        : mode === 'wait'
          ? ['start', 'waitForOutcome']
          : ['start', 'follow'],
  );
});

it.each(promptVectors)('replays $id prompt source', async ({ id, input, expected }) => {
  const fields = asRecord(input, id);
  const modeled = asRecord(expected, id);
  const argv = ['runs', 'start', agent];
  if (fields['inline'] === true) argv.push('--prompt', 'inline');
  if (fields['file'] === true) argv.push('--prompt-file', asString(fields['path'], 'path'));
  const observed = await runMain(argv, successRoute, { stdin: 'from stdin' });
  const source = asString(modeled['source'], 'source');
  const refused = source === 'missing' || source === 'conflict' || modeled['fileFailure'] === true;
  expect(observed.code).toBe(refused ? 2 : 0);
  expect(observed.calls).toHaveLength(refused ? 0 : 1);
  if (source === 'stdin') expect(observed.calls[0]?.body).toMatchObject({ prompt: 'from stdin' });
});
