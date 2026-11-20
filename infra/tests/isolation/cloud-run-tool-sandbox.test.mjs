import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  evaluateAppHealth,
  evaluateGatewayDenied,
  evaluateProbes,
  evaluateToolCall,
  evaluateToolMetadata,
  parseToolAnswer,
  toolOpenRequest,
  toolProbeBundle,
  toolTargetsFromEnv,
  TOOL_NAME,
  managerFailure,
} from './cloud-run-lane.mjs';
import { createHash } from 'node:crypto';
import { renderSummary } from './summary.mjs';
import { base, refused, reset, silent } from './cloud-run-lane.test-support.mjs';

// ---- App reachability and the tool sandbox lane ----------------------------------------------

test('an app run.app URL is judged like the gateway one: any HTTP answer fails with SECURITY, silence passes', () => {
  const withApp = (appRunApp, appRunAppViaVip = silent) => ({
    ...base(),
    appRunApp,
    appRunAppViaVip,
  });
  const passing = evaluateProbes(withApp(silent));
  assert.equal(passing['egress-app-run-app'].title, 'A none sandbox cannot reach an app service');
  assert.equal(passing['egress-app-run-app'].outcome, 'pass');
  for (const attempt of [{ status: 200 }, { status: 404 }, { status: 403 }, refused, reset]) {
    const app = evaluateProbes(withApp(attempt))['egress-app-run-app'];
    assert.equal(app.outcome, 'fail', JSON.stringify(attempt));
    assert.ok(app.detail.startsWith('SECURITY:'));
  }
  const dns = { connected: false, code: 'ENOTFOUND', error: 'getaddrinfo ENOTFOUND app.run.app' };
  assert.equal(evaluateProbes(withApp(dns))['egress-app-run-app'].outcome, 'pass');
  assert.equal(
    evaluateProbes(withApp(dns, { status: 200 }))['egress-app-run-app'].outcome,
    'inconclusive',
  );
  // Without an app configured there is no such result, and a failed control blinds it.
  assert.equal('egress-app-run-app' in evaluateProbes(base()), false);
  assert.equal(
    evaluateProbes({ ...withApp(silent), gateway: { status: 404 } })['egress-app-run-app'].outcome,
    'inconclusive',
  );
});

test('the app health control passes only on a 200', () => {
  assert.equal(evaluateAppHealth({ status: 200 }).outcome, 'pass');
  for (const attempt of [{ status: 503 }, { status: 404 }, silent]) {
    assert.equal(evaluateAppHealth(attempt).outcome, 'fail');
  }
});

const probeOutput = (over = {}) => {
  const { privateControl: _control, ...attempts } = {
    ...base(),
    appRunApp: silent,
    appRunAppViaVip: silent,
    ...over,
  };
  return attempts;
};
const silentApi = { api: silent, iam: silent };
const toolAnswer = (output, status = 200) => ({
  status,
  text: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(output) }] },
  }),
});
const silentOutput = () =>
  toolAnswer({ attempts: probeOutput(), metadata: { tokenStatus: 200, attempts: silentApi } });

test('a tool sandbox that reaches nothing passes every tool result, from JSON or from SSE', () => {
  for (const response of [
    silentOutput(),
    { status: 200, text: `event: message\ndata: ${silentOutput().text}\n\n` },
  ]) {
    const results = evaluateToolCall(response, true);
    assert.deepEqual(Object.keys(results).sort(), [
      'tool-call',
      'tool-egress-app-run-app',
      'tool-egress-gateway-run-app',
      'tool-egress-google-vip',
      'tool-egress-internet',
      'tool-egress-private',
      'tool-gateway-reachable',
      'tool-metadata-token',
    ]);
    for (const { outcome } of Object.values(results)) assert.equal(outcome, 'pass');
  }
});

test('any HTTP answer from a target fails the tool results with SECURITY', () => {
  const cases = {
    'tool-egress-internet': { internet: { 'TCP 443 to 192.0.2.1': { connected: true } } },
    'tool-egress-private': { private: { 'TCP 5432 to 10.0.0.5': { connected: true } } },
    'tool-egress-google-vip': {
      googleVip: { 'TCP 80 to private.googleapis.com (199.36.153.8)': { status: 200 } },
    },
    'tool-egress-gateway-run-app': { gatewayRunApp: { status: 200 } },
    'tool-egress-app-run-app': { appRunApp: { status: 200 } },
  };
  for (const [key, over] of Object.entries(cases)) {
    const results = evaluateToolCall(
      toolAnswer({ attempts: probeOutput(over), metadata: { attempts: silentApi } }),
      true,
    );
    assert.equal(results[key].outcome, 'fail', key);
    assert.ok(results[key].detail.startsWith('SECURITY:'), key);
  }
});

