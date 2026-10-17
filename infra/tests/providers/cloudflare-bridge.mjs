/**
 * Deploys the bridge Worker of `infra/cloudflare/sandbox-bridge` to a throwaway name for the
 * Cloudflare lane and deletes it afterwards (ADR-0120 LC1-LC4). The Cloudflare token reaches
 * wrangler through the environment only, never argv; `BRIDGE_SECRET` goes through stdin; every
 * failure message carries the redacted tail of the command's output. Order: sweep this lane's
 * stale leftovers (only when the caller asks, see `isLeftover`), deploy, secret, then a wait for the bridge's own 401 before the lane's first create.
 *
 * The Containers applications are named after the `name` in `wrangler.jsonc` (`--name` renames the
 * Worker only), so the deployed copy carries the per-run name, and teardown deletes the
 * applications as well as the Worker; a refused deletion throws.
 *
 * Vendor facts: Wrangler deploy/delete and `--name`
 * (https://developers.cloudflare.com/workers/wrangler/commands/, checked 2026-10-08); a new
 * workers.dev route takes a moment to be served
 * (https://developers.cloudflare.com/workers/configuration/routing/workers-dev/, checked 2026-10-09);
 * list/delete of Containers applications and Worker scripts
 * (https://developers.cloudflare.com/api/resources/containers/subresources/applications/, checked 2026-10-09).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redact } from './support.mjs';

export const WRANGLER = 'wrangler@4.147.0';
const CONTAINERS_PACKAGE = '@cloudflare/containers@0.3.7';
const DIGEST_PINNED_IMAGE = /^[\w.\-/:]+@sha256:[0-9a-f]{64}$/u;
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
/** Every name this lane creates starts with this; nothing else on the account may match it. */
export const BRIDGE_PREFIX = 'agent-workspace-sandbox-bridge-';
const CONFIG_NAME_FIELD = '"name": "agent-workspace-sandbox-bridge",';
const bridgeSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../cloudflare/sandbox-bridge',
);

/** Waits before each retry of a wrangler step that just created a Worker: 17 s in all. */
export const WORKER_PROPAGATION_DELAYS_MS = [2_000, 5_000, 10_000];

/**
 * Wrangler's error 10007 right after a successful upload: Cloudflare's API has not caught up with
 * the Worker it just created, and the same call succeeds a moment later. Nothing else is retried.
 */
export const isWorkerPropagating = (/** @type {unknown} */ error) =>
  /\[code: 10007\]/u.test(error instanceof Error ? error.message : String(error));

/**
 * Runs `step` (an idempotent wrangler call that throws with the output) again after each delay
 * while it fails with 10007; any other error, or the last delay spent, rethrows the step's own error.
 *
 * @template T
 * @param {() => T} step
 * @param {{ delaysMs?: readonly number[], sleep?: (ms: number) => Promise<unknown> }} [options]
 * @returns {Promise<T>}
 */
