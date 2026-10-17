// R-06 probe — runs the reference Test Connection (`test-connection.mjs`) over the whole
// failure matrix and checks each case against the tag it is supposed to produce. This is the
// evidence that the two errors W2-CP-05's acceptance criterion names — wrong URL vs rejected
// token — really do come out different, on every transport.
//
// Every case carries its EXPECTED tag, so the transcript is a pass/fail report and not a list of
// readings: re-running it on another machine produces a byte-identical file when nothing has
// changed. Nothing measured (elapsed milliseconds, pids) is printed, because a number in a
// committed artefact goes stale the moment it is read — ADR-0016. Where timing is the thing under
// test the probe asserts the budget instead of reporting the reading.
//
// Exit code 0 = every case produced its expected tag; 1 = at least one did not.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { testConnection } from './test-connection.mjs';

const TOKEN = 's3cret';
const HP = 8981;
const SP = 8982;
// A third server, answering `initialize` with a version that is in the client's supported list but
// is not its latest. §6 claims an older *supported* version connects on both stdio and http;
// without a server configured to answer one, that claim is unrun.
const PP = 8983;
const OLDER_SUPPORTED = '2025-06-18';
const node = process.execPath;
const here = process.cwd();

const httpSrv = spawn(node, ['server-http.mjs', '--port', String(HP), '--token', TOKEN], { stdio: 'ignore' });
const sseSrv = spawn(node, ['server-sse.mjs', '--port', String(SP), '--token', TOKEN], { stdio: 'ignore' });
const protoSrv = spawn(
  node,
  ['server-http.mjs', '--port', String(PP), '--token', TOKEN, '--protocol', OLDER_SUPPORTED],
  { stdio: 'ignore' },
);
await sleep(800);

const auth = { Authorization: `Bearer ${TOKEN}` };
const bad = { Authorization: 'Bearer WRONG' };
// A header that is present and is NOT a credential. The case that separates "carries a
// credential" from "carries a header", which is what the 401 split turns on.
const trace = { 'X-Trace-Id': 'r06-probe' };
// A credential under a name no convention knows, declared by the caller — the shape W2-CP-05 has
// after the wizard's "API Key" row, where the user names the header themselves.
const namedKey = { 'X-Company-Key': 'WRONG' };