test('the tool token passes on silence or on a 403, and fails when the API answers or grants anything', () => {
  assert.equal(evaluateToolMetadata({ attempts: silentApi }).outcome, 'pass');
  const refusedOk = {
    apiStatus: 403,
    iam: { status: 200, granted: [] },
    attempts: { api: { status: 403 }, iam: { status: 200 } },
  };
  assert.equal(evaluateToolMetadata(refusedOk).outcome, 'pass');
  const accepted = {
    apiStatus: 200,
    iam: { status: 200, granted: [] },
    attempts: { api: { status: 200 }, iam: { status: 200 } },
  };
  assert.equal(evaluateToolMetadata(accepted).outcome, 'fail');
  const granted = {
    iam: { status: 200, granted: ['run.services.list'] },
    attempts: { api: silent, iam: { status: 200 } },
  };
  assert.equal(evaluateToolMetadata(granted).outcome, 'fail');
  assert.equal(evaluateToolMetadata({ tokenStatus: 404 }).outcome, 'inconclusive');
  assert.equal(evaluateToolMetadata(undefined).outcome, 'inconclusive');
});

// Run 42577620759: tool-call sent no project, so the tool never tried its token ("no metadata token
// probe ran"). The targets now always carry it, and the tool's token is judged from its answer.
test('tool-call always hands the tool the project and region, and refuses to run without them', () => {
  const env = {
    ISOLATION_INTERNET_URL: 'http://example.test/',
    ISOLATION_INTERNET_ADDRESS: '192.0.2.1',
    ISOLATION_PRIVATE_ADDRESS: '10.0.0.5',
    ISOLATION_GATEWAY_URL: 'http://10.0.0.9',
    ISOLATION_GATEWAY_RUN_APP_URL: 'https://gateway.example.test',
  };
  const targets = toolTargetsFromEnv({
    ...env,
    GCP_PROJECT: 'example-project',
    GCP_REGION: 'example-region1',
  });
  assert.equal(targets.project, 'example-project');
  assert.equal(targets.region, 'example-region1');
  assert.throws(() => toolTargetsFromEnv(env), /GCP_PROJECT is required/u);
  assert.throws(
    () => toolTargetsFromEnv({ ...env, GCP_PROJECT: 'example-project' }),
    /GCP_REGION is required/u,
  );
});

test("the tool sandbox's token passes only on proof, fails when usable, and is inconclusive when not tried", () => {
  const judge = (metadata) =>
    evaluateToolCall(toolAnswer({ attempts: probeOutput(), metadata }), true)[
      'tool-metadata-token'
    ];
  const unreachable = judge({ tokenStatus: 200, apiStatus: undefined, attempts: silentApi });
  assert.equal(unreachable.outcome, 'pass');
  assert.match(unreachable.detail, /no route to a Google API/u);
  const refusedEverywhere = judge({
    tokenStatus: 200,
    apiStatus: 403,
    iam: { status: 200, granted: [] },
    attempts: { api: { status: 403 }, iam: { status: 200 } },
  });
  assert.equal(refusedEverywhere.outcome, 'pass');
  const usable = judge({
    tokenStatus: 200,
    apiStatus: 200,
    iam: { status: 200, granted: [] },
    attempts: { api: { status: 200 }, iam: { status: 200 } },
  });
  assert.equal(usable.outcome, 'fail');
  const granting = judge({
    tokenStatus: 200,
    apiStatus: 403,
    iam: { status: 200, granted: ['run.services.create'] },
    attempts: { api: { status: 403 }, iam: { status: 200 } },
  });
  assert.equal(granting.outcome, 'fail');
  assert.match(granting.detail, /run\.services\.create/u);
  // The token server refused, or the probe never ran: nothing is proven.
  assert.equal(judge({ tokenStatus: 403 }).outcome, 'inconclusive');
  assert.equal(judge({ error: 'fetch failed' }).outcome, 'inconclusive');
  assert.equal(judge(undefined).outcome, 'inconclusive');
  // A silent Cloud Run API with an answering testIamPermissions is judged on the answer, not passed.
  assert.notEqual(
    judge({
      tokenStatus: 200,
      iam: { status: 200, granted: undefined },
      attempts: { api: silent, iam: { status: 200 } },
    }).outcome,
    'pass',
  );
});

