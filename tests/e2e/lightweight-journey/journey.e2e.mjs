#!/usr/bin/env node
/* global console, fetch, AbortSignal */
/**
 * The lightweight deploy-the-agent-app journey (issue #832, E7 AC2) for one lane: the Z1 journey's
 * chapters (`../build-deploy-journey`, imported, not copied) against a Vercel or Cloudflare
 * deployment instead of a Compose one.
 *
 *   LJ_LANE=vercel-vercel-sandbox LJ_RUN_ID=1 pnpm exec node tests/e2e/lightweight-journey/journey.e2e.mjs
 *
 * Lanes, chapters, skip rules and names are `lanes.mjs`; `teardown.mjs` deletes what this deploys.
 * Environment: `LJ_LANE`, `LJ_RUN_ID` (or `GITHUB_RUN_ID`), `LJ_RESULTS` (default `results.json`),
 * `LJ_WORK_DIR` and the lane's credentials (`lanes.mjs`); no model key. As in the Z1 journey, the eval
 * runs a scripted model and the deployment is set up with a fake `sk-ant-` key (a deployment refuses
 * scripted models outside the local posture). Compose answers `api.anthropic.com` with the scripted
 * fake; a hosted lane cannot alias that host, so every lane deploys the fake as a Cloudflare Worker
 * and setup is given its URL as `providerBaseUrl`. Without a credential the lane is `skipped` on every
 * row, starts no container and exits 0; a failure exits 1 after the results file says which row
 * failed.
 *
 * It needs Docker (the platform images go to a local registry), `npm`, `openssl` and the packages
 * built, and it creates cloud resources: run it through the workflow.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { remainingBefore } from '../../generated-project/images.mjs';
import { parseDotEnv } from '../../generated-project/project.mjs';
import { positiveIntegerVariable } from '../../generated-project/run.mjs';
import { StackClient, assistantText, terminalStatus } from '../../generated-project/stack-api.mjs';
import {
  agentWithTool,
  check,
  chatNonce,
  createSupportProject,
  evaluateScripted,
  journeyShell,
  preparePackages,
  promotePastGate,
  spawnChecked,
  stopPackages,
} from '../build-deploy-journey/journey.e2e.mjs';
import {
  buildJourneyImages,
  digestReference,
  startRegistry,
  stopRegistry,
} from '../build-deploy-journey/registry.mjs';
import { DECLARED_SECRET, OFFLINE_DECLARATION, OFFLINE_RUN_FILE } from '../tool-sandbox.e2e.mjs';
import { buildTemplate, builderResources } from '../../../infra/e2b/build-template.mjs';
import { runtimeBuild } from '../../../infra/e2b/runtime-template.mjs';
import { toolHostBuild } from '../../../infra/e2b/tool-host-template.mjs';
import { WRANGLER, deployBridge } from '../../../infra/tests/providers/cloudflare-bridge.mjs';
import { redact } from '../../../infra/tests/providers/support.mjs';
import { killLaneSandboxes } from './e2b-sandboxes.mjs';
import { deployFakeProvider } from './fake-provider.mjs';
import { LANES, missingVariables, resourceNames, resultsWriter, runChapters } from './lanes.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const CLOUDFLARE = 'https://api.cloudflare.com/client/v4';
/** One template of each kind per E2B lane (`-ve`, `-ce`), so the two lanes never create the same template at once. */
const RUNTIME_TEMPLATE_PREFIX = 'aw-runtime-journey';
const TOOL_HOST_TEMPLATE_PREFIX = 'aw-tool-host-journey';
const NEON = 'https://console.neon.tech/api/v2';
const SURFACE = 'main';
/** The promotion bar `aw deploy` writes as `AW_DEPLOYMENT_POLICY`; the profile-path deploy does not, so the journey sets it. */
export const JOURNEY_DEPLOYMENT_POLICY = '{"promotion":{"minEvalScore":1}}';

/** One R2 bucket per lane, reused across runs. */
const laneBucket = (/** @type {string} */ laneKey) => `awlj-${laneKey}-files`;

/**
 * A lane's object-store entries for `.env`: its R2 key pair and the `AW_STORAGE_URL` of its bucket,
 * `awlj-<lane key>-files`, reused across runs (the rendered per-run name would leak one each run).
 * The URL names R2's endpoint, so neither target derives another or creates a per-run bucket.
 *
 * @param {string} laneKey @param {Readonly<Record<string, string | undefined>>} env
 */
export function storageEntries(laneKey, env) {
  const account = env['CLOUDFLARE_ACCOUNT_ID'] ?? '';
  return {
    OBJECT_STORAGE_ACCESS_KEY_ID: env['R2_ACCESS_KEY_ID'] ?? '',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: env['R2_SECRET_ACCESS_KEY'] ?? '',
    AW_STORAGE_URL: `s3://${laneBucket(laneKey)}?endpoint=https://${account}.r2.cloudflarestorage.com&region=auto`,
  };
}

/**
 * `text` with each `KEY=value` set: an existing line is replaced, a missing one appended.
 *
 * @param {string} text @param {Readonly<Record<string, string>>} entries
 */
export function setDotEnv(text, entries) {
  let out = text.endsWith('\n') || text === '' ? text : `${text}\n`;
  for (const [key, value] of Object.entries(entries)) {
    const line = new RegExp(`^${key}=.*$`, 'mu');
    out = line.test(out) ? out.replace(line, () => `${key}=${value}`) : `${out}${key}=${value}\n`;
  }
  return out;
}

/** The project frontend: no dependency, `npm run build` writes `dist/` (what Vercel and Wrangler run). */
export function frontendFiles() {
  return {
    'package.json': `${JSON.stringify({ name: 'lightweight-journey-web', private: true, scripts: { build: 'node build.mjs' } }, null, 2)}\n`,
    'build.mjs': [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "const base = process.env.VITE_AW_BASE_URL ?? '';",
      "mkdirSync('dist', { recursive: true });",
      'writeFileSync(\'dist/index.html\', `<!doctype html><title>journey</title><p id="aw-base">${base}</p><script src="${base}/p/s/main/widget.js" async></script>\\n`);',
      '',
    ].join('\n'),
  };
}

