// The W1-CP-04 acceptance run.
//
//   ACCEPT: a ten-minute SSE stream survives an nginx proxy without buffering, and a client
//           reconnect replays from Last-Event-ID.
//
// What this script actually does, in order:
//
//   1. starts `fake-runner.mjs`, a §14.3-shaped runtime;
//   2. mints one session token with the real signing function from `../../auth/session.ts`
//      (SESSION_SECRET must be set in the environment this script runs in — see the ACCEPT
//      command in `apps/web/server/runs/acceptance/README.md`) — see
//      `docs/adr/W1-CP-04b-the-acceptance-harness-authenticates-with-a-real-signed-cookie.md`;
//   3. saves whatever is at `apps/web/instrumentation.ts` (a real committed composition root, a
//      concurrent session's uncommitted work, or nothing) and writes a one-line replacement that
//      re-exports `register` from `acceptance/instrumentation.ts`, because the committed
//      composition root is not this task's fixture and does not authenticate every request the
//      way the harness needs. The original bytes are restored in the `finally` below;
//   4. runs `next build` and `next start -p 3111 --keepAliveTimeout 70000` — a production build,
//      never `next dev`, because a stream verified against a dev server proves nothing;
//   5. starts `nginx:1.29-alpine` in Docker with `nginx.conf` beside this file;
//   6. drives a real run through nginx, with the minted cookie and a matching `Origin` on every
//      request: POST the run, stream the events, disconnect on purpose, reconnect with
//      `Last-Event-ID`, and keep reading past ten minutes;
//   7. prints a transcript and exits non-zero if any assertion fails.
//
// Usage:  node run-acceptance.mjs [--no-build] [--location stock|tuned] [--seconds 640]

/* global console, process, fetch, AbortController, TextDecoder, setTimeout */
// The root ESLint config declares no environment globals; scripts/*.mjs use the same mechanism.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The real signing function, not a reimplementation of it: W1-CP-06's global auth middleware
// (`apps/web/middleware.ts`) denies every `/api/**` request with no validly-signed session
// cookie, and it verifies with `verifySessionToken` from this exact module. A probe that minted
// its own token format, or its own HMAC, could pass against a bug the two implementations happen
// to share. Importing the module directly is possible because Node 24 strips TypeScript types
// natively and `session.ts` imports nothing — see
// docs/adr/W1-CP-06-auth-modules-are-standalone-es-modules.md.
import {
  sessionCookieName,
  mintSessionToken,
  newSessionClaims,
  readSessionSecret,
} from '../../auth/session.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../../..'); // apps/web
const repoRoot = resolve(webRoot, '../..');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const WEB_PORT = Number(value('--web-port', '3111'));
const RUNNER_PORT = Number(value('--runner-port', '3112'));
const NGINX_PORT = Number(value('--nginx-port', '8099'));
// `--location stock|tuned`, deliberately NOT `--path /stock/`. Git Bash on Windows rewrites an
// argument that looks like an absolute POSIX path, and it silently turned `/stock/` into
// `C:/Program Files/Git/stock/` — which cost this task two ten-minute runs that failed at the
// nginx readiness check for a reason the error message did not name. A flag with no leading slash
// cannot be mangled.
const LOCATIONS = ['stock', 'tuned'];
const LOCATION = value('--location', 'stock');
if (!LOCATIONS.includes(LOCATION)) {
  console.error(
    `--location must be one of ${LOCATIONS.join(', ')}; got ${JSON.stringify(LOCATION)}`,
  );
  process.exit(2);
}
const PROXY_PATH = `/${LOCATION}/`;
const TOTAL_SECONDS = Number(value('--seconds', '640'));
const DENSE_SECONDS = Number(value('--dense', '30'));
const SPARSE_SECONDS = Number(value('--sparse', '30'));
const DISCONNECT_AT = Number(value('--disconnect-at', '45'));
const CONTAINER = 'aw-w1cp04-nginx';
const NONCE = `w1cp04-${String(Date.now())}`;

const AGENT_ID = 'a0000000-0000-4000-8000-000000000002';

