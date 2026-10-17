#!/usr/bin/env node
/* global console, fetch */
/**
 * Deletes what one lane deployed, by the names `resourceNames` derives from the run id and lane, so
 * it works after a journey that died half way and needs no state file. It is idempotent: a 404 is
 * already gone. A deletion that is refused is a leftover; the exit code is 1 then, so a leaked
 * deployment is red rather than silent. Tokens travel in request headers only and never in output.
 *
 *   LJ_LANE=<lane id> LJ_RUN_ID=<run id> node tests/e2e/lightweight-journey/teardown.mjs
 *
 * After this run's own resources, it also deletes the lane's earlier leftovers (a cancelled or
 * timed-out job never reached its teardown): names of exactly this journey's shape, older than
 * `LEFTOVER_AGE_MS`, in the Vercel team, Cloudflare account and Neon project (see `isLeftover`).
 * On Cloudflare, a Vercel lane deletes and sweeps only its `-provider` Worker.
 *
 * E2B sandboxes are not handled here: the journey kills every sandbox its own workspace created
 * before it exits (`e2b-sandboxes.mjs`), found by the runner's `awWorkspace` tag. ponytail: a job
 * cancelled before that leaves its sandboxes to their E2B timeout; images pushed to Cloudflare's
 * registry stay (they are content-addressed and reused).
 */
import path from 'node:path';
import process from 'node:process';

import { isLeftover, LANES, missingVariables, resourceNames } from './lanes.mjs';

const VERCEL = 'https://api.vercel.com';
const CLOUDFLARE = 'https://api.cloudflare.com/client/v4';
const NEON = 'https://console.neon.tech/api/v2';
const MAX_LIST_PAGES = 100;

/** The value under `keys` in parsed JSON, or `undefined` when any step is not an object. */
const get = (/** @type {unknown} */ value, /** @type {string[]} */ ...keys) =>
  keys.reduce(
    (/** @type {unknown} */ at, key) =>
      typeof at === 'object' && at !== null
        ? /** @type {Record<string, unknown>} */ (at)[key]
        : undefined,
    value,
  );

/** @param {unknown} value @returns {Record<string, unknown>[]} */
const records = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'object' && item !== null) : [];

/**
 * @param {{ id: string, key: string, host: string, credentials: readonly string[] }} lane
 * @param {string} runId
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} [request]
 * @returns {Promise<{ removed: string[], leftovers: string[] }>}
 */
