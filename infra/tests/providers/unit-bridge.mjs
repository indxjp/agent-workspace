import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BRIDGE_PREFIX,
  bridgeWorkerName,
  deleteBridgeResources,
  isLaneName,
  isLeftover,
  isWorkerPropagating,
  ownedBy,
  renderConfig,
  retryWorkerPropagation,
  waitForBridge,
  WORKER_PROPAGATION_DELAYS_MS,
  workersDevUrl,
} from './cloudflare-bridge.mjs';

const BRIDGE = 'https://bridge-ci-1.acct.workers.dev';
const edge404 = () =>
  new Response('<html>There is nothing here yet SENTINEL_BODY</html>', { status: 404 });
const bridgeAnswer = (status, error) => () => Response.json({ error }, { status });
const noSleep = () => Promise.resolve();

test('the bridge wait resolves only on the bridge-owned 401, after the edge 404 and the 503', async () => {
  const answers = [
    edge404,
    bridgeAnswer(503, 'not_configured'),
    () => new Response('x', { status: 401 }),
    bridgeAnswer(401, 'unauthorized'),
  ];
  const seen = [];
  await waitForBridge(BRIDGE, {
    sleep: noSleep,
    fetch: (url, init) => {
      seen.push(`${init.method} ${url}`);
      return Promise.resolve(answers[seen.length - 1]());
    },
  });
  assert.deepEqual(seen, Array(4).fill(`POST ${BRIDGE}/v1/sandboxes`));
});

test('the bridge wait fails with the last answer and none of the body, never skips', async () => {
  const error = await waitForBridge(BRIDGE, {
    sleep: () => new Promise((resolve) => setTimeout(resolve, 2)),
    timeoutMs: 20,
    intervalMs: 2,
    fetch: () => Promise.resolve(edge404()),
  }).then(
    () => assert.fail('expected a timeout'),
    (thrown) => thrown,
  );
  assert.match(error.message, /last answer 404 not the bridge/u);
  assert.doesNotMatch(error.message, /SENTINEL_BODY/u);
});

test('the workers.dev URL is the deployed Worker, not another URL in the output', () => {
  const output =
    'See https://other.acct.workers.dev\nDeployed https://bridge-ci-1.acct.workers.dev (1.2 sec)';
  assert.equal(workersDevUrl(output, 'bridge-ci-1'), BRIDGE);
  assert.throws(
    () => workersDevUrl('https://other.acct.workers.dev', 'bridge-ci-1'),
    /no workers\.dev URL for bridge-ci-1/u,
  );
});

// The message `deployBridge`'s `run` throws: the command and the redacted tail of its output.
const wranglerFailure = (code) =>
  new Error(
    `wrangler deploy failed: ✘ [ERROR] A request to the Cloudflare API failed.\n  This Worker does not exist on your account. [code: ${code}]`,
  );

test('only wrangler error 10007 is a Worker that Cloudflare does not know yet', () => {
  assert.equal(isWorkerPropagating(wranglerFailure(10007)), true);
  assert.equal(isWorkerPropagating(wranglerFailure(10000)), false);
  assert.equal(isWorkerPropagating(wranglerFailure(10006)), false);
  assert.equal(isWorkerPropagating(new Error('Worker 10007 not found')), false);
});

test('a wrangler step failing with 10007 is run again after each delay, and then succeeds', async () => {
  const slept = [];
  let runs = 0;
  const result = await retryWorkerPropagation(
    () => {
      runs += 1;
      if (runs <= 2) throw wranglerFailure(10007);
      return 'deployed';
    },
    { sleep: (ms) => Promise.resolve(slept.push(ms)) },
  );
  assert.equal(result, 'deployed');
  assert.equal(runs, 3);
  assert.deepEqual(slept, [2_000, 5_000]);
  assert.equal(WORKER_PROPAGATION_DELAYS_MS.reduce((total, ms) => total + ms, 0) <= 60_000, true);
});