const base = `http://127.0.0.1:${String(NGINX_PORT)}${PROXY_PATH.replace(/\/$/, '')}`;
const WEB_ORIGIN = `http://127.0.0.1:${String(WEB_PORT)}`;
// NOT `http://127.0.0.1:${NGINX_PORT}`. Measured, not assumed: `nginx.conf`'s two locations both
// forward `Host $host`, and nginx's `$host` variable is defined to exclude the port even when the
// client's `Host` header carries one — the app never sees `:8099` from either location. A request
// through nginx with `Origin: http://127.0.0.1:8099` is refused 403 (`server/auth/origin.ts`
// compares host only, and "127.0.0.1:8099" is in neither `nextUrl.host` nor the forwarded `Host`).
// This is the deployment shape `origin.ts`'s own module comment names as the reason the check is
// host-only rather than full-origin — a TLS-terminating proxy where the public port and the
// upstream's port differ — reproduced here by nginx's own default port-stripping rather than by
// TLS termination. The genuinely matching Origin is therefore the port-less host.
const NGINX_ORIGIN = 'http://127.0.0.1';

const log = (...parts) => {
  console.log(`[${new Date().toISOString()}]`, ...parts);
};

// ── auth: mint a validly-signed session cookie, once, for every fetch() below ──────────────
//
// W1-CP-06's global middleware denies every `/api/**` request that carries no session cookie
// verifying under `SESSION_SECRET`, and denies every unsafe-method request whose `Origin` host
// does not match the request's own host (spec-referenced in `server/auth/origin.ts`). Both are
// positive assertions the middleware requires — not the absence of a check — so the harness must
// supply both, on every request, rather than lean on one endpoint's leniency.
const sessionSecret = readSessionSecret(process.env);
if (!sessionSecret.ok) {
  console.error(`ACCEPTANCE ABORTED: ${sessionSecret.reason}`);
  process.exit(2);
}
const sessionToken = await mintSessionToken(
  newSessionClaims('acceptance-harness@w1-cp04b.test', 'w1-cp04b-acceptance'),
  sessionSecret.secret,
);
const sessionCookieHeader = `${sessionCookieName()}=${sessionToken}`;

/** Cookie + a same-host Origin, for a request addressed to `origin` (e.g. `WEB_ORIGIN`). */
function authHeaders(origin, extra) {
  return { Cookie: sessionCookieHeader, Origin: origin, ...extra };
}

const failures = [];
function check(ok, description, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${description}${detail === undefined ? '' : ` — ${detail}`}`;
  console.log(line);
  if (!ok) failures.push(description);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── process helpers ────────────────────────────────────────────────────────────────────

const children = [];
function start(command, argv, options) {
  const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  children.push(child);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const tag = options?.tag ?? command;
  child.stdout.on('data', (d) => process.stdout.write(`  [${tag}] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`  [${tag}!] ${d}`));
  return child;
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function run(command, argv, options) {
  return new Promise((resolvePromise, reject) => {
    const child = start(command, argv, options);
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${String(code)}`)),
    );
  });
}

async function waitFor(description, probe, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      if (await probe()) return;
      lastError = 'the probe returned false';
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
    }
    if (Date.now() > deadline) {
      // Say WHY. A bare "timed out" turns a diagnosable failure into a guess, and this script
      // spent two ten-minute runs proving that.
      throw new Error(
        `timed out waiting for ${description}: ${lastError ?? 'the probe never reported why'}`,
      );
    }
    await sleep(500);
  }
}

/** Run a command and return its exit code and combined output. */
function captureExit(command, argv) {
  return new Promise((resolvePromise) => {
    let out = '';
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolvePromise({ code, out: out.trim() }));
    child.on('error', (cause) => resolvePromise({ code: -1, out: cause.message }));
  });
}

/** The same, when only the output matters. */
async function capture(command, argv) {
  return (await captureExit(command, argv)).out;
}

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Choose the `--add-host aw-host:<value>` a bridge-network container can actually reach this host
 * on, by TRYING each candidate from inside a throwaway container of the same image.
 *
 * Neither candidate is reliable on its own, and both failed here at least once:
 *
 *   * `host-gateway` is the documented spelling. On this Docker Desktop host it resolves to an
 *     IPv6 address, and R-13 records a probe that produced a false positive from exactly that
 *     ("host.docker.internal resolving to an unreachable IPv6 address").
 *   * the bridge network's own IPv4 gateway is the obvious fix for that, and on this host nginx
 *     answered 502 through it - the Docker VM's bridge gateway is not the Windows host.
 *
 * So the address is neither guessed nor defaulted: the probe proceeds because a candidate
 * POSITIVELY fetched a page from the upstream, or it stops and reports that every candidate failed.
 */
async function pickHostAlias(webPort) {
  const bridge = await capture('docker', [
    'network',
    'inspect',
    'bridge',
    '-f',
    '{{range .IPAM.Config}}{{.Gateway}} {{end}}',
  ]);
  const candidates = ['host-gateway', ...bridge.split(/\s+/).filter((t) => IPV4.test(t))];
  const tried = [];
  for (const candidate of candidates) {
    const probe = await captureExit('docker', [
      'run',
      '--rm',
      '--add-host',
      `aw-host:${candidate}`,
      '--entrypoint',
      'wget',
      'nginx:1.29-alpine',
      '-q',
      '-T',
      '4',
      '-O',
      '/dev/null',
      `http://aw-host:${String(webPort)}/`,
    ]);
    if (probe.code === 0) return candidate;
    tried.push(`${candidate} (exit ${String(probe.code)}${probe.out ? `: ${probe.out}` : ''})`);
  }
  throw new Error(
    `no container-to-host address worked for port ${String(webPort)}. Tried: ${tried.join('; ')}`,
  );
}