/**
 * The runtime image a generated project pins (`AW_RUNTIME_IMAGE`), pushed to Cloudflare's registry
 * the way `agent-workspace deploy --target cloudflare` pushes the platform images: pulled for
 * linux/amd64, tagged by its digest, `wrangler containers push`ed with the token in the environment
 * only. Returns the registry's digest reference, which the bridge pins.
 *
 * @param {string} reference `name@sha256:<digest>` @param {string} account
 */
export function pushRuntimeImage(reference, account) {
  const digest = /@sha256:([0-9a-f]{64})$/u.exec(reference)?.[1];
  check(digest !== undefined, 'the runtime image is pinned by digest');
  const localTag = `agent-workspace-runtime:sha256-${String(digest)}`;
  spawnChecked('docker', ['pull', '--platform', 'linux/amd64', reference], {});
  spawnChecked('docker', ['tag', reference, localTag], {});
  spawnChecked('npx', ['--yes', WRANGLER, 'containers', 'push', localTag], {
    env: process.env,
    timeout: 900_000,
  });
  const pushed = `registry.cloudflare.com/${account}/${localTag}`;
  const pinned = spawnChecked(
    'docker',
    ['image', 'inspect', '--format', '{{join .RepoDigests "\\n"}}', pushed],
    {},
  )
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^registry\.cloudflare\.com\/.+@sha256:[0-9a-f]{64}$/u.test(line));
  check(pinned !== undefined, 'the pushed runtime image has a registry digest');
  return String(pinned);
}

const VERCEL = 'https://api.vercel.com';
const VCR = 'vcr.vercel.com';
const VCR_REPOSITORY = 'agent-workspace-runtime';

/**
 * The runtime image the `vercel-sandbox` manager runs, in the manager project's Vercel Container
 * Registry (ADR-0120 LC2): Vercel Sandbox runs no image from any other registry. Looks up the team
 * slug, creates the `<project>-manager` project when absent, logs in with the token on stdin and an
 * isolated `DOCKER_CONFIG`, pulls the image for linux/amd64, tags it, pushes it, reads the registry
 * digest, then creates (and deletes) a throwaway sandbox until the registry has finished with the
 * image (`image_not_ready` is the answer until then). Returns `<slug>/<project>-manager/<repo>@sha256:<d>`.
 *
 * @param {{
 *   reference: string, team: string, token: string, project: string,
 *   run?: typeof spawnChecked, call?: typeof call, sleep?: (ms: number) => Promise<unknown>,
 *   polls?: number, pollMs?: number,
 * }} options
 */
export async function pushVercelSandboxImage({
  reference,
  team,
  token,
  project,
  run = spawnChecked,
  call: api = call,
  sleep = delay,
  polls = 30,
  pollMs = 10_000,
}) {
  const digest = /@sha256:([0-9a-f]{64})$/u.exec(reference)?.[1];
  check(digest !== undefined, 'the runtime image is pinned by digest');
  const query = `teamId=${encodeURIComponent(team)}`;
  const json = { 'content-type': 'application/json' };
  const slug = (await api(`${VERCEL}/v2/teams/${encodeURIComponent(team)}`, { token })).json?.slug;
  check(typeof slug === 'string', 'the Vercel team has a slug');
  const manager = `${project}-manager`;
  let found = await api(`${VERCEL}/v9/projects/${encodeURIComponent(manager)}?${query}`, { token });
  if (found.status !== 200) {
    found = await api(`${VERCEL}/v11/projects?${query}`, {
      method: 'POST',
      token,
      headers: json,
      body: JSON.stringify({ name: manager }),
    });
  }
  const projectId = found.json?.id;
  check(
    typeof projectId === 'string',
    `the ${manager} project exists (HTTP ${String(found.status)})`,
  );

  const repository = `${VCR}/${slug}/${manager}/${VCR_REPOSITORY}`;
  const tagged = `${repository}:sha256-${digest}`;
  const dockerConfig = mkdtempSync(path.join(tmpdir(), 'aw-vcr-'));
  const env = { ...process.env, DOCKER_CONFIG: dockerConfig };
  try {
    run('docker', ['login', VCR, '--username', team, '--password-stdin'], { env, input: token });
    run('docker', ['pull', '--platform', 'linux/amd64', reference], { env });
    run('docker', ['tag', reference, tagged], { env });
    run('docker', ['push', tagged], { env, timeout: 900_000 });
    const pushed = run(
      'docker',
      ['image', 'inspect', '--format', '{{join .RepoDigests "\\n"}}', tagged],
      { env },
    )
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith(`${repository}@sha256:`))
      ?.slice(repository.length + 1);
    check(pushed !== undefined, 'the pushed runtime image has a registry digest');
    const image = `${slug}/${manager}/${VCR_REPOSITORY}@${String(pushed)}`;

    const sandbox = `aw-ready-${randomBytes(6).toString('hex')}`;
    for (let attempt = 1; ; attempt += 1) {
      const created = await api(`${VERCEL}/v4/sandboxes?${query}`, {
        method: 'POST',
        token,
        headers: json,
        body: JSON.stringify({
          name: sandbox,
          projectId,
          image,
          persistent: false,
          timeout: 60_000,
        }),
      });
      if (created.status >= 200 && created.status < 300) {
        await api(
          `${VERCEL}/v2/sandboxes/${sandbox}?${query}&projectId=${encodeURIComponent(projectId)}`,
          { method: 'DELETE', token },
        );
        return image;
      }
      check(
        created.text.includes('image_not_ready') && attempt < polls,
        `the pushed runtime image does not start (HTTP ${String(created.status)} ${created.text.slice(0, 200)})`,
      );
      await sleep(pollMs);
    }
  } finally {
    rmSync(dockerConfig, { recursive: true, force: true });
  }
}

/** @param {string} url @param {RequestInit & { token?: string }} [init] */
async function call(url, { token, ...init } = {}) {
  const headers = {
    accept: 'application/json',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    ...init.headers,
  };
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: the status and text are the evidence
  }
  return { status: response.status, headers: response.headers, text, json };
}

const SECRET_FIELD = /token|key|secret|password|credential/iu;

/**
 * Every string a JSON answer carries under a field named like a credential (`token`, `apiKey`,
 * `secret`, `password`, ...), at any depth, including the items of an array in such a field.
 * Short values are skipped: redacting them would mangle ordinary words in the log.
 *
 * @param {unknown} value
 * @param {boolean} [named] whether `value` sits under a credential-named field
 * @returns {string[]}
 */
