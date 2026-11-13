// Prove that a ten-minute run survives nginx and resumes through Last-Event-ID.
// Starts a fake runner, temporarily installs acceptance instrumentation, and restores it on exit.
// Usage: node run-acceptance.mjs [--no-build] [--location stock|tuned] [--seconds 640]

/* global console, process, fetch */
// The root ESLint config declares no environment globals; scripts/*.mjs use the same mechanism.

import {
  createProcessSupervisor,
  waitFor,
  captureExit,
  capture,
  pickHostAlias,
} from './process-probes.mjs';
import { stream } from './stream-client.mjs';
import { checkFirstConnection, checkReconnect, printProbeResult } from './stream-assertions.mjs';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Use the same signing implementation the real authentication boundary verifies.
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

const ports = {
  web: Number(value('--web-port', '3111')),
  runner: Number(value('--runner-port', '3112')),
  nginx: Number(value('--nginx-port', '8099')),
};
// Keep location names free of leading slashes, which Git Bash rewrites as local paths.
const LOCATIONS = ['stock', 'tuned'];
const LOCATION = value('--location', 'stock');
if (!LOCATIONS.includes(LOCATION)) {
  console.error(
    `--location must be one of ${LOCATIONS.join(', ')}; got ${JSON.stringify(LOCATION)}`,
  );
  process.exit(2);
}
const PROXY_PATH = `/${LOCATION}/`;
const timing = {
  totalSeconds: Number(value('--seconds', '640')),
  denseSeconds: Number(value('--dense', '30')),
  sparseSeconds: Number(value('--sparse', '30')),
  disconnectAtSeconds: Number(value('--disconnect-at', '45')),
};
const MILLISECONDS_PER_SECOND = 1000;
const COMPLETION_GRACE_MS = 60_000;
const CONTAINER = 'aw-w1cp04-nginx';
const NONCE = `w1cp04-${String(Date.now())}`;

const AGENT_ID = 'a0000000-0000-4000-8000-000000000002';

const base = `http://127.0.0.1:${String(ports.nginx)}${PROXY_PATH.replace(/\/$/, '')}`;
const WEB_ORIGIN = `http://127.0.0.1:${String(ports.web)}`;
// nginx forwards $host without the port, so the matching Origin is port-less.
const NGINX_ORIGIN = 'http://127.0.0.1';

const log = (...parts) => {
  console.log(`[${new Date().toISOString()}]`, ...parts);
};

// Every probe carries a real signed cookie and a same-host Origin.
const sessionSecret = readSessionSecret(process.env);
if (!sessionSecret.ok) {
  console.error(`ACCEPTANCE ABORTED: ${sessionSecret.reason}`);
  process.exit(2);
}
const sessionToken = await mintSessionToken(
  newSessionClaims('acceptance-harness@w1-cp04b.test', 'w1-cp04b-acceptance'),
  sessionSecret.secret,
);
const sessionCookieHeader = `${sessionCookieName(process.env)}=${sessionToken}`;

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

const { start, run, stop } = createProcessSupervisor();

const instrumentationPath = resolve(webRoot, 'instrumentation.ts');
let wroteInstrumentation = false;
// Restore even an empty original file; only undefined means there was no file.
let savedInstrumentation;

async function startRuntime() {
  start(
    process.execPath,
    [
      resolve(here, 'fake-runner.mjs'),
      String(ports.runner),
      String(timing.denseSeconds),
      String(timing.totalSeconds),
      String(timing.sparseSeconds),
      NONCE,
    ],
    { tag: 'runner' },
  );
  // The nonce is what makes this a positive assertion. Without it, a stale runtime from an
  // earlier run answers /healthz and the probe proceeds against the wrong process.
  await waitFor(
    'the fake runtime',
    async () => {
      const r = await fetch(`http://127.0.0.1:${String(ports.runner)}/healthz`);
      if (!r.ok) return false;
      const health = await r.json();
      if (health.nonce === NONCE) return true;
      throw new Error(
        `port ${String(ports.runner)} is held by a different process (nonce ${String(health.nonce)}, expected ${NONCE}). Kill it and re-run.`,
      );
    },
    30_000,
  );
  log(`fake runtime up (nonce ${NONCE})`);
}

async function installInstrumentation() {
  // Preserve an existing composition root byte-for-byte and restore it on every exit.
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
}

async function startWeb() {
  // pnpm installs `next` into apps/web/node_modules, not the workspace root, so the binary is
  // resolved from apps/web's own module graph rather than guessed from a path.
  const nextBin = createRequire(resolve(webRoot, 'package.json')).resolve('next/dist/bin/next');
  const env = {
    ...process.env,
    AW_ACCEPTANCE_HARNESS: '1',
    AW_ACCEPTANCE_RUNNER_URL: `http://127.0.0.1:${String(ports.runner)}`,
    NODE_ENV: 'production',
  };

  if (!flag('--no-build')) {
    log('next build …');
    await run(process.execPath, [nextBin, 'build'], { cwd: webRoot, env, tag: 'build' });
  }
  start(
    process.execPath,
    [nextBin, 'start', '-p', String(ports.web), '--keepAliveTimeout', '70000'],
    { cwd: webRoot, env, tag: 'next' },
  );
  await waitFor('next start', async () => {
    const r = await fetch(`${WEB_ORIGIN}/api/runs/not-a-uuid`, {
      headers: authHeaders(WEB_ORIGIN),
    });
    return r.status === 400;
  });
  log(`next start up on :${String(ports.web)}`);
}