// ── an SSE client, written here rather than imported ───────────────────────────────────
//
// Deliberately independent of `apps/web/server/runs/relay.ts`: a probe that reuses the server's
// own parser cannot detect a bug the two share. It reads the same HTML §9.2 rules and it sends
// `Last-Event-ID` exactly as a browser does on an automatic reconnect.

async function stream({ url, lastEventId, stopAfterMs, onEvent }) {
  const controller = new AbortController();
  const headers = authHeaders(NGINX_ORIGIN, { Accept: 'text/event-stream' });
  if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;

  const requestedAt = Date.now();
  const response = await fetch(url, { headers, signal: controller.signal });
  const headersAt = Date.now();

  const record = {
    status: response.status,
    contentType: response.headers.get('content-type'),
    contentEncoding: response.headers.get('content-encoding'),
    transferEncoding: response.headers.get('transfer-encoding'),
    xAccelBuffering: response.headers.get('x-accel-buffering'),
    ttfbMs: headersAt - requestedAt,
    chunks: 0,
    maxGapMs: 0,
    events: [],
    controlFrames: [],
    comments: 0,
    lastEventId,
    clean: false,
    error: null,
  };
  if (response.status !== 200 || response.body === null) {
    record.error = `status ${String(response.status)}`;
    return record;
  }

  const stopAt = stopAfterMs === undefined ? Infinity : Date.now() + stopAfterMs;
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let previousChunkAt = headersAt;
  let event = null;
  let data = null;
  // Two different things, and conflating them cost this probe a false pass. HTML §9.2 keeps the
  // *last event id* across frames, so `lastEventId` persists; but whether THIS frame carried an
  // `id:` field is what separates a durable event from a control frame, and that must be reset
  // for every frame.
  let frameId = null;

  const dispatch = () => {
    if (data === null) {
      event = null;
      frameId = null;
      return;
    }
    const payload = data;
    const name = event;
    const id = frameId;
    event = null;
    data = null;
    frameId = null;
    if (id === null) record.controlFrames.push({ event: name, data: payload });
    else {
      record.events.push({ id, event: name, data: payload });
      record.lastEventId = id;
    }
    onEvent?.({ id, event: name, data: payload });
  };

  try {
    for (;;) {
      const readPromise = reader.read();
      const remaining = stopAt - Date.now();
      const timed =
        remaining === Infinity
          ? readPromise
          : Promise.race([readPromise, sleep(Math.max(remaining, 0)).then(() => 'DEADLINE')]);
      const result = await timed;
      if (result === 'DEADLINE') {
        record.clean = true;
        controller.abort();
        break;
      }
      if (result.done) {
        record.clean = true;
        break;
      }
      const now = Date.now();
      record.maxGapMs = Math.max(record.maxGapMs, now - previousChunkAt);
      previousChunkAt = now;
      record.chunks += 1;
      buffer += decoder.decode(result.value, { stream: true });

      let index;
      while ((index = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const terminator = buffer.startsWith('\r\n', index) ? 2 : 1;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + terminator);
        if (line === '') {
          dispatch();
          continue;
        }
        if (line.startsWith(':')) {
          record.comments += 1;
          continue;
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let v = colon === -1 ? '' : line.slice(colon + 1);
        if (v.startsWith(' ')) v = v.slice(1);
        if (field === 'event') event = v;
        else if (field === 'data') data = data === null ? v : `${data}\n${v}`;
        else if (field === 'id') frameId = v;
      }
    }
  } catch (cause) {
    record.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // the stream is already gone
    }
  }
  return record;
}