export function responseSecrets(value, named = false) {
  if (typeof value === 'string') return named && value.length >= 8 ? [value] : [];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([name, child]) =>
    responseSecrets(child, Array.isArray(value) ? named : SECRET_FIELD.test(name)),
  );
}

/**
 * `check` that redacts its message with `hidden()` first, so an `ok:` line never prints a
 * credential. The shared `check` prints every passing message as it is.
 *
 * @param {() => readonly string[]} hidden @param {typeof check} [print]
 */
export function redactingCheck(hidden, print = check) {
  return (/** @type {boolean} */ ok, /** @type {string} */ message) =>
    print(ok, redact(message, [...hidden()]));
}

/**
 * What the control plane stored for a run that did not complete: its status and its public error,
 * which names the failing hop (`The runtime could not be reached.`, ...). The server log holds the
 * cause; this is the only part of it that is safe to print. Redacted with `secrets` and capped.
 *
 * @param {{ request: (route: string, options?: { apiKey?: string }) => Promise<{ status: number, json: any }> }} client
 * @param {string} runId @param {readonly string[]} secrets @param {string} [apiKey]
 */
export async function failedRunDetail(client, runId, secrets, apiKey) {
  let answer;
  try {
    answer = await client.request(`/api/runs/${runId}`, apiKey === undefined ? {} : { apiKey });
  } catch {
    return 'run detail unavailable';
  }
  const run = answer.json?.run;
  const detail =
    answer.status === 200
      ? `status=${String(run?.status)} error=${String(run?.error)}`
      : `status=${String(answer.status)}`;
  return redact(detail.replace(/\p{Cc}/gu, ' '), [...secrets]).slice(0, 300);
}

/**
 * The proof a lane whose runtime refuses every run (ADR-0131) records `n/a` on: the typed code in the
 * start answer, or in the frames of a run that did not complete. Anything else is a failure.
 *
 * @param {string} code @param {{ status: number, text: string }} started
 * @param {() => Promise<any[]>} framesOf @param {(ok: boolean, message: string) => void} [report]
 */
export async function refusedRun(code, started, framesOf, report = check) {
  const seen = started.status === 202 ? await framesOf() : [started.text];
  const text = JSON.stringify(seen);
  report(
    text.includes(code) &&
      (started.status === 202 ? terminalStatus(seen) !== 'completed' : started.status === 422),
    `the run was refused with ${code} (${String(started.status)} ${text.slice(-300)})`,
  );
  return `n/a: the first run was refused with ${code} (ADR-0131) and nothing ran`;
}

/**
 * The proof a lane with no tool sandbox records `n/a` on for `aw push`: every problem line is the
 * typed `422 <code>` refusal and there is at least one. Any other problem line (a 503, another
 * code) fails, so only the expected refusal is excused.
 *
 * @param {string} code @param {string} output what `aw push --yes` printed
 * @param {(ok: boolean, message: string) => void} [report]
 */
export function refusedPush(code, output, report = check) {
  const problems = output.split('\n').filter((line) => /^\S+: (?:\d{3}|local) [a-z_]+/u.test(line));
  report(
    problems.length > 0 &&
      problems.every((line) => new RegExp(`^\\S+: 422 ${code}\\b`, 'u').test(line)),
    `aw push was refused with ${code} only (${output.slice(-500)})`,
  );
  // A problem in another shape (`✗ file:line:col  …`) is not matched above; the count line catches it.
  const count = /^(?:error: )?(\d+) problems?$/mu.exec(output)?.[1];
  report(
    count === undefined || Number(count) === problems.length,
    `aw push printed ${String(count)} problem(s) but ${String(problems.length)} refusal line(s) (${output.slice(-500)})`,
  );
  return `n/a: aw push was refused with ${code} (ADR-0131) and no agent was created`;
}

/**
 * One turn the way the project frontend's client sends it (`client.runs.start` of
 * `@indx-workspace/react`): `POST /api/agents/<agent>/runs` from the frontend origin, the visitor
 * token as Bearer, `{ prompt, sessionId }`. The run must be accepted with CORS for that origin (a
 * browser there could not read the answer otherwise), complete, and reply with the code tool's data.
 *
 * @param {{
 *   control: string, origin: string, nonce: string,
 *   session: { token: string, sessionId: string, agentId: string },
 *   ask: (url: string, init: RequestInit) => Promise<{ status: number, text: string, headers: Headers, json: any }>,
 *   framesOf: (runId: string) => Promise<any[]>,
 *   detailOf?: (runId: string) => Promise<string>,
 *   report?: (ok: boolean, message: string) => void,
 * }} options
 */
export async function frontendTurn({
  control,
  origin,
  nonce,
  session,
  ask: send,
  framesOf,
  detailOf = () => Promise.resolve(''),
  report = check,
}) {
  const started = await send(`${control}/api/agents/${session.agentId}/runs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      prompt: `Look up order ${nonce} with your order tool and repeat the tool output exactly.`,
      sessionId: session.sessionId,
    }),
  });
  report(
    started.status === 202,
    `the frontend's run was accepted (${String(started.status)} ${started.text.slice(0, 200)})`,
  );
  const allowed = started.headers.get('access-control-allow-origin');
  report(allowed === origin, `the run answer allows the frontend origin (${String(allowed)})`);
  const runId = String(started.json?.run?.id);
  const frames = await framesOf(runId);
  const completed = terminalStatus(frames) === 'completed';
  report(completed, `the frontend's run completed (${completed ? '' : await detailOf(runId)})`);
  report(
    assistantText(frames).includes(`order-data-${nonce}`),
    "the frontend's reply carries the code tool's data",
  );
}

/**
 * Setup answered 201, and recorded the runtime's refusal exactly when the lane expects one: a lane
 * whose runtime refuses every network policy (ADR-0131) completes setup with that recorded state.
 *
 * @param {string | undefined} refusal @param {{ status: number, text: string, json: any }} setup @param {(ok: boolean, message: string) => void} [report]
 */
export function setupAnswered(refusal, setup, report = check) {
  report(
    setup.status === 201,
    `setup answered ${String(setup.status)} ${setup.text.slice(0, 300)}`,
  );
  const recorded = setup.json?.runtimeRefusal ?? null;
  report(
    refusal === undefined
      ? recorded === null
      : recorded?.code === refusal && String(recorded.message).includes('ADR-0131'),
    `setup recorded the runtime refusal ${String(refusal ?? 'none')} (${JSON.stringify(recorded)})`,
  );
}

