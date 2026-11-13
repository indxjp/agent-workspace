import { expect, it } from 'vitest';
import { asRecord, asString, loadVectors } from './vectors.js';
import { runId, stream, runMain, successRoute } from './cli-runs-fixture.js';
const outputVectors = loadVectors('cli-runs', 'output.json');
const flagVectors = loadVectors('cli-runs', 'flags.json');

it.each(outputVectors)('replays $id output mode', async ({ id, input, expected }) => {
  const fields = asRecord(input, id);
  const modeled = asRecord(expected, id);
  const flags = [
    ...(fields['raw'] === true ? ['--raw'] : []),
    ...(fields['json'] === true ? ['--json'] : []),
    ...(fields['jsonl'] === true ? ['--jsonl'] : []),
    ...(fields['quiet'] === true ? ['--quiet'] : []),
  ];
  const frame =
    'event: agent.session\nid: 1\ndata: {"frame":"agent.session","engine":"claude-agent-sdk",' +
    '"raw":{"type":"system","subtype":"init"},"engineSessionId":"sid","model":null}' +
    '\n\nevent: done\ndata: null\n\n';
  const streamed = await runMain(['runs', 'events', runId, ...flags], () => stream(frame));
  const mode = asString(modeled['streamMode'], 'streamMode');
  if (mode === 'human') expect(streamed.stdout).toBe('session sid\n');
  // `--raw` is the engine's own words; `--json`/`--jsonl` are the neutral event (ENG-03, #302).
  else if (mode === 'raw') expect(streamed.stdout).toContain('"subtype":"init"');
  else expect(streamed.stdout).toContain('"frame":"agent.session"');
  const listed = await runMain(['runs', 'list', ...flags], successRoute);
  const recordMode = asString(modeled['recordMode'], 'recordMode');
  if (recordMode === 'human') expect(listed.stdout).toContain('agentId');
  else if (recordMode === 'jsonl') expect(JSON.parse(listed.stdout)).toHaveProperty('agentId');
  else expect(JSON.parse(listed.stdout)).toMatchObject({ nextCursor: 'next' });
  const modeledNotice = asRecord(expected, id)['notice'];
  expect(listed.stderr.trimEnd().split('\n').filter(Boolean)).toEqual(modeledNotice);
});

it.each(flagVectors)('replays $id run flags', async ({ id, input, expected }) => {
  const fields = asRecord(input, id);
  if (id === 'resume') {
    const observed = await runMain(
      ['runs', 'events', 'r', '--after', asString(fields['after'], 'after')],
      () => stream(),
    );
    const headers = [
      ['accept', observed.calls[0]?.headers.get('accept')],
      ['last-event-id', observed.calls[0]?.headers.get('last-event-id')],
    ];
    expect(headers).toEqual(expected);
  } else {
    const observed = await runMain(
      [
        'runs',
        'list',
        '--status',
        asString(fields['status'], 'status'),
        '--agent',
        asString(fields['agent'], 'agent'),
        '--project',
        asString(fields['project'], 'project'),
        '--limit',
        String(fields['limit']),
        '--cursor',
        asString(fields['cursor'], 'cursor'),
      ],
      successRoute,
    );
    expect(Array.from(observed.calls[0]?.url.searchParams.entries() ?? [])).toEqual(expected);
  }
});