// ── the probe ──────────────────────────────────────────────────────────────────────────

const instrumentationPath = resolve(webRoot, 'instrumentation.ts');
let wroteInstrumentation = false;
// `undefined` means nothing was there before this script wrote its own file; any string
// (including `''`) means a real file's bytes are saved here for `finally` to restore.
let savedInstrumentation;

async function main() {
  log(`repo ${repoRoot}`);

  // 1. the runtime
  start(
    process.execPath,
    [
      resolve(here, 'fake-runner.mjs'),
      String(RUNNER_PORT),
      String(DENSE_SECONDS),
      String(TOTAL_SECONDS),
      String(SPARSE_SECONDS),
      NONCE,
    ],
    { tag: 'runner' },
  );
  // The nonce is what makes this a positive assertion. Without it, a stale runtime from an
  // earlier run answers /healthz and the probe proceeds against the wrong process.
  await waitFor(
    'the fake runtime',
    async () => {
      const r = await fetch(`http://127.0.0.1:${String(RUNNER_PORT)}/healthz`);
      if (!r.ok) return false;
      const health = await r.json();
      if (health.nonce === NONCE) return true;
      throw new Error(
        `port ${String(RUNNER_PORT)} is held by a different process (nonce ${String(health.nonce)}, expected ${NONCE}). Kill it and re-run.`,
      );
    },
    30_000,
  );
  log(`fake runtime up (nonce ${NONCE})`);

  // 2. the instrumentation shim, restored to whatever was there in `finally`.
  //
  // When this script was first written, `apps/web/instrumentation.ts` was outside every task's
  // ownership globs and never existed on disk between runs, so "it already exists" could only
  // mean a concurrent, uncommitted write this run must not clobber, and aborting was the right
  // answer. W1-COMP-01 has since landed the real composition root at that path — it is now a
  // committed file this branch's base carries on every checkout, not stray state — so "already
  // exists" no longer distinguishes the two cases. The positive check that does: save whatever is
  // there now, byte for byte, and put it back in `finally` regardless of which case it was.
  if (existsSync(instrumentationPath)) {
    savedInstrumentation = readFileSync(instrumentationPath, 'utf8');
    log(
      `saved existing ${instrumentationPath} (${String(savedInstrumentation.length)} bytes) to restore afterward`,
    );
  }
  writeFileSync(
    instrumentationPath,
    '// TEMPORARY - written by apps/web/server/runs/acceptance/run-acceptance.mjs and restored by it.\n' +
      '// The real apps/web/instrumentation.ts (W1-COMP-01) is saved above and put back in `finally`.\n' +
      "export { register } from './server/runs/acceptance/instrumentation';\n",
    'utf8',
  );
  wroteInstrumentation = true;
  log(`wrote ${instrumentationPath}`);

  // pnpm installs `next` into apps/web/node_modules, not the workspace root, so the binary is
  // resolved from apps/web's own module graph rather than guessed from a path.
  const nextBin = createRequire(resolve(webRoot, 'package.json')).resolve('next/dist/bin/next');
  const env = {
    ...process.env,
    AW_ACCEPTANCE_HARNESS: '1',
    AW_ACCEPTANCE_RUNNER_URL: `http://127.0.0.1:${String(RUNNER_PORT)}`,
    NODE_ENV: 'production',
  };

  // 3. a production build and a production server
  if (!flag('--no-build')) {
    log('next build …');
    await run(process.execPath, [nextBin, 'build'], { cwd: webRoot, env, tag: 'build' });
  }
  start(
    process.execPath,
    [nextBin, 'start', '-p', String(WEB_PORT), '--keepAliveTimeout', '70000'],
    { cwd: webRoot, env, tag: 'next' },
  );
  await waitFor('next start', async () => {
    const r = await fetch(`${WEB_ORIGIN}/api/runs/not-a-uuid`, {
      headers: authHeaders(WEB_ORIGIN),
    });
    return r.status === 400;
  });
  log(`next start up on :${String(WEB_PORT)}`);

  // 4. nginx
  await capture('docker', ['rm', '-f', CONTAINER]);
  await waitFor(
    'the previous nginx container to be gone',
    async () => {
      const ids = await capture('docker', ['ps', '-aq', '--filter', `name=^${CONTAINER}$`]);
      return ids === '';
    },
    30_000,
  );
  const gateway = await pickHostAlias(WEB_PORT);
  log(`container -> host via aw-host:${gateway} (verified from inside a container)`);
  await run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      CONTAINER,
      '--add-host',
      `aw-host:${gateway}`,
      '-p',
      `${String(NGINX_PORT)}:8099`,
      '-v',
      `${resolve(here, 'nginx.conf').replace(/\\/g, '/')}:/etc/nginx/nginx.conf:ro`,
      'nginx:1.29-alpine',
    ],
    { tag: 'docker' },
  );
  await waitFor(
    'the nginx container to be running',
    async () => {
      const state = await capture('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER]);
      if (state === 'false') {
        throw new Error(`the container exited: ${await capture('docker', ['logs', CONTAINER])}`);
      }
      return state === 'true';
    },
    30_000,
  );
  log(
    `aw-host resolves to ${await capture('docker', ['exec', CONTAINER, 'getent', 'hosts', 'aw-host'])}`,
  );
  await waitFor(
    'nginx',
    async () => {
      const r = await fetch(`${base}/api/runs/not-a-uuid`, { headers: authHeaders(NGINX_ORIGIN) });
      if (r.status !== 400) {
        throw new Error(`nginx answered ${String(r.status)} for the readiness probe`);
      }
      return true;
    },
    60_000,
  );
  const nginxVersion = await capture('docker', ['exec', CONTAINER, 'nginx', '-v']);
  log(`nginx up on :${String(NGINX_PORT)} via ${PROXY_PATH} — ${nginxVersion}`);

  // 5. start the run
  const startedAt = Date.now();
  const created = await fetch(`${base}/api/agents/${AGENT_ID}/runs`, {
    method: 'POST',
    headers: authHeaders(NGINX_ORIGIN, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prompt: 'W1-CP-04 acceptance: stream for ten minutes.' }),
  });
  check(
    created.status === 202,
    'POST /api/agents/:id/runs answers 202',
    `status ${String(created.status)}`,
  );
  const body = await created.json();
  const runId = body.run.id;
  log(`run ${runId} queued; events at ${body.events}`);

  // 6a. first connection — disconnect on purpose partway through
  log(`connection 1: reading for ${String(DISCONNECT_AT)}s, then disconnecting`);
  const first = await stream({
    url: `${base}/api/runs/${runId}/events`,
    stopAfterMs: DISCONNECT_AT * 1000,
  });
  console.log('CONNECTION 1', JSON.stringify({ ...first, events: first.events.length }, null, 0));
  check(first.status === 200, 'the stream answers 200 through nginx');
  check(
    first.contentType === 'text/event-stream; charset=utf-8',
    'Content-Type survives the proxy',
    String(first.contentType),
  );
  check(
    first.contentEncoding === null,
    'nginx did not gzip the stream',
    `content-encoding=${String(first.contentEncoding)}`,
  );
  check(
    first.events.length > 0,
    'events arrived on the first connection',
    `${String(first.events.length)} events`,
  );
  check(
    first.maxGapMs < 20_000,
    'no proxy buffering: chunks arrive at the producer cadence on connection 1',
    `maxGapMs=${String(first.maxGapMs)}`,
  );
  const firstIds = first.events.map((e) => Number(e.id));
  check(
    firstIds.every((n, i) => i === 0 || n === firstIds[i - 1] + 1),
    'connection 1 ids are contiguous',
    `${String(firstIds[0])}..${String(firstIds.at(-1))}`,
  );

  // 6b. reconnect from Last-Event-ID and read past ten minutes
  const resumeFrom = first.lastEventId;
  const remainingMs = Math.max(TOTAL_SECONDS * 1000 - (Date.now() - startedAt) + 60_000, 60_000);
  log(
    `connection 2: resuming from Last-Event-ID: ${String(resumeFrom)} for up to ${String(Math.round(remainingMs / 1000))}s`,
  );
  const second = await stream({
    url: `${base}/api/runs/${runId}/events`,
    lastEventId: resumeFrom,
    stopAfterMs: remainingMs,
  });
  const totalSeconds = (Date.now() - startedAt) / 1000;
  console.log('CONNECTION 2', JSON.stringify({ ...second, events: second.events.length }, null, 0));

  const secondIds = second.events.map((e) => Number(e.id));
  check(second.status === 200, 'the reconnect answers 200');
  check(
    second.controlFrames.every((f) => f.event !== 'stream-reset'),
    'the resume cursor was servable — no stream-reset',
    JSON.stringify(second.controlFrames.map((f) => f.event)),
  );
  check(
    secondIds.length > 0 && secondIds[0] === Number(resumeFrom) + 1,
    'the reconnect replays from Last-Event-ID + 1',
    `resumed at ${String(resumeFrom)}, first replayed id ${String(secondIds[0])}`,
  );
  check(
    secondIds.every((n, i) => i === 0 || n === secondIds[i - 1] + 1),
    'connection 2 ids are contiguous',
    `${String(secondIds[0])}..${String(secondIds.at(-1))}`,
  );
  check(
    !secondIds.some((n) => firstIds.includes(n)),
    'the reconnect delivered no duplicate of what connection 1 already had',
  );
  check(
    second.comments > 0,
    'keep-alive comments reached the client through nginx',
    `${String(second.comments)} comments`,
  );
  check(
    second.maxGapMs < 40_000,
    'no gap approached nginx stock proxy_read_timeout (60s)',
    `maxGapMs=${String(second.maxGapMs)}`,
  );
  check(
    second.controlFrames.some((f) => f.event === 'done'),
    'the stream ended with a done frame rather than being cut',
    JSON.stringify(second.controlFrames.map((f) => f.event)),
  );
  // The exact control-frame set, not "no run-failed appeared". This run's run succeeds, so `done`
  // alone is the whole set; anything else — a `run-failed` this server should not have written, a
  // `stream-reset` the retention window should not have produced — fails here by not matching.
  check(
    second.controlFrames.length === 1 && second.controlFrames[0].event === 'done',
    'a run that completed ends with exactly one control frame, and it is done',
    JSON.stringify(second.controlFrames.map((f) => f.event)),
  );
  check(
    totalSeconds >= 600,
    'the stream ran for at least ten minutes',
    `${totalSeconds.toFixed(1)}s`,
  );

  // 7. the run record agrees
  const finalRun = await (
    await fetch(`${base}/api/runs/${runId}`, { headers: authHeaders(NGINX_ORIGIN) })
  ).json();
  check(
    finalRun.run.status === 'completed',
    'GET /api/runs/:id reports the run completed',
    JSON.stringify(finalRun.run.status),
  );

  const seq = [...firstIds, ...secondIds];
  console.log('');
  console.log(
    'RESULT ' +
      JSON.stringify({
        proxyPath: PROXY_PATH,
        nginx: nginxVersion,
        durationS: Number(totalSeconds.toFixed(1)),
        connection1: {
          ttfbMs: first.ttfbMs,
          events: firstIds.length,
          lastId: firstIds.at(-1) ?? null,
          maxGapMs: first.maxGapMs,
          comments: first.comments,
          ce: first.contentEncoding,
          te: first.transferEncoding,
          xab: first.xAccelBuffering,
        },
        resumedFrom: Number(resumeFrom),
        connection2: {
          ttfbMs: second.ttfbMs,
          events: secondIds.length,
          firstId: secondIds[0] ?? null,
          lastId: secondIds.at(-1) ?? null,
          maxGapMs: second.maxGapMs,
          comments: second.comments,
          clean: second.clean,
          control: second.controlFrames.map((f) => f.event),
        },
        idsContiguousAcrossReconnect: seq.every((n, i) => i === 0 || n === seq[i - 1] + 1),
        totalEvents: seq.length,
        runStatus: finalRun.run.status,
      }),
  );
}

try {
  await main();
} catch (cause) {
  console.error('ACCEPTANCE ABORTED:', cause);
  failures.push(`the probe threw: ${cause instanceof Error ? cause.message : String(cause)}`);
} finally {
  for (const child of children) killTree(child);
  // AWAITED, not fire-and-forget. An unawaited spawn here loses the race with `process.exit`
  // below and the nginx container outlives the probe — which the next run then has to clean up
  // by name. `captureExit` resolves on exit and never rejects, so a container that is already
  // gone does not turn a passing run into a failing one.
  await captureExit('docker', ['rm', '-f', CONTAINER]);
  if (wroteInstrumentation) {
    if (savedInstrumentation === undefined) {
      rmSync(instrumentationPath, { force: true });
      log(`removed ${instrumentationPath}`);
    } else {
      writeFileSync(instrumentationPath, savedInstrumentation, 'utf8');
      log(`restored ${instrumentationPath} (${String(savedInstrumentation.length)} bytes)`);
    }
  }
}

console.log('');
if (failures.length === 0) {
  console.log('ACCEPTANCE PASSED');
  process.exit(0);
}
console.log(`ACCEPTANCE FAILED (${String(failures.length)}): ${failures.join('; ')}`);
process.exit(1);