/**
 * What an answer says, short enough to read: Cloudflare's own error page is reduced to its title,
 * its `Error NNNN` code and its `cf-ray`; anything else is cut at 300 characters. A local copy of
 * `answerSummary` in `packages/cli/src/deploy/cloudflare.ts`, so both waits report alike.
 *
 * @param {Response} response
 * @param {string} body
 */
function answerSummary(response, body) {
  if (!/^\s*<(?:!doctype|html)/iu.test(body)) return body.slice(0, 300);
  const title = /<title[^>]*>([^<]*)<\/title>/iu.exec(body)?.[1]?.replace(/\s+/gu, ' ').trim();
  const code = /\bError (\d{3,4})\b/u.exec(body)?.[1];
  const ray = response.headers.get('cf-ray');
  const parts = [
    title ? `title: ${title.slice(0, 120)}` : '',
    code === undefined ? '' : `code: Error ${code}`,
    ray === null ? '' : `cf-ray: ${ray.slice(0, 40)}`,
  ].filter((part) => part !== '');
  return title || code !== undefined ? parts.join('; ') : body.slice(0, 300);
}

/**
 * Polls `<control plane>/setup` until it answers 200 (auth-exempt, so a redirect is not an answer:
 * `apps/web/proxy.ts`). On exhaustion the error says what the last attempt saw: the status and the
 * start of the body, or the network error's code.
 *
 * @param {string} control
 * @param {{ fetch?: typeof fetch, windowMs?: number, delayMs?: number, requestTimeoutMs?: number }} [options]
 */
export async function awaitSetup(control, options = {}) {
  const {
    fetch: get = globalThis.fetch,
    windowMs = 600_000,
    delayMs = 5_000,
    requestTimeoutMs = 90_000,
  } = options;
  /** @type {string} */
  let last;
  const deadline = Date.now() + windowMs;
  let requests = 0;
  for (;;) {
    requests += 1;
    try {
      const response = await get(`${control}/setup`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.ok) return;
      last = `HTTP ${String(response.status)} ${JSON.stringify(answerSummary(response, await response.text()))}`;
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      const code =
        typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : null;
      last = `network error ${String(code ?? (error instanceof Error ? error.message : error))}`;
    }
    if (Date.now() + delayMs >= deadline) break;
    await delay(delayMs);
  }
  throw new Error(
    `the control plane did not answer ${control}/setup with 200 in ${String(windowMs / 1000)} s (${String(requests)} requests); last: ${last}`,
  );
}

/**
 * The last error-looking lines of a Vercel deployment's runtime log, for the failure message of a
 * control plane that never answered `/setup`: a start-up refusal is logged by apps/web and shows
 * as a bare HTTP 500 otherwise. `vercel logs` streams, so it is killed after `timeoutMs` and what
 * arrived is kept. Best effort: any failure is a placeholder, never an error. The token is in the
 * child's environment only; the caller redacts the result with the run's secrets.
 *
 * @param {{
 *   url: string, team: string, token: string, lines?: number, timeoutMs?: number,
 *   run?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv, timeout: number }) => { stdout?: string | null, error?: Error },
 * }} options
 */
export function vercelLogExcerpt({
  url,
  team,
  token,
  lines = 5,
  timeoutMs = 60_000,
  run = (command, args, options) =>
    spawnSync(command, args, { ...options, encoding: 'utf8', maxBuffer: 1 << 20 }),
}) {
  const result = run('vercel', ['logs', url, '--scope', team], {
    env: { ...process.env, VERCEL_TOKEN: token },
    timeout: timeoutMs,
  });
  // A timeout is the expected end of a stream: `error` is set, `stdout` holds what arrived.
  const matched = (result.stdout ?? '')
    .split(/\r?\n/u)
    .filter((line) => /error|invalid|throw|refus|fail/iu.test(line))
    .slice(-lines)
    .join(' | ')
    .slice(0, 1_000);
  if (matched !== '') return matched;
  return `(no runtime log excerpt: ${result.error === undefined ? 'no error lines' : result.error.message.slice(0, 120)})`;
}

/**
 * `error` extended with the Vercel runtime-log excerpt of each deployment in `targets`
 * (`[label, url]` pairs), the cause chain kept. The caller redacts the message with the run's secrets.
 *
 * @param {unknown} error
 * @param {{ targets: [string, string][], team: string, token: string, run?: Parameters<typeof vercelLogExcerpt>[0]['run'] }} options
 */
export function withVercelLogs(error, { targets, team, token, run }) {
  const logs = targets.map(
    ([label, url]) =>
      `${label} log: ${vercelLogExcerpt({ url, team, token, ...(run === undefined ? {} : { run }) })}`,
  );
  return new Error(
    `${error instanceof Error ? error.message : String(error)} — ${logs.join(' — ')}`,
    {
      cause: error,
    },
  );
}