const cases = [
  ['http · correct url + correct token', { type: 'http', url: `http://127.0.0.1:${HP}/mcp`, headers: auth }, 'ok'],
  ['http · correct url + WRONG token', { type: 'http', url: `http://127.0.0.1:${HP}/mcp`, headers: bad }, 'credential-rejected'],
  ['http · correct url + NO credential', { type: 'http', url: `http://127.0.0.1:${HP}/mcp` }, 'auth-required'],
  // The header/credential distinction, both directions. A connector carrying a trace id and no
  // token must NOT be told its token was refused; a connector carrying a token under a name the
  // caller declared must be.
  ['http · NO credential but one non-auth header', { type: 'http', url: `http://127.0.0.1:${HP}/mcp`, headers: trace }, 'auth-required'],
  [
    'http · credential in a caller-declared header',
    { type: 'http', url: `http://127.0.0.1:${HP}/mcp`, headers: namedKey, credentialFields: ['X-Company-Key'] },
    'credential-rejected',
  ],
  ['http · valid token, forbidden (403)', { type: 'http', url: `http://127.0.0.1:${HP}/forbidden`, headers: auth }, 'credential-insufficient-scope'],
  ['http · WRONG path on a live host', { type: 'http', url: `http://127.0.0.1:${HP}/nope`, headers: auth }, 'endpoint-not-mcp'],
  ['http · WRONG port (nothing listening)', { type: 'http', url: 'http://127.0.0.1:8999/mcp', headers: auth }, 'unreachable'],
  ['http · WRONG host (no such name)', { type: 'http', url: 'https://r06-probe-does-not-exist.invalid/mcp', headers: auth }, 'unreachable'],
  ['http · https:// against a plain http port', { type: 'http', url: `https://127.0.0.1:${HP}/mcp`, headers: auth }, 'tls-error'],
  ['http · server accepts and never answers', { type: 'http', url: `http://127.0.0.1:${HP}/hang`, headers: auth }, 'timeout'],
  ['http · server returns a 500 html page', { type: 'http', url: `http://127.0.0.1:${HP}/500`, headers: auth }, 'server-error'],
  ['http · url is really an SSE endpoint', { type: 'http', url: `http://127.0.0.1:${SP}/sse`, headers: auth }, 'endpoint-not-mcp'],
  ['http · server answers an older supported version', { type: 'http', url: `http://127.0.0.1:${PP}/mcp`, headers: auth }, 'ok'],

  ['sse  · correct url + correct token', { type: 'sse', url: `http://127.0.0.1:${SP}/sse`, headers: auth }, 'ok'],
  ['sse  · correct url + WRONG token', { type: 'sse', url: `http://127.0.0.1:${SP}/sse`, headers: bad }, 'credential-rejected'],
  ['sse  · correct url + NO credential', { type: 'sse', url: `http://127.0.0.1:${SP}/sse` }, 'auth-required'],
  ['sse  · WRONG path on a live host', { type: 'sse', url: `http://127.0.0.1:${SP}/nope`, headers: auth }, 'endpoint-not-mcp'],
  ['sse  · WRONG port (nothing listening)', { type: 'sse', url: 'http://127.0.0.1:8999/sse', headers: auth }, 'unreachable'],
  ['sse  · url is really a streamable-http endpoint', { type: 'sse', url: `http://127.0.0.1:${HP}/mcp`, headers: auth }, 'endpoint-not-mcp'],
  // The two shapes the SDK's per-request timeout cannot bound, because `SSEClientTransport.start()`
  // settles only on an error or an `endpoint` event and `Protocol.connect()` awaits it before
  // issuing the timed `initialize`. Before `test-connection.mjs` grew its own wall-clock deadline
  // these two did not time out — they never returned at all.
  ['sse  · server accepts and never writes', { type: 'sse', url: `http://127.0.0.1:${SP}/sse-blackhole`, headers: auth }, 'timeout'],
  ['sse  · stream opens, no endpoint event', { type: 'sse', url: `http://127.0.0.1:${SP}/sse-no-endpoint`, headers: auth }, 'timeout'],

  ['stdio· correct command, no credential needed', { command: node, args: [`${here}/server-stdio.mjs`, '--mode', 'ok'] }, 'ok'],
  // `env` carries the CONNECTOR's overlay only — the runner's environment goes in `baseEnv`, which
  // defaults to `process.env`. Folding the two together at the call site is the mistake that made
  // every stdio connector look credentialled. The three cases below are the guard: two declare
  // `MCP_TOKEN` as the credential and must split on whether it is right, and the third carries an
  // environment variable that is NOT a credential and must not be read as one.
  [
    'stdio· correct command + correct env credential',
    { command: node, args: [`${here}/server-stdio.mjs`, '--mode', 'ok', '--require-env', `MCP_TOKEN=${TOKEN}`], env: { MCP_TOKEN: TOKEN }, credentialFields: ['MCP_TOKEN'] }, 'ok',
  ],
  [
    'stdio· correct command + WRONG env credential',
    { command: node, args: [`${here}/server-stdio.mjs`, '--mode', 'ok', '--require-env', `MCP_TOKEN=${TOKEN}`], env: { MCP_TOKEN: 'WRONG' }, credentialFields: ['MCP_TOKEN'] }, 'credential-rejected',
  ],
  // No credential was configured, but the connector does carry environment variables. The server
  // refuses; the user must be told to supply a credential, not that theirs was rejected.
  [
    'stdio· refused, env present but no credential',
    { command: node, args: [`${here}/server-stdio.mjs`, '--mode', 'ok', '--require-env', `MCP_TOKEN=${TOKEN}`], env: { LANG: 'C' } }, 'server-refused',
  ],
  ['stdio· command does not exist', { command: 'r06-no-such-binary', args: [] }, 'command-not-found|process-died'],
  ['stdio· command exits immediately with a message', { command: node, args: [`${here}/server-stdio.mjs`, '--mode', 'exit'] }, 'process-died'],
  ['stdio· command starts and never answers', { command: node, args: [`${here}/server-stdio.mjs`, '--mode', 'hang'] }, 'timeout'],
  ['stdio· answers JSON-RPC but is not an MCP server', { command: node, args: [`${here}/server-stdio.mjs`, '--mode', 'not-mcp'] }, 'endpoint-not-mcp'],
  ['stdio· server speaks an unknown protocol version', { command: node, args: [`${here}/server-stdio.mjs`, '--mode', 'ok', '--protocol', '1999-01-01'] }, 'protocol-version-unsupported'],
  ['stdio· server speaks an older supported version', { command: node, args: [`${here}/server-stdio.mjs`, '--mode', 'ok', '--protocol', '2024-11-05'] }, 'ok'],
  ['stdio· server speaks the previous revision', { command: node, args: [`${here}/server-stdio.mjs`, '--mode', 'ok', '--protocol', OLDER_SUPPORTED] }, 'ok'],
];