test('the tool probe tries its metadata token whenever it is given a project', () => {
  const bundle = toolProbeBundle();
  assert.match(
    bundle,
    /targets\.project === undefined \? undefined : collectMetadata\(targets\.project, targets\.region\)/u,
  );
});

test('a failed gateway control in the tool sandbox is a fail, and every security result is inconclusive', () => {
  const results = evaluateToolCall(
    toolAnswer({
      attempts: probeOutput({ gateway: { status: 404 } }),
      metadata: { attempts: silentApi },
    }),
    true,
  );
  assert.equal(results['tool-gateway-reachable'].outcome, 'fail');
  for (const [key, value] of Object.entries(results)) {
    if (key !== 'tool-gateway-reachable' && key !== 'tool-call')
      assert.equal(value.outcome, 'inconclusive', key);
  }
  assert.equal(renderSummary({ tool: results }).clean, false);
});

test('a tool call that returns no probe output fails tool-call and proves nothing else', () => {
  const bad = [
    { status: 503, text: '{"error":"tool_host_not_ready"}' },
    { status: 401, text: '' },
    { error: 'timed out' },
    { status: 200, text: 'not json' },
    {
      status: 200,
      text: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } }),
    },
    {
      status: 200,
      text: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { isError: true, content: [{ type: 'text', text: 'boom' }] },
      }),
    },
    toolAnswer({ unexpected: true }),
  ];
  for (const response of bad) {
    const results = evaluateToolCall(response, true);
    assert.equal(results['tool-call'].outcome, 'fail', JSON.stringify(response));
    for (const [key, value] of Object.entries(results)) {
      if (key !== 'tool-call') assert.equal(value.outcome, 'inconclusive', key);
    }
  }
  assert.match(evaluateToolCall(bad[0], true)['tool-call'].detail, /503.*tool_host_not_ready/u);
});

test('the tool private range is inconclusive when the positive control failed', () => {
  assert.equal(
    evaluateToolCall(silentOutput(), false)['tool-egress-private'].outcome,
    'inconclusive',
  );
});