async function main() {
  const lane = LANES.find((candidate) => candidate.id === process.env['LJ_LANE']);
  if (lane === undefined)
    throw new Error(`LJ_LANE must be one of ${LANES.map((l) => l.id).join(', ')}`);
  const runId = process.env['LJ_RUN_ID'] ?? process.env['GITHUB_RUN_ID'] ?? String(Date.now());
  process.env['GITHUB_RUN_ID'] = runId;
  const names = resourceNames(lane, runId);
  const write = resultsWriter(
    lane.id,
    writeFileSync,
    path.resolve(process.env['LJ_RESULTS'] ?? 'results.json'),
  );
  let failed = false;
  const record = (
    /** @type {string} */ id,
    /** @type {string} */ outcome,
    /** @type {string | undefined} */ detail,
  ) => {
    if (outcome === 'fail') failed = true;
    write(id, outcome, detail);
  };

  /** @type {string[]} */
  const secrets = [];
  /**
   * What the chapters hand one another; each field is set by the chapter that runs first, and
   * `runChapters` stops at a failure, so a later chapter never reads an unset one. The bridge
   * fields exist on the Cloudflare sandbox lane only.
   *
   * @typedef {{
   *   npmUrl: string, home: string, evidence: string, userEnv: NodeJS.ProcessEnv,
   *   images: { overrides: Record<string, string>, toolHost: string, egressProxy: string },
   *   created: import('../build-deploy-journey/journey.e2e.mjs').CreatedProject,
   *   controlUrl: string, frontendUrl: string, workersSubdomain: string,
   *   bridgeUrl?: string, bridgeSecret?: string, stateEnv: Record<string, string>,
   *   providerUrl: string, providerKey: string,
   *   client: StackClient, apiKey: string, workspaceId?: string, declared: string, agentId: string,
   *   pushRefused?: string,
   * }} JourneyState
   */
  const s = /** @type {JourneyState} */ ({});
  const work = path.resolve(
    process.env['LJ_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'lightweight-journey-')),
  );
  const npmPort = positiveIntegerVariable('BD_NPM_PORT', 4873, { max: 65_535 });
  const registryPort = positiveIntegerVariable('BD_REGISTRY_PORT', 5000, { max: 65_535 });
  const deadline = Date.now() + positiveIntegerVariable('BD_PREPARE_TIMEOUT_MS', 45 * 60_000);
  /** @type {null | (() => Promise<void>)} */
  let removeBridge = null;
  let prepared = false;

  const hidden = () => lane.credentials.map((name) => process.env[name] ?? '').concat(secrets);
  // Shadows the shared `check`: every line this journey prints is redacted with what it holds.
  const check = redactingCheck(hidden);
  /**
   * An answer's credentials are registered the moment it arrives, before any line can print it,
   * so the order of the `secrets.push` calls below does not decide what the log shows.
   *
   * @template {{ json: unknown }} T @param {T} answer @returns {T}
   */
  const remember = (answer) => {
    secrets.push(...responseSecrets(answer.json));
    return answer;
  };
  const ask = (/** @type {string} */ url, /** @type {Parameters<typeof call>[1]} */ init) =>
    call(url, init).then(remember);

  const sandboxDriver = lane.sandbox === 'e2b' ? 'external' : lane.sandbox;
  const control = () => s['controlUrl'];
  /** `error` with the control plane's and the manager's redacted-by-the-caller Vercel log excerpts. */
  const controlPlaneLogs = (/** @type {unknown} */ error) => {
    secrets.push(process.env['VERCEL_TOKEN'] ?? '');
    return withVercelLogs(error, {
      targets: [
        ['control plane', control()],
        ['manager', `https://${names.project}-manager.vercel.app`],
      ],
      team: process.env['VERCEL_TEAM_ID'] ?? '',
      token: process.env['VERCEL_TOKEN'] ?? '',
    });
  };
  const bearer = () => ({
    ...s['userEnv'],
    AGENT_WORKSPACE_URL: control(),
    AGENT_WORKSPACE_API_KEY: s['apiKey'],
  });
  const frontendDir = () => path.join(s['created'].project, 'web');

  const steps = {
    async create() {
      const shell = journeyShell({ work, npmPort });
      Object.assign(s, shell);
      prepared = true;
      await preparePackages({ work, npmPort, npmUrl: shell.npmUrl, deadline });
      startRegistry(registryPort);
      const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
      s['images'] = buildJourneyImages({
        registry: `localhost:${String(registryPort)}`,
        revision: git.status === 0 ? git.stdout.trim() : 'unknown',
        deadline,
      });
      remainingBefore(deadline);
      s['created'] = createSupportProject({ work, name: names.project, userEnv: shell.userEnv });
    },

    async eval() {
      // Only the `aw deploy` lane has a project file environment; its url is the project's.
      const production =
        lane.deploy === 'aw'
          ? `  production:\n    target: vercel\n    url: https://${names.project}.vercel.app\n`
          : '';
      await evaluateScripted({
        created: s['created'],
        userEnv: s['userEnv'],
        evidence: s['evidence'],
        production,
        // Every lane runs the same tool, with no declared network: E2B runs a tool sandbox with
        // network none or open only (ADR-0132), and this journey asserts no egress.
        tool: { declaration: OFFLINE_DECLARATION, runFile: OFFLINE_RUN_FILE },
      });
    },

    async deploy() {
      if (lane.host === 'vercel') {
        s['controlUrl'] = `https://${names.project}.vercel.app`;
        s['frontendUrl'] = `https://${names.project}-web.vercel.app`;
      } else {
        const account = encodeURIComponent(process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '');
        const subdomain = await ask(`${CLOUDFLARE}/accounts/${account}/workers/subdomain`, {
          token: process.env['CLOUDFLARE_API_TOKEN'] ?? '',
        });
        const name = subdomain.json?.result?.subdomain;
        check(
          typeof name === 'string',
          `the account has a workers.dev subdomain (HTTP ${String(subdomain.status)})`,
        );
        s['workersSubdomain'] = name;
        s['controlUrl'] = `https://${names.project}-control-plane.${name}.workers.dev`;
        s['frontendUrl'] = `https://${names.project}-web.${name}.workers.dev`;
      }
      const { project, agentPath, rendered } = s['created'];
      // The frontend, and the allowed origin the hosted surface and the widget answer.
      mkdirSync(frontendDir(), { recursive: true });
      for (const [file, text] of Object.entries(frontendFiles()))
        writeFileSync(path.join(frontendDir(), file), text);
      const surface = path.join(project, 'surfaces/main.ts');
      const before = readFileSync(surface, 'utf8');
      const after = before.replace(
        /^( *)name: 'main',$/mu,
        `$1name: 'main',\n$1allowedOrigins: ['${s['frontendUrl']}'],`,
      );
      check(after !== before, 'the main surface lists the frontend origin');
      writeFileSync(surface, after);
      writeFileSync(agentPath, agentWithTool(rendered, "'anthropic default'"));

      s['providerKey'] = `sk-ant-journey-fake-${randomBytes(6).toString('hex')}`;
      secrets.push(s['providerKey']);
      if (lane.host === 'vercel') {
        check(
          missingVariables(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], process.env)
            .length === 0,
          `${lane.id} deploys its fake provider Worker with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID`,
        );
        secrets.push(process.env['CLOUDFLARE_API_TOKEN'] ?? '');
      }
      s['providerUrl'] = await deployFakeProvider({
        workerName: names.fakeProvider,
        key: s['providerKey'],
      });

      // A branch of the Neon project is this run's database; teardown deletes it by name.
      const neon = await ask(
        `${NEON}/projects/${encodeURIComponent(process.env['NEON_PROJECT_ID'] ?? '')}/branches`,
        {
          method: 'POST',
          token: process.env['NEON_API_KEY'] ?? '',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            branch: { name: names.neonBranch },
            endpoints: [{ type: 'read_write' }],
          }),
        },
      );
      const databaseUrl = neon.json?.connection_uris?.[0]?.connection_uri;
      check(
        typeof databaseUrl === 'string',
        `a Neon branch was created (HTTP ${String(neon.status)})`,
      );
      secrets.push(databaseUrl);

      if (lane.sandbox === 'cloudflare-sandbox') {
        const bridge = await deployBridge({
          image: pushRuntimeImage(
            digestReference(s['images'].overrides['AW_RUNTIME_IMAGE'] ?? ''),
            process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '',
          ),
          gatewayHost: `${names.project}-gateway.${s['workersSubdomain']}.workers.dev`,
          secrets,
          workerName: names.bridgeWorker,
        });
        removeBridge = bridge.remove;
        secrets.push(bridge.bridgeSecret);
        s['bridgeUrl'] = bridge.bridgeUrl;
        s['bridgeSecret'] = bridge.bridgeSecret;
      }

      const env = {
        ...s['userEnv'],
        ...s['images'].overrides,
        AGENT_WORKSPACE_SOURCE: ROOT,
        AGENT_WORKSPACE_PROJECT_NAME: names.project,
        AGENT_WORKSPACE_FRONTEND: frontendDir(),
        CONTROL_PLANE_URL: s['controlUrl'],
        ...(lane.host === 'cloudflare'
          ? { CLOUDFLARE_WORKERS_SUBDOMAIN: s['workersSubdomain'] }
          : {}),
        ...(s['bridgeUrl'] === undefined ? {} : { CLOUDFLARE_SANDBOX_BRIDGE_URL: s['bridgeUrl'] }),
      };
      const longRun = { env, timeout: 1_800_000 };
      const bin = (/** @type {string} */ name) => path.join(project, 'node_modules/.bin', name);
      let stateEnvFile;
      /** @type {Record<string, string>} */
      const entries = { DATABASE_URL: databaseUrl };
      if (lane.sandbox === 'vercel-sandbox') {
        secrets.push(process.env['VERCEL_TOKEN'] ?? '');
        entries['VERCEL_SANDBOX_RUNTIME_IMAGE'] = await pushVercelSandboxImage({
          reference: digestReference(s['images'].overrides['AW_RUNTIME_IMAGE'] ?? ''),
          team: process.env['VERCEL_TEAM_ID'] ?? '',
          token: process.env['VERCEL_TOKEN'] ?? '',
          project: names.project,
        });
      }
      if (lane.sandbox === 'e2b') {
        const apiKey = process.env['E2B_API_KEY'] ?? '';
        const [runtimeTemplate, toolHostTemplate] = await Promise.all([
          // The journey proves the commit under test, so the runtime template is built from this
          // checkout (`runtime.Dockerfile`), not taken from the released image the variable pins.
          // `<template>:<build_id>`: the production E2B manager refuses an OCI digest.
          buildTemplate({
            apiKey,
            name: `${RUNTIME_TEMPLATE_PREFIX}-${lane.key}`,
            ...runtimeBuild(ROOT),
            ...builderResources({}),
          }),
          // The tool host is built from this checkout too: a pinned template of an older build
          // can disagree with this commit's manager on the tool host's `/mcp` and token files.
          buildTemplate({
            apiKey,
            name: `${TOOL_HOST_TEMPLATE_PREFIX}-${lane.key}`,
            ...toolHostBuild(ROOT),
            ...builderResources({}),
          }),
        ]);
        Object.assign(entries, {
          EXTERNAL_PROVIDER: 'e2b',
          E2B_API_KEY: apiKey,
          E2B_RUNTIME_TEMPLATE: runtimeTemplate,
          E2B_TOOL_HOST_TEMPLATE: toolHostTemplate,
        });
        secrets.push(entries['E2B_API_KEY'] ?? '');
      }
      // `aw deploy` writes the project's policy ceiling; the profile path does not, so a hosted
      // deployment would have no promotion bar for the gate chapter to be refused by.
      if (lane.deploy === 'profile') {
        entries['AW_DEPLOYMENT_POLICY'] = `'${JOURNEY_DEPLOYMENT_POLICY}'`;
      }
      // Without an R2 key pair the control plane installs no skills, files or session-state API.
      Object.assign(entries, storageEntries(lane.key, process.env));
      secrets.push(
        entries['OBJECT_STORAGE_ACCESS_KEY_ID'] ?? '',
        entries['OBJECT_STORAGE_SECRET_ACCESS_KEY'] ?? '',
      );
      if (lane.host === 'vercel') {
        // `aw deploy --target vercel` reaches the bucket through R2's S3 endpoint and, unlike
        // `--target cloudflare`, does not create the bucket.
        const account = process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '';
        const bucket = laneBucket(lane.key);
        entries['AWS_REGION'] = 'auto';
        const created = await ask(
          `${CLOUDFLARE}/accounts/${encodeURIComponent(account)}/r2/buckets`,
          {
            method: 'POST',
            token: process.env['CLOUDFLARE_API_TOKEN'] ?? '',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: bucket }),
          },
        );
        // 409 is a bucket that exists (a lane reuses its bucket across runs).
        check(
          created.status === 200 || created.status === 409,
          `the R2 bucket ${bucket} exists (HTTP ${String(created.status)})`,
        );
      }
      if (s['bridgeUrl'] !== undefined) {
        Object.assign(entries, {
          CLOUDFLARE_SANDBOX_BRIDGE_URL: s['bridgeUrl'],
          CLOUDFLARE_SANDBOX_BRIDGE_SECRET: s['bridgeSecret'],
        });
      }

      if (lane.deploy === 'aw') {
        spawnChecked(
          bin('aw'),
          ['deploy', 'production', '--plan'],
          { cwd: project, ...longRun },
          3,
        );
        stateEnvFile = path.join(
          s['home'],
          '.config/agent-workspace/deployments',
          names.project,
          'production/.env',
        );
        writeFileSync(stateEnvFile, setDotEnv(readFileSync(stateEnvFile, 'utf8'), entries));
        spawnChecked(bin('aw'), ['deploy', 'production', '--yes'], { cwd: project, ...longRun });
      } else {
        const directory = path.join(work, 'deploy', names.project);
        mkdirSync(path.dirname(directory), { recursive: true });
        spawnChecked(bin('create-agent-workspace'), [directory, '--cloud', lane.host], {
          cwd: work,
          env,
        });
        if (lane.sandbox === 'e2b') {
          const profile = path.join(directory, 'agent-workspace.yaml');
          const yaml = readFileSync(profile, 'utf8');
          check(
            /(runtime:\s*\n\s*default:\s*)\S+/u.test(yaml),
            'the profile names a default runtime driver',
          );
          writeFileSync(profile, yaml.replace(/(runtime:\s*\n\s*default:\s*)\S+/u, '$1external'));
          spawnChecked(bin('agent-workspace'), ['render', directory], { cwd: work, env });
        }
        stateEnvFile = path.join(directory, '.env');
        writeFileSync(stateEnvFile, setDotEnv(readFileSync(stateEnvFile, 'utf8'), entries));
        spawnChecked(
          bin('agent-workspace'),
          ['deploy', directory, '--target', lane.host, '--yes'],
          { cwd: work, ...longRun },
        );
      }
      s['stateEnv'] = parseDotEnv(readFileSync(stateEnvFile, 'utf8'));
      secrets.push(s['stateEnv']['BOOTSTRAP_ADMIN_PASSWORD'] ?? '');
    },

    async configure() {
      const client = new StackClient(control());
      const request = client.request.bind(client);
      client.request = (route, options) => request(route, options).then(remember);
      s['client'] = client;
      try {
        await awaitSetup(control());
      } catch (error) {
        if (lane.host !== 'vercel') throw error;
        secrets.push(process.env['VERCEL_TOKEN'] ?? '');
        const excerpt = vercelLogExcerpt({
          url: control(),
          team: process.env['VERCEL_TEAM_ID'] ?? '',
          token: process.env['VERCEL_TOKEN'] ?? '',
        });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} — runtime log: ${excerpt}`,
          { cause: error },
        );
      }
      // The sandbox provider's credential travels with first-run setup, which stores it as the
      // encrypted `<driver> default` runtime connection and tests the runtime with it (ADR-0088).
      const credential = {
        external: [process.env['E2B_API_KEY'] ?? '', 'https://api.e2b.dev'],
        'vercel-sandbox': [process.env['VERCEL_TOKEN'] ?? '', 'https://api.vercel.com'],
        'cloudflare-sandbox': [s['bridgeSecret'] ?? '', s['bridgeUrl'] ?? ''],
      }[sandboxDriver];
      const setup = await client
        .setup({
          provider: 'anthropic',
          providerApiKey: s['providerKey'],
          providerBaseUrl: s['providerUrl'],
          runtime: sandboxDriver,
          runtimeCredential: credential?.[0],
          runtimeEndpoint: credential?.[1],
          adminEmail: s['stateEnv']['BOOTSTRAP_ADMIN'] ?? '',
          adminPassword: s['stateEnv']['BOOTSTRAP_ADMIN_PASSWORD'] ?? '',
          agentName: 'journey setup agent',
          agentInstructions: 'Answer briefly.',
        })
        .then((answer) => {
          setupAnswered(lane.refusal, answer, check);
          return answer;
        })
        .catch((/** @type {unknown} */ error) => {
          if (lane.host !== 'vercel') throw error;
          // The control plane answers a bare 500; the cause is in its log and in the manager's.
          throw controlPlaneLogs(error);
        });
      const minted = await client.request('/api/api-keys', {
        method: 'POST',
        body: { name: 'lightweight-journey', role: 'admin', expiresAt: null },
      });
      s['apiKey'] = minted.json?.key;
      check(typeof s['apiKey'] === 'string', 'an API key was minted for aw');
      secrets.push(s['apiKey']);
      // The workspace the runner tags this lane's E2B sandboxes with; the end-of-lane sweep finds them by it.
      const me = await client.request('/api/me', { apiKey: s['apiKey'] });
      check(typeof me.json?.workspaceId === 'string', 'aw resolved the workspace the lane runs in');
      s['workspaceId'] = me.json.workspaceId;

      const profile = await client.request('/api/runtime-profiles', {
        method: 'POST',
        body: {
          name: 'journey-sandbox',
          driver: sandboxDriver,
          runtimeConnectionId: setup.json?.runtimeConnectionId,
          networkPolicy: 'none',
          filesystem: 'read-write',
        },
      });
      check(
        profile.status === 201,
        `the runtime profile was created (${String(profile.status)} ${profile.text.slice(0, 200)})`,
      );
      s['declared'] = `journey-declared-${randomBytes(6).toString('hex')}`;
      secrets.push(s['declared']);
      const secret = await client.request('/api/secrets', {
        method: 'POST',
        body: { name: DECLARED_SECRET, value: s['declared'] },
      });
      check(secret.status === 201, `the declared secret was set (${String(secret.status)})`);

      if (lane.pushRefusal !== undefined) {
        // The push exits 1 with problem lines; the chapters that need the agent record the proof.
        s['pushRefused'] = refusedPush(
          lane.pushRefusal,
          s['created'].aw(['push', '--yes'], bearer(), 1),
          check,
        );
        return s['pushRefused'];
      }
      s['created'].aw(['push', '--yes'], bearer());
      const agents = (await client.request('/api/agents')).json?.agents ?? [];
      const agent = agents.find(
        (/** @type {{ name: string }} */ a) => a.name === s['created'].agentName,
      );
      check(agent !== undefined, 'aw push created the agent on the deployment');
      s['agentId'] = agent.id;
      const attached = await client.request(`/api/agents/${agent.id}`, {
        method: 'PATCH',
        body: { runtimeProfileId: profile.json?.id },
      });
      check(
        attached.status === 200,
        `the runtime profile was attached (${String(attached.status)})`,
      );
    },

    async gate() {
      if (s['pushRefused'] !== undefined) return s['pushRefused'];
      try {
        promotePastGate({
          created: s['created'],
          remote: bearer(),
          evidence: s['evidence'],
          refusal: true,
        });
      } catch (error) {
        // A run the control plane could not prepare is explained in its log, not in `aw eval`.
        throw lane.host === 'vercel' ? controlPlaneLogs(error) : error;
      }
    },

    async 'chat-api'() {
      if (s['pushRefused'] !== undefined) return s['pushRefused'];
      const nonce = chatNonce();
      const started = await s['client'].request(`/api/agents/${s['agentId']}/runs`, {
        method: 'POST',
        body: {
          prompt: `Look up order ${nonce} with your order tool and repeat the tool output exactly.`,
        },
      });
      if (lane.refusal !== undefined) {
        return refusedRun(
          lane.refusal,
          started,
          () => s['client'].runFrames(started.json.run.id),
          check,
        );
      }
      check(
        started.status === 202,
        `the run was accepted (${String(started.status)} ${started.text.slice(0, 200)})`,
      );
      const frames = await s['client'].runFrames(started.json.run.id);
      const completed = terminalStatus(frames) === 'completed';
      check(
        completed,
        `the run completed (${JSON.stringify(frames.slice(-3))}; ${completed ? '' : await failedRunDetail(s['client'], started.json.run.id, secrets)})`,
      );
      const reply = assistantText(frames);
      check(reply.includes(`order-data-${nonce}`), "the reply carries the code tool's data");
      check(reply.includes(`declared=${s['declared']}`), 'the tool read the secret it declared');
    },

    async 'hosted-chat'() {
      if (s['pushRefused'] !== undefined) return s['pushRefused'];
      const page = await ask(`${control()}/p/s/${SURFACE}`);
      check(page.status === 200, `the hosted chat page answered ${String(page.status)}`);
      const session = await ask(`${control()}/p/s/${SURFACE}/sessions`, {
        method: 'POST',
        headers: { origin: control(), 'content-type': 'application/json' },
        body: '{}',
      });
      check(
        session.status === 201 && typeof session.json?.token === 'string',
        `a visitor session opened (${String(session.status)} ${session.text.slice(0, 200)})`,
      );
      secrets.push(session.json.token);
      check(
        typeof session.json.sessionId === 'string' && session.json.sessionId !== '',
        'the visitor session names its id',
      );
      const started = await ask(`${control()}/api/agents/${s['agentId']}/runs`, {
        method: 'POST',
        token: session.json.token,
        headers: { origin: control(), 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Say hello.', sessionId: session.json.sessionId }),
      });
      if (lane.refusal !== undefined) {
        return refusedRun(
          lane.refusal,
          started,
          () => s['client'].runFrames(started.json.run.id, { apiKey: session.json.token }),
          check,
        );
      }
      check(
        started.status === 202,
        `the visitor's run was accepted (${String(started.status)} ${started.text.slice(0, 200)})`,
      );
      const frames = await s['client'].runFrames(started.json.run.id, {
        apiKey: session.json.token,
      });
      const completed = terminalStatus(frames) === 'completed';
      check(
        completed,
        `the visitor run completed (${completed ? '' : await failedRunDetail(s['client'], started.json.run.id, secrets, session.json.token)})`,
      );
    },

    async widget() {
      if (s['pushRefused'] !== undefined) return s['pushRefused'];
      const script = await ask(`${control()}/p/s/${SURFACE}/widget.js`);
      check(
        script.status === 200 && script.text.length > 0,
        `widget.js answered ${String(script.status)}`,
      );
      const session = await ask(`${control()}/p/s/${SURFACE}/sessions`, {
        method: 'POST',
        headers: { origin: s['frontendUrl'], 'content-type': 'application/json' },
        body: '{}',
      });
      check(
        session.status === 201,
        `a session opened from the frontend origin (${String(session.status)} ${session.text.slice(0, 200)})`,
      );
      const refused = await ask(`${control()}/p/s/${SURFACE}/sessions`, {
        method: 'POST',
        headers: { origin: 'https://not-allowed.example', 'content-type': 'application/json' },
        body: '{}',
      });
      check(
        refused.status >= 400,
        `a session from another origin was refused (${String(refused.status)})`,
      );

      // The lanes with no agent returned above, so a turn is expected to run here.
      const visitor = { apiKey: session.json.token };
      await frontendTurn({
        control: control(),
        origin: s['frontendUrl'],
        nonce: chatNonce(),
        session: session.json,
        ask,
        framesOf: (id) => s['client'].runFrames(id, visitor),
        detailOf: (id) => failedRunDetail(s['client'], id, secrets, visitor.apiKey),
        report: check,
      });
    },

    async frontend() {
      const page = await ask(s['frontendUrl']);
      check(page.status === 200, `the frontend answered ${String(page.status)}`);
      check(page.text.includes(control()), 'the frontend was built against the control plane url');
    },

    async rollback() {
      if (s['pushRefused'] !== undefined) return s['pushRefused'];
      const { aw, agentPath, agentName } = s['created'];
      const remote = bearer();
      const versions = () => JSON.parse(aw(['versions', '--json'], remote));
      const production = () =>
        versions().pointers.find(
          (/** @type {{ environment: string }} */ p) => p.environment === 'production',
        )?.number;
      const first = production();
      const source = readFileSync(agentPath, 'utf8');
      const instructions = /^( {2}instructions: ')(.*)(',)$/mu;
      check(instructions.test(source), 'the agent file has one-line instructions to change');
      writeFileSync(agentPath, source.replace(instructions, '$1$2 Mention the order number.$3'));
      aw(['push', '--yes'], remote);
      promotePastGate({ created: s['created'], remote, evidence: s['evidence'], refusal: false });
      const second = production();
      check(
        second !== first,
        `a second version is in production (${String(first)} then ${String(second)})`,
      );
      aw(['rollback', agentName, '--yes'], remote);
      check(production() === first, 'aw rollback moved production back to the first version');
    },
  };

  /** Success or failure, the lane ends with none of its E2B sandboxes alive (issue #832). */
  async function sweepE2bSandboxes() {
    const workspaceId = s['workspaceId'];
    try {
      // Without its workspace the lane cannot list what it created, so it fails rather than pass
      // with sandboxes it never looked for.
      check(
        typeof workspaceId === 'string',
        'the lane knows its workspace, so its E2B sandboxes can be swept',
      );
      const { after } = await killLaneSandboxes({
        apiKey: process.env['E2B_API_KEY'] ?? '',
        workspaceId: String(workspaceId),
        log: (line) => console.log(redact(line, hidden())),
      });
      if (after !== 0)
        throw new Error(`${String(after)} E2B sandboxes of this lane are still alive`);
    } catch (error) {
      console.error(redact(error instanceof Error ? error.message : String(error), hidden()));
      process.exitCode = 1;
    }
  }

  try {
    await runChapters(lane, process.env, steps, record, () => secrets);
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (removeBridge !== null) await removeBridge().catch(() => {});
    if (lane.sandbox === 'e2b') await sweepE2bSandboxes();
    if (prepared) {
      stopRegistry();
      stopPackages();
    }
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