test('an async step rejecting with 10007 is run again', async () => {
  let runs = 0;
  const result = await retryWorkerPropagation(
    async () => {
      runs += 1;
      if (runs === 1) throw wranglerFailure(10007);
      return 'deployed';
    },
    { sleep: noSleep },
  );
  assert.equal(result, 'deployed');
  assert.equal(runs, 2);
});

test('the retry stops at the attempt cap and rethrows the step’s own error', async () => {
  let runs = 0;
  const failure = wranglerFailure(10007);
  const thrown = await retryWorkerPropagation(
    () => {
      runs += 1;
      throw failure;
    },
    { sleep: noSleep },
  ).catch((error) => error);
  assert.equal(thrown, failure);
  assert.equal(runs, 1 + WORKER_PROPAGATION_DELAYS_MS.length);
});

test('any other wrangler error is thrown at once, without a retry', async () => {
  let runs = 0;
  const thrown = await retryWorkerPropagation(
    () => {
      runs += 1;
      throw wranglerFailure(10000);
    },
    { sleep: () => assert.fail('must not wait') },
  ).catch((error) => error);
  assert.match(thrown.message, /\[code: 10000\]/u);
  assert.equal(runs, 1);
});

test('the bridge name is unique per run and attempt and always inside the lane prefix', () => {
  const first = bridgeWorkerName({ GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' });
  assert.equal(first, 'agent-workspace-sandbox-bridge-ci-42-1');
  assert.notEqual(first, bridgeWorkerName({ GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' }));
  assert.notEqual(first, bridgeWorkerName({ GITHUB_RUN_ID: '421', GITHUB_RUN_ATTEMPT: '1' }));
  const local = [bridgeWorkerName({}), bridgeWorkerName({})];
  assert.notEqual(local[0], local[1]);
  for (const name of [first, ...local])
    assert.ok(isLaneName(name) && name.length + '-sandboxnone'.length <= 63);
  assert.throws(() => bridgeWorkerName({ GITHUB_RUN_ID: '1;rm' }), /must be digits/u);
  assert.throws(
    () => bridgeWorkerName({ GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1;rm' }),
    /must be digits/u,
  );
});

test('the leftover filter matches the lane prefix only, and a deployment owns only its own names', () => {
  assert.ok(isLaneName(`${BRIDGE_PREFIX}ci-7-1-sandboxnone`));
  assert.ok(isLaneName('agent-workspace-sandbox-bridge-sandboxnone'));
  for (const other of [
    'agent-workspace-sandbox-bridge',
    'agent-workspace-lp',
    'my-agent-workspace-sandbox-bridge-x',
    'awlj-1-web',
    '',
    undefined,
  ]) {
    assert.equal(isLaneName(other), false, String(other));
  }
  const owns = ownedBy('agent-workspace-sandbox-bridge-ci-42-1');
  assert.ok(owns('agent-workspace-sandbox-bridge-ci-42-1'));
  assert.ok(owns('agent-workspace-sandbox-bridge-ci-42-1-sandboxopen'));
  assert.equal(owns('agent-workspace-sandbox-bridge-ci-42-10-sandboxopen'), false);
  assert.equal(owns('agent-workspace-sandbox-bridge-ci-42-2'), false);
});

test('the rendered config carries the per-run name, so the container applications do too', () => {
  const shipped = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../cloudflare/sandbox-bridge/wrangler.jsonc',
    ),
    'utf8',
  );
  const rendered = renderConfig(shipped, {
    image: 'r/i@sha256:' + 'a'.repeat(64),
    gatewayHost: 'gw.example',
    workerName: 'agent-workspace-sandbox-bridge-ci-42-1',
  });
  assert.match(rendered, /"name": "agent-workspace-sandbox-bridge-ci-42-1",/u);
  assert.doesNotMatch(rendered, /REPLACE_[A-Z]|"name": "agent-workspace-sandbox-bridge",/u);
  assert.throws(
    () => renderConfig('{}', { image: 'i', gatewayHost: 'g', workerName: 'w' }),
    /expected name field/u,
  );
});

function fakeCloudflare({ refuse = [], listStatus = 200 } = {}) {
  const calls = [];
  const body = (url) =>
    url.endsWith('/containers/applications')
      ? {
          result: [
            { id: 'a1', name: 'agent-workspace-sandbox-bridge-sandboxnone' },
            { id: 'a2', name: 'agent-workspace-sandbox-bridge-ci-42-1-sandboxopen' },
            { id: 'a3', name: 'unrelated-sandboxnone' },
          ],
        }
      : {
          result: [
            { id: 'agent-workspace-sandbox-bridge-ci-42-1' },
            { id: 'agent-workspace-lp' },
            { id: 'agent-workspace-sandbox-bridge' },
          ],
        };
  const fetch = (url, init) => {
    calls.push(`${init.method} ${url.replace(/^.*\/accounts\/[^/]+\//u, '')}`);
    assert.equal(init.headers.authorization, 'Bearer TOKEN');
    if (init.method === 'GET')
      return Promise.resolve(new Response(JSON.stringify(body(url)), { status: listStatus }));
    if (refuse.some((id) => url.includes(`/${id}`)))
      return Promise.resolve(new Response('SENTINEL_BODY', { status: 403 }));
    return Promise.resolve(new Response('{}', { status: url.includes('/a2') ? 404 : 200 }));
  };
  return { fetch, calls };
}

test('the sweep deletes only this lane’s applications and Workers; a 404 counts as gone', async () => {
  const { fetch, calls } = fakeCloudflare();
  const removed = await deleteBridgeResources({
    accountId: 'acct',
    token: 'TOKEN',
    owns: isLaneName,
    fetch,
  });
  assert.deepEqual(removed, [
    ['container application', 'agent-workspace-sandbox-bridge-sandboxnone'],
    ['container application', 'agent-workspace-sandbox-bridge-ci-42-1-sandboxopen'],
    ['worker', 'agent-workspace-sandbox-bridge-ci-42-1'],
  ]);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('DELETE')),
    [
      'DELETE containers/applications/a1',
      'DELETE containers/applications/a2',
      'DELETE workers/scripts/agent-workspace-sandbox-bridge-ci-42-1?force=true',
    ],
  );
});

test('a refused deletion or unreadable list is a failure naming resources and status, never the body', async () => {
  const refused = await deleteBridgeResources({
    accountId: 'acct',
    token: 'TOKEN',
    owns: ownedBy('agent-workspace-sandbox-bridge-ci-42-1'),
    fetch: fakeCloudflare({ refuse: ['a2', 'agent-workspace-sandbox-bridge-ci-42-1'] }).fetch,
  }).then(
    () => assert.fail('expected a failure'),
    (thrown) => thrown,
  );
  assert.match(
    refused.message,
    /delete container application agent-workspace-sandbox-bridge-ci-42-1-sandboxopen: HTTP 403/u,
  );
  assert.match(refused.message, /delete worker agent-workspace-sandbox-bridge-ci-42-1: HTTP 403/u);
  assert.doesNotMatch(refused.message, /SENTINEL_BODY|TOKEN/u);
  const unreadable = await deleteBridgeResources({
    accountId: 'acct',
    token: 'TOKEN',
    owns: isLaneName,
    fetch: fakeCloudflare({ listStatus: 500 }).fetch,
  }).then(
    () => assert.fail('expected a failure'),
    (thrown) => thrown,
  );
  assert.match(unreadable.message, /list container applications: HTTP 500/u);
});

test('the sweep keeps a young lane name, its own names, an undated entry and other names; it deletes an old lane name', async () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const old = '2026-10-09T07:00:00Z';
  const young = '2026-10-09T11:00:00Z';
  const calls = [];
  const lists = {
    'containers/applications': {
      result: [
        { id: 'a-old', name: `${BRIDGE_PREFIX}ci-1-1-sandboxnone`, created_at: old },
        { id: 'a-young', name: `${BRIDGE_PREFIX}ci-2-1-sandboxnone`, created_at: young },
        { id: 'a-undated', name: `${BRIDGE_PREFIX}ci-3-1-sandboxnone` },
        { id: 'a-bad-date', name: `${BRIDGE_PREFIX}ci-4-1-sandboxnone`, created_at: 'yesterday' },
        { id: 'a-own', name: `${BRIDGE_PREFIX}ci-9-1-sandboxopen`, created_at: old },
        { id: 'a-other', name: 'unrelated-sandboxnone', created_at: old },
      ],
    },
    'workers/scripts': {
      result: [
        { id: `${BRIDGE_PREFIX}ci-1-1`, created_on: old, modified_on: old },
        { id: `${BRIDGE_PREFIX}ci-5-1`, created_on: old, modified_on: young },
        { id: 'agent-workspace-lp', created_on: old, modified_on: old },
      ],
    },
  };
  const fetch = (url, init) => {
    const pathAndQuery = url.replace(/^.*\/accounts\/[^/]+\//u, '');
    calls.push(`${init.method} ${pathAndQuery}`);
    return Promise.resolve(
      new Response(JSON.stringify(init.method === 'GET' ? lists[pathAndQuery] : {}), {
        status: 200,
      }),
    );
  };
  const removed = await deleteBridgeResources({
    accountId: 'acct',
    token: 'TOKEN',
    owns: isLeftover(`${BRIDGE_PREFIX}ci-9-1`, now),
    fetch,
  });
  assert.deepEqual(removed, [
    ['container application', `${BRIDGE_PREFIX}ci-1-1-sandboxnone`],
    ['worker', `${BRIDGE_PREFIX}ci-1-1`],
  ]);
  assert.equal(calls.filter((call) => call.startsWith('DELETE')).length, 2);
});

test('the sweep reads every list page by cursor or page number before deleting', async () => {
  const pages = {
    'containers/applications': {
      result: [{ id: 'a1', name: `${BRIDGE_PREFIX}p1` }],
      result_info: { page: 1, total_pages: 2 },
    },
    'containers/applications?page=2': {
      result: [{ id: 'a2', name: `${BRIDGE_PREFIX}p2` }],
      result_info: { page: 2, total_pages: 2 },
    },
    'workers/scripts': {
      result: [{ id: `${BRIDGE_PREFIX}w1` }],
      result_info: { cursor: 'next one' },
    },
    'workers/scripts?cursor=next%20one': {
      result: [{ id: `${BRIDGE_PREFIX}w2` }],
      result_info: { cursor: '' },
    },
  };
  const calls = [];
  const fetch = (url, init) => {
    const pathAndQuery = url.replace(/^.*\/accounts\/[^/]+\//u, '');
    calls.push(`${init.method} ${pathAndQuery}`);
    return Promise.resolve(
      new Response(JSON.stringify(init.method === 'GET' ? pages[pathAndQuery] : {}), {
        status: 200,
      }),
    );
  };
  const removed = await deleteBridgeResources({
    accountId: 'acct',
    token: 'TOKEN',
    owns: isLaneName,
    fetch,
  });
  assert.deepEqual(
    removed.map(([, name]) => name),
    [`${BRIDGE_PREFIX}p1`, `${BRIDGE_PREFIX}p2`, `${BRIDGE_PREFIX}w1`, `${BRIDGE_PREFIX}w2`],
  );
  assert.deepEqual(calls.slice(0, 2), [
    'GET containers/applications',
    'GET containers/applications?page=2',
  ]);
  const endless = await deleteBridgeResources({
    accountId: 'acct',
    token: 'TOKEN',
    owns: isLaneName,
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify({ result: [], result_info: { cursor: 'again' } }), {
          status: 200,
        }),
      ),
  }).then(
    () => assert.fail('expected a failure'),
    (thrown) => thrown,
  );
  assert.match(endless.message, /list container applications: more than 100 pages/u);
});