const CONTAINER_START_TIMEOUT_MS = 30_000;
const PROXY_READY_TIMEOUT_MS = 60_000;

async function removePreviousProxy() {
  await capture('docker', ['rm', '-f', CONTAINER]);
  await waitFor(
    'the previous nginx container to be gone',
    async () => {
      const ids = await capture('docker', ['ps', '-aq', '--filter', `name=^${CONTAINER}$`]);
      return ids === '';
    },
    CONTAINER_START_TIMEOUT_MS,
  );
}

async function startProxyContainer(gateway) {
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
      `${String(ports.nginx)}:8099`,
      '-v',
      `${resolve(here, 'nginx.conf').replace(/\\/g, '/')}:/etc/nginx/nginx.conf:ro`,
      'nginx:1.29-alpine',
    ],
    { tag: 'docker' },
  );
}

async function waitForProxyContainer() {
  await waitFor(
    'the nginx container to be running',
    async () => {
      const state = await capture('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER]);
      if (state === 'false') {
        throw new Error(`the container exited: ${await capture('docker', ['logs', CONTAINER])}`);
      }
      return state === 'true';
    },
    CONTAINER_START_TIMEOUT_MS,
  );
  log(
    `aw-host resolves to ${await capture('docker', ['exec', CONTAINER, 'getent', 'hosts', 'aw-host'])}`,
  );
}

async function startProxy() {
  await removePreviousProxy();
  const gateway = await pickHostAlias(ports.web);
  log(`container -> host via aw-host:${gateway} (verified from inside a container)`);
  await startProxyContainer(gateway);
  await waitForProxyContainer();
  await waitFor(
    'nginx',
    async () => {
      const r = await fetch(`${base}/api/runs/not-a-uuid`, { headers: authHeaders(NGINX_ORIGIN) });
      if (r.status !== 400) {
        throw new Error(`nginx answered ${String(r.status)} for the readiness probe`);
      }
      return true;
    },
    PROXY_READY_TIMEOUT_MS,
  );
  const nginxVersion = await capture('docker', ['exec', CONTAINER, 'nginx', '-v']);
  log(`nginx up on :${String(ports.nginx)} via ${PROXY_PATH} — ${nginxVersion}`);

  return nginxVersion;
}

async function startAcceptanceRun() {
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

  return { runId, startedAt };
}

async function probeRunStream(nginxVersion) {
  const { runId, startedAt } = await startAcceptanceRun();

  log(`connection 1: reading for ${String(timing.disconnectAtSeconds)}s, then disconnecting`);
  const first = await stream({
    headers: authHeaders(NGINX_ORIGIN, { Accept: 'text/event-stream' }),
    url: `${base}/api/runs/${runId}/events`,
    stopAfterMs: timing.disconnectAtSeconds * MILLISECONDS_PER_SECOND,
  });
  console.log('CONNECTION 1', JSON.stringify({ ...first, events: first.events.length }, null, 0));
  const firstIds = checkFirstConnection(first, check);

  const resumeFrom = first.lastEventId;
  const remainingMs = Math.max(
    timing.totalSeconds * MILLISECONDS_PER_SECOND - (Date.now() - startedAt) + COMPLETION_GRACE_MS,
    COMPLETION_GRACE_MS,
  );
  log(
    `connection 2: resuming from Last-Event-ID: ${String(resumeFrom)} for up to ${String(Math.round(remainingMs / MILLISECONDS_PER_SECOND))}s`,
  );
  const second = await stream({
    headers: authHeaders(NGINX_ORIGIN, { Accept: 'text/event-stream' }),
    url: `${base}/api/runs/${runId}/events`,
    lastEventId: resumeFrom,
    stopAfterMs: remainingMs,
  });
  const totalSeconds = (Date.now() - startedAt) / MILLISECONDS_PER_SECOND;
  console.log('CONNECTION 2', JSON.stringify({ ...second, events: second.events.length }, null, 0));

  const secondIds = checkReconnect({ firstIds, second, resumeFrom, totalSeconds }, check);

  const finalRun = await (
    await fetch(`${base}/api/runs/${runId}`, { headers: authHeaders(NGINX_ORIGIN) })
  ).json();
  check(
    finalRun.run.status === 'completed',
    'GET /api/runs/:id reports the run completed',
    JSON.stringify(finalRun.run.status),
  );

  printProbeResult({
    proxyPath: PROXY_PATH,
    first,
    second,
    firstIds,
    secondIds,
    resumeFrom,
    totalSeconds,
    nginxVersion,
    finalRun,
  });
}

async function main() {
  log(`repo ${repoRoot}`);
  await startRuntime();
  await installInstrumentation();
  await startWeb();
  const nginxVersion = await startProxy();
  await probeRunStream(nginxVersion);
}

try {
  await main();
} catch (cause) {
  console.error('ACCEPTANCE ABORTED:', cause);
  failures.push(`the probe threw: ${cause instanceof Error ? cause.message : String(cause)}`);
} finally {
  stop();
  // Await removal so nginx cannot outlive the probe.
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