export async function teardown(lane, runId, env, request = fetch) {
  const names = resourceNames(lane, runId);
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const leftovers = [];

  /** @param {string} label @param {string} url @param {Record<string, string>} headers */
  async function remove(label, url, headers) {
    try {
      const response = await request(url, { method: 'DELETE', headers });
      if (response.ok || response.status === 404) removed.push(label);
      else leftovers.push(`${label}: HTTP ${String(response.status)}`);
    } catch {
      leftovers.push(`${label}: request failed`);
    }
  }
  /** @param {string} label @param {string} url @param {Record<string, string>} headers */
  async function list(label, url, headers) {
    try {
      const response = await request(url, { headers });
      if (response.ok) return /** @type {unknown} */ (await response.json());
      leftovers.push(`${label}: HTTP ${String(response.status)}`);
    } catch {
      leftovers.push(`${label}: request failed`);
    }
    return undefined;
  }
  /**
   * Every page of a list. `step` reads one page's items and the token for the next, if any.
   * @param {string} label @param {Record<string, string>} headers
   * @param {(cursor: string | undefined) => string} urlFor
   * @param {(body: unknown) => { found: Record<string, unknown>[], next: string | undefined }} step
   */
  async function listAll(label, headers, urlFor, step) {
    /** @type {Record<string, unknown>[]} */
    const items = [];
    /** @type {string | undefined} */
    let cursor;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const body = await list(label, urlFor(cursor), headers);
      if (body === undefined) return items;
      const { found, next } = step(body);
      items.push(...found);
      if (next === undefined || found.length === 0) return items;
      cursor = next;
    }
    leftovers.push(`${label}: more than ${String(MAX_LIST_PAGES)} pages`);
    return items;
  }
  const leftover = isLeftover(lane, runId);

  if (
    lane.host === 'vercel' &&
    missingVariables(['VERCEL_TOKEN', 'VERCEL_TEAM_ID'], env).length === 0
  ) {
    const headers = { authorization: `Bearer ${env['VERCEL_TOKEN']}` };
    for (const name of names.vercelProjects) {
      const team = encodeURIComponent(env['VERCEL_TEAM_ID'] ?? '');
      await remove(
        `vercel project ${name}`,
        `${VERCEL}/v9/projects/${name}?teamId=${team}`,
        headers,
      );
    }
    const team = encodeURIComponent(env['VERCEL_TEAM_ID'] ?? '');
    const projects = await listAll(
      'vercel projects',
      headers,
      (until) =>
        `${VERCEL}/v9/projects?teamId=${team}&search=awlj-&limit=100${until === undefined ? '' : `&until=${until}`}`,
      (body) => {
        const next = get(body, 'pagination', 'next');
        return {
          found: records(get(body, 'projects')),
          next: typeof next === 'number' ? String(next) : undefined,
        };
      },
    );
    for (const project of projects) {
      if (!leftover(project['name'], project)) continue;
      await remove(
        `vercel project ${String(project['name'])}`,
        `${VERCEL}/v9/projects/${encodeURIComponent(String(project['name']))}?teamId=${team}`,
        headers,
      );
    }
  }

  // Every lane deploys the fake provider Worker; a Vercel lane owns nothing else on Cloudflare.
  if (missingVariables(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], env).length === 0) {
    const onCloudflare = lane.host === 'cloudflare';
    const headers = { authorization: `Bearer ${env['CLOUDFLARE_API_TOKEN']}` };
    const account = `${CLOUDFLARE}/accounts/${encodeURIComponent(env['CLOUDFLARE_ACCOUNT_ID'] ?? '')}`;
    const apps = /** @type {{ result?: { id: string, name: string }[] } | undefined} */ (
      onCloudflare
        ? await list('cloudflare containers', `${account}/containers/applications`, headers)
        : undefined
    );
    // The bridge's `SandboxNone`/`SandboxOpen` apps are named after its Worker, which is named by
    // run, so only the lane that deploys it deletes them (see below); the `-` keeps run 42 off 421.
    const ownsBridge = lane.id === 'cloudflare-cloudflare-sandbox';
    for (const app of apps?.result ?? []) {
      if (
        app.name.startsWith(names.project) ||
        (ownsBridge && app.name.startsWith(`${names.bridgeWorker}-`))
      ) {
        await remove(
          `cloudflare container ${app.name}`,
          `${account}/containers/applications/${app.id}`,
          headers,
        );
      }
    }
    // The bridge is named by run, not lane: only the lane that deploys it deletes it, so a sibling
    // lane of the same run that finishes first cannot remove the bridge still in use.
    const ownWorkers = onCloudflare
      ? ownsBridge
        ? [...names.workers, names.bridgeWorker]
        : names.workers
      : [names.fakeProvider];
    for (const name of ownWorkers) {
      await remove(
        `cloudflare worker ${name}`,
        `${account}/workers/scripts/${name}?force=true`,
        headers,
      );
    }
    const scripts = await listAll(
      'cloudflare workers',
      headers,
      (page) => `${account}/workers/scripts${page === undefined ? '' : `?page=${page}`}`,
      (body) => {
        const page = get(body, 'result_info', 'page');
        const pages = get(body, 'result_info', 'total_pages');
        const more =
          Number.isInteger(page) && Number.isInteger(pages) && Number(page) < Number(pages);
        return {
          found: records(get(body, 'result')),
          next: more ? String(Number(page) + 1) : undefined,
        };
      },
    );
    for (const script of scripts) {
      if (!leftover(script['id'], script)) continue;
      await remove(
        `cloudflare worker ${String(script['id'])}`,
        `${account}/workers/scripts/${encodeURIComponent(String(script['id']))}?force=true`,
        headers,
      );
    }
  }

  if (missingVariables(['NEON_API_KEY', 'NEON_PROJECT_ID'], env).length === 0) {
    const headers = { authorization: `Bearer ${env['NEON_API_KEY']}` };
    const project = `${NEON}/projects/${encodeURIComponent(env['NEON_PROJECT_ID'] ?? '')}`;
    const branches = await listAll(
      'neon branches',
      headers,
      (cursor) =>
        `${project}/branches?limit=100${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      (body) => {
        const next = get(body, 'pagination', 'next');
        return {
          found: records(get(body, 'branches')),
          next: typeof next === 'string' && next !== '' ? next : undefined,
        };
      },
    );
    for (const branch of branches) {
      const name = String(branch['name']);
      const guarded = branch['default'] === true || branch['protected'] === true;
      if (name === names.neonBranch || (!guarded && leftover(name, branch))) {
        await remove(
          `neon branch ${name}`,
          `${project}/branches/${encodeURIComponent(String(branch['id']))}`,
          headers,
        );
      }
    }
  }
  return { removed, leftovers };
}

async function main() {
  const lane = LANES.find((candidate) => candidate.id === process.env['LJ_LANE']);
  if (lane === undefined)
    throw new Error(`LJ_LANE must be one of ${LANES.map((l) => l.id).join(', ')}`);
  const runId = process.env['LJ_RUN_ID'] ?? process.env['GITHUB_RUN_ID'] ?? '';
  if (runId === '') throw new Error('LJ_RUN_ID or GITHUB_RUN_ID names the run to tear down');
  const { removed, leftovers } = await teardown(lane, runId, process.env);
  for (const label of removed) console.log(`removed (or already gone): ${label}`);
  for (const leftover of leftovers) console.error(`LEFTOVER: ${leftover}`);
  process.exitCode = leftovers.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