export async function retryWorkerPropagation(
  step,
  { delaysMs = WORKER_PROPAGATION_DELAYS_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  for (const delayMs of delaysMs) {
    try {
      return await step();
    } catch (error) {
      if (!isWorkerPropagating(error)) throw error;
      process.stderr.write(`wrangler error 10007 (the Worker is not visible yet); running the step again in ${String(delayMs / 1_000)}s\n`);
      await sleep(delayMs);
    }
  }
  return step();
}

/** One name per run and attempt, so two runs (or a re-run) never share a Worker or application. */
export function bridgeWorkerName(env = process.env) {
  const run = env.GITHUB_RUN_ID ?? '';
  const attempt = env.GITHUB_RUN_ATTEMPT ?? '1';
  if (!/^\d*$/u.test(run) || !/^\d+$/u.test(attempt)) throw new Error('GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be digits');
  const unique = run === '' ? `local-${randomBytes(4).toString('hex')}` : `${run}-${attempt}`;
  return `${BRIDGE_PREFIX}ci-${unique}`;
}

/** The leftover filter: this lane's exact prefix, never another name on the account. */
export const isLaneName = (name) => typeof name === 'string' && name.startsWith(BRIDGE_PREFIX);

/** The Worker `workerName` and its Containers applications (`<workerName>-<class>`), nothing longer-named. */
export const ownedBy = (workerName) => (name) => name === workerName || name.startsWith(`${workerName}-`);

/**
 * A leftover is only swept once it is older than any run that could still use it: providers-live
 * and lightweight-journey share the prefix under different concurrency groups (timeouts 45 and 120
 * minutes), so a younger name may belong to a run in flight.
 */
export const LEFTOVER_AGE_MS = 4 * 60 * 60 * 1_000;

/**
 * The sweep filter: a lane name, not this deployment's own, whose latest creation/modification time
 * in the list entry is older than `LEFTOVER_AGE_MS`. An entry without a parseable time is kept.
 */
export function isLeftover(workerName, now = Date.now()) {
  const own = ownedBy(workerName);
  return (name, item) => {
    if (!isLaneName(name) || own(name)) return false;
    const times = ['created_on', 'modified_on', 'created_at', 'updated_at']
      .map((field) => (typeof item?.[field] === 'string' ? Date.parse(item[field]) : Number.NaN))
      .filter((time) => Number.isFinite(time));
    return times.length > 0 && now - Math.max(...times) > LEFTOVER_AGE_MS;
  };
}

/** The deployed copy of `wrangler.jsonc`: images, gateway host and the per-run Worker/application name. */
export function renderConfig(text, { image, gatewayHost, workerName }) {
  if (!text.includes(CONFIG_NAME_FIELD)) throw new Error('sandbox-bridge wrangler.jsonc no longer has the expected name field');
  return text
    .replace(CONFIG_NAME_FIELD, `"name": "${workerName}",`)
    .replaceAll('REPLACE_RUNTIME_IMAGE', image)
    .replaceAll('REPLACE_GATEWAY_HOST', gatewayHost);
}

const MAX_LIST_PAGES = 100;

/** The query for the page after `info` (`?cursor=` or `?page=`), or `undefined` on the last page. */
function nextPage(info) {
  if (typeof info?.cursor === 'string' && info.cursor !== '') return `?cursor=${encodeURIComponent(info.cursor)}`;
  const { page, total_pages: totalPages } = info ?? {};
  return Number.isInteger(page) && Number.isInteger(totalPages) && page < totalPages ? `?page=${String(page + 1)}` : undefined;
}

/**
 * Deletes the Containers applications, then the Worker scripts, whose name `owns(name, entry)` accepts
 * (a 404 is already gone). Every list page is read (cursor or page number from `result_info`) before
 * anything is deleted. Returns `[kind, name]` pairs. A refused deletion or an unreadable list throws, naming
 * only the kind, the resource name and the HTTP status, never a token or a response body.
 */
export async function deleteBridgeResources({ accountId, token, owns, fetch = globalThis.fetch }) {
  const account = `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}`;
  const headers = { authorization: `Bearer ${token}` };
  const call = (url, method) => fetch(url, { method, headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const removed = [];
  const failures = [];
  for (const [kind, listPath, deletePath, nameOf, idOf] of [
    ['container application', 'containers/applications', 'containers/applications/', (item) => item.name, (item) => item.id],
    ['worker', 'workers/scripts', 'workers/scripts/', (item) => item.id, (item) => item.id],
  ]) {
    const items = [];
    let query = '';
    try {
      for (let page = 0; query !== undefined; page += 1) {
        if (page === MAX_LIST_PAGES) throw new Error(`more than ${String(MAX_LIST_PAGES)} pages`);
        const response = await call(`${account}/${listPath}${query}`, 'GET');
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
        const body = await response.json();
        if (Array.isArray(body?.result)) items.push(...body.result);
        query = nextPage(body?.result_info);
      }
    } catch (error) {
      failures.push(`list ${kind}s: ${error instanceof Error && /^(HTTP \d+|more than \d+ pages)$/u.test(error.message) ? error.message : 'request failed'}`);
      continue;
    }
    for (const item of items) {
      const name = nameOf(item);
      const id = idOf(item);
      if (typeof name !== 'string' || typeof id !== 'string' || !owns(name, item)) continue;
      try {
        const response = await call(`${account}/${deletePath}${encodeURIComponent(id)}${kind === 'worker' ? '?force=true' : ''}`, 'DELETE');
        if (response.ok || response.status === 404) removed.push([kind, name]);
        else failures.push(`delete ${kind} ${name}: HTTP ${String(response.status)}`);
      } catch {
        failures.push(`delete ${kind} ${name}: request failed`);
      }
    }
  }
  if (failures.length > 0) throw new Error(`Cloudflare bridge cleanup failed: ${failures.join('; ')}`);
  return removed;
}

/** The deployed Worker's own workers.dev origin, never another Worker's URL printed in the output. */
export function workersDevUrl(output, workerName) {
  const escaped = workerName.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const url = new RegExp(`https://${escaped}\\.[A-Za-z0-9-]+\\.workers\\.dev`, 'u').exec(output)?.[0];
  if (url === undefined) throw new Error(`wrangler deploy printed no workers.dev URL for ${workerName}`);
  return url;
}

/**
 * Waits until the deployed bridge itself answers. A new script's workers.dev route answers the
 * edge's 404 until it propagates, and the bridge answers 503 until the new BRIDGE_SECRET version is
 * live; an unauthenticated create answering 401 `{"error":"unauthorized"}` proves the route, this
 * script and the secret at once and touches no sandbox. A timeout throws (the lane fails, never
 * skips) and names only the status and the bridge's fixed error code, never body text.
 */
export async function waitForBridge(
  bridgeUrl,
  { fetch = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = 180_000, intervalMs = 5_000 } = {},
) {
  const started = Date.now();
  let last = 'no answer';
  for (;;) {
    try {
      const response = await fetch(`${bridgeUrl}/v1/sandboxes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      const code = await response.json().then(
        (body) => (typeof body?.error === 'string' && /^[a-z_]{1,40}$/u.test(body.error) ? body.error : undefined),
        () => undefined,
      );
      if (response.status === 401 && code === 'unauthorized') return;
      last = `${String(response.status)} ${code === undefined ? 'not the bridge' : `bridge:${code}`}`;
    } catch {
      last = 'network error';
    }
    if (Date.now() - started + intervalMs > timeoutMs) {
      throw new Error(
        `bridge Worker not reachable at ${bridgeUrl} after ${String(Math.round(timeoutMs / 1_000))}s: last answer ${last}`,
      );
    }
    await sleep(intervalMs);
  }
}

/** @returns {Promise<{ bridgeUrl: string; bridgeSecret: string; remove: () => Promise<void> }>} */
export async function deployBridge({
  image,
  gatewayHost,
  secrets,
  workerName = bridgeWorkerName(),
  sweepLeftovers = false,
  fetch = globalThis.fetch,
}) {
  // Spliced into wrangler.jsonc, so anything but a digest-pinned reference is refused first.
  if (!DIGEST_PINNED_IMAGE.test(image)) {
    throw new Error('CLOUDFLARE_PROBE_IMAGE must be an image reference pinned by digest');
  }
  const bridgeSecret = randomBytes(36).toString('base64url');
  const hidden = [...secrets, bridgeSecret];
  if (!isLaneName(workerName)) throw new Error(`the bridge Worker name must start with ${BRIDGE_PREFIX}`);
  const { CLOUDFLARE_API_TOKEN: token = '', CLOUDFLARE_ACCOUNT_ID: accountId = '' } = process.env;
  if (token === '' || accountId === '') throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required to deploy the bridge');
  const cleanup = (owns) => deleteBridgeResources({ accountId, token, owns, fetch });
  const work = await mkdtemp(path.join(tmpdir(), 'cf-bridge-'));

  const run = (command, args, input) => {
    const result = spawnSync(command, args, {
      cwd: work,
      encoding: 'utf8',
      env: process.env,
      ...(input === undefined ? {} : { input }),
      timeout: 600_000,
    });
    const output = redact(`${result.stdout}\n${result.stderr}`, hidden);
    if (result.status !== 0) {
      throw new Error(`${args[0] ?? command} ${args[1] ?? ''} failed: ${output.slice(-2_000)}`);
    }
    return output;
  };
  const wrangler = (args, input) => run('npx', ['--yes', WRANGLER, ...args], input);

  const remove = async () => {
    try {
      await cleanup(ownedBy(workerName));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
  try {
    if (sweepLeftovers) {
      for (const [kind, name] of await cleanup(isLeftover(workerName))) process.stderr.write(`removed leftover ${kind} ${name}\n`);
    }
    await cp(bridgeSource, work, { recursive: true, filter: (file) => !file.includes('node_modules') });
    const config = renderConfig(await readFile(path.join(work, 'wrangler.jsonc'), 'utf8'), { image, gatewayHost, workerName });
    await writeFile(path.join(work, 'wrangler.jsonc'), config);
    await writeFile(path.join(work, 'package.json'), '{"private":true}');
    run('npm', ['install', '--no-save', CONTAINERS_PACKAGE]);
    const deployOutput = await retryWorkerPropagation(() => wrangler(['deploy', '--name', workerName]));
    await retryWorkerPropagation(() => wrangler(['secret', 'put', 'BRIDGE_SECRET', '--name', workerName], bridgeSecret));
    const bridgeUrl = workersDevUrl(deployOutput, workerName);
    await waitForBridge(bridgeUrl);
    return { bridgeUrl, bridgeSecret, remove };
  } catch (error) {
    await remove().catch((cleanupError) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; teardown also failed: ${cleanupError.message}`, { cause: error });
    });
    throw error;
  }
}