const BUDGET_MS = 4000;
// The ceiling every case must return inside. It is deliberately loose, and its looseness is the
// point: it is not measuring how long anything takes — a tight bound would make this transcript
// machine-dependent, and ADR-0016 forbids a measurement in a committed artefact anyway. Its job is
// to turn "this case never returned" into a FAIL row carrying a name, instead of a run somebody has
// to kill. That is what the two `sse` hang rows produced before `test-connection.mjs` enforced its
// own wall clock, and it is the failure this file could not previously report.
const CEILING_MS = BUDGET_MS * 3;
// Node schedules timers against libuv's cached monotonic loop time while `Date.now()` here reads
// the wall clock, so a deadline set for exactly `BUDGET_MS` is sometimes observed as a millisecond
// short of it — which failed this transcript's byte-for-byte reproduction on one container run.
// The allowance is for that skew and for nothing else. A case tagged `timeout` because something
// else failed and was mislabelled returns in a few milliseconds, far below the floor this leaves.
const CLOCK_SKEW_MS = 25;
/**
 * The tag a case gets when `testConnection` did not return at all.
 *
 * ADR-0015 inside the instrument: a check that cannot run must fail, and a probe that hangs is not
 * a failing probe — it is a probe with no verdict, which is what the `sse` hang cases produced
 * before this round. Racing every case against the ceiling turns "never returned" into a named
 * FAIL row that a reader can see, instead of a run that has to be killed.
 */
const DID_NOT_RETURN = 'did-not-return';

async function runCase(cfg) {
  let watchdog;
  const timeout = new Promise((resolve) => {
    watchdog = setTimeout(
      () => resolve({ ok: false, kind: DID_NOT_RETURN, message: `testConnection() had not returned by the ${CEILING_MS} ms ceiling.` }),
      CEILING_MS,
    );
    watchdog.unref?.();
  });
  try {
    return await Promise.race([testConnection(cfg, { timeoutMs: BUDGET_MS }), timeout]);
  } finally {
    clearTimeout(watchdog);
  }
}

const rows = [];
for (const [label, cfg, expected] of cases) {
  const t0 = Date.now();
  const r = await runCase(cfg);
  const elapsed = Date.now() - t0;
  // Positive assertion on both halves: the tag must be one the case declared, AND the case must
  // have taken the time its tag implies. A case that is supposed to time out must actually have
  // waited (a `timeout` returned instantly would mean something else failed and was mislabelled);
  // every other case must have finished inside the budget; and EVERY case must have returned
  // inside the ceiling, because "the probe returns" is itself under test here.
  const tagOk = expected.split('|').includes(r.kind);
  const startedInTime =
    expected === 'timeout' ? elapsed >= BUDGET_MS - CLOCK_SKEW_MS : elapsed < BUDGET_MS;
  const timingOk = startedInTime && elapsed < CEILING_MS;
  rows.push({ label, kind: r.kind, expected, ok: r.ok, pass: tagOk && timingOk, message: r.message });
}

httpSrv.kill();
sseSrv.kill();
protoSrv.kill();

const pad = Math.max(...rows.map((r) => r.label.length));
for (const r of rows) {
  const verdict = r.pass ? 'pass' : `FAIL (expected ${r.expected})`;
  console.log(`${r.label.padEnd(pad)}  ${(r.ok ? 'OK' : '--').padEnd(2)}  ${r.kind.padEnd(30)} ${verdict}`);
  console.log(`${' '.repeat(pad)}      "${r.message}"`);
}
const failed = rows.filter((r) => !r.pass);
console.log(`
${rows.length - failed.length}/${rows.length} cases produced their expected tag, honoured the ${BUDGET_MS} ms budget, and returned inside the ${CEILING_MS} ms ceiling.`);
process.exit(failed.length === 0 ? 0 : 1);