test('parseToolAnswer reads JSON and the data line of an SSE stream', () => {
  assert.deepEqual(parseToolAnswer('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolAnswer('event: message\ndata: {"a":2}\n\n'), { a: 2 });
  assert.equal(parseToolAnswer('nothing'), undefined);
  assert.equal(parseToolAnswer(undefined), undefined);
});

test('the gateway identity must get 403 from an agent sandbox; any other answer fails with SECURITY', () => {
  const through = { status: 200 };
  assert.equal(evaluateGatewayDenied({ status: 403 }, through).outcome, 'pass');
  assert.equal(evaluateGatewayDenied({ status: 403 }, { status: 401 }).outcome, 'pass');
  for (const status of [200, 204, 302, 401, 404, 500]) {
    for (const control of [through, { status: 403 }, { error: 'timed out' }]) {
      const verdict = evaluateGatewayDenied({ status }, control);
      assert.equal(verdict.outcome, 'fail', String(status));
      assert.ok(verdict.detail.startsWith('SECURITY:'));
    }
  }
  assert.equal(evaluateGatewayDenied({ error: 'timed out' }, through).outcome, 'inconclusive');
});

test('a 403 from the agent sandbox proves nothing when the tool sandbox refused the same identity', () => {
  // Live run 42525921402: both answered 403, so the gateway reached no sandbox at all.
  const refused = evaluateGatewayDenied({ status: 403 }, { status: 403 });
  assert.equal(refused.outcome, 'inconclusive');
  assert.match(refused.detail, /tool sandbox answered 403 too/u);
  assert.equal(
    evaluateGatewayDenied({ status: 403 }, { error: 'timed out' }).outcome,
    'inconclusive',
  );
});

test("a bare 403 from the tool sandbox is named as Cloud Run's refusal, a JSON one by its reason", () => {
  const bare = evaluateToolCall({ status: 403, text: '<html>Error: Forbidden</html>' }, true)[
    'tool-call'
  ];
  assert.equal(bare.outcome, 'fail');
  assert.match(bare.detail, /^POST \/mcp answered 403 \(by Cloud Run, before the container/u);
  const json = evaluateToolCall({ status: 403, text: '{"error":"origin_not_allowed"}' }, true)[
    'tool-call'
  ];
  assert.equal(json.detail, 'POST /mcp answered 403 (origin_not_allowed)');
});

test('tool-probe.mjs exports the run function the tool host expects and the bundle is one self-contained module', async () => {
  const { default: run } = await import('./tool-probe.mjs');
  assert.equal(typeof run, 'function');
  const bundle = toolProbeBundle();
  assert.doesNotMatch(bundle, /from '\.\//u);
  assert.doesNotMatch(bundle, /^export (?!default)/mu);
  // Loaded in a child process through a static import: the bundle is one ES module, and a
  // computed import() here is what the module-boundary gates cannot decide.
  const directory = mkdtempSync(path.join(tmpdir(), 'tool-probe-'));
  try {
    writeFileSync(path.join(directory, 'bundle.mjs'), bundle);
    writeFileSync(
      path.join(directory, 'check.mjs'),
      "import run from './bundle.mjs';\nprocess.stdout.write(JSON.stringify([typeof run, run.length]));\n",
    );
    const printed = execFileSync(process.execPath, [path.join(directory, 'check.mjs')], {
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(printed), ['function', 1]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the tool-open request is a valid manifest whose digest is the bundle sha256 and holds the one probe tool', () => {
  const request = toolOpenRequest({
    id: 'abc123',
    runId: 'run-abc123',
    token: 'tok-0123456789abcdef',
  });
  assert.equal(request.workspaceId, 'aw-iso-abc123');
  assert.equal(request.clientId, 'aw-iso-abc123-tool');
  assert.deepEqual(request.toolSandbox.run, { runId: 'run-abc123', token: 'tok-0123456789abcdef' });
  // The field names of ToolSandboxManifestSchema (packages/contracts), checked by hand: this suite
  // runs without the workspace installed.
  const { manifest } = request.toolSandbox;
  assert.deepEqual(Object.keys(manifest).sort(), ['env', 'stdioServers', 'tools']);
  assert.deepEqual(request.toolSandbox.allowedDomains, []);
  assert.equal(manifest.tools.length, 1);
  const [tool] = manifest.tools;
  assert.deepEqual(Object.keys(tool).sort(), [
    'bundleBase64',
    'description',
    'digest',
    'inputSchema',
    'name',
    'timeoutMs',
  ]);
  assert.match(tool.name, /^[A-Za-z0-9_-]{1,41}$/u);
  assert.match(tool.digest, /^[0-9a-f]{64}$/u);
  assert.equal(tool.name, TOOL_NAME);
  assert.deepEqual(manifest.env, {});
  assert.deepEqual(manifest.stdioServers, []);
  assert.equal(
    tool.digest,
    createHash('sha256').update(Buffer.from(tool.bundleBase64, 'base64')).digest('hex'),
  );
});

test('managerFailure names the manager error code and reason, and only the status without a JSON answer', () => {
  assert.equal(
    managerFailure(
      'POST',
      '/tool-sandboxes',
      503,
      JSON.stringify({
        error: 'tool_sandbox_unavailable',
        message: 'the tool sandbox could not be prepared',
      }),
    ),
    'runner manager POST /tool-sandboxes answered 503 (tool_sandbox_unavailable: the tool sandbox could not be prepared)',
  );
  assert.equal(
    managerFailure('POST', '/tool-sandboxes', 503, 'upstream connect error'),
    'runner manager POST /tool-sandboxes answered 503',
  );
  assert.equal(
    managerFailure('POST', '/runtimes', 500, JSON.stringify({ error: 'internal_error' })),
    'runner manager POST /runtimes answered 500 (internal_error)',
  );
  assert.equal(
    managerFailure('POST', '/x', 503, JSON.stringify({ message: 'm'.repeat(400) })).length,
    'runner manager POST /x answered 503 ()'.length + 300,
  );
});
