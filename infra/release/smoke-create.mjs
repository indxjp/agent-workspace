#!/usr/bin/env node
/* global fetch, URL, AbortSignal */
/**
 * The generator smoke against the real registry (#370): does `create --cloud local` resolve every
 * platform image the CLI pins to a digest, anonymously, and write a project?
 *
 * It runs on every PR, so registry state must never fail a change that did not cause it. It first
 * asks the registry, without credentials, about each pinned tag:
 *
 * - every image published: run the built `create` (`packages/cli/dist/create.js`) into a temporary
 *   directory with no image overrides, and require a `.env` that pins each image by digest. Only
 *   this can fail: the images are public and `create` still does not work;
 * - anything else (none or only some published, a package not public yet, a registry that did not
 *   answer after the retries): skip, loudly, with a `::warning::` naming each image's state, the
 *   tag and the workflow that publishes them;
 * - a `ghcr.io` owner that GitHub does not know: fail. That is a wrong `registry` in
 *   `packages/cli/src/release-images.json`, a change to this tree, not registry state.
 *
 *     node infra/release/smoke-create.mjs     # after `pnpm build`
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { IMAGE_NAMESPACE, readReleaseImages } from './images.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** Every registry request: at most this long, and at most this many attempts. */
export const REQUEST_TIMEOUT_MS = 15_000;
export const ATTEMPTS = 3;

/** The `.env` keys `create` writes for the four platform images (`render/env.ts`). */
const ENV_KEYS = {
  web: 'WEB_IMAGE',
  gateway: 'GATEWAY_IMAGE',
  runner: 'RUNNER_IMAGE',
  runtime: 'AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK',
};

/**
 * What one anonymous probe learned about `<repository>:<tag>`:
 *
 * - `published`: the tag resolves;
 * - `unpublished`: the repository is public, the tag is not in it (the version is not released);
 * - `not-public`: the registry refuses an anonymous reader (a private package, or, on GHCR, one
 *   that does not exist: GHCR answers both with 401/403);
 * - `not-found`: the registry says the repository does not exist;
 * - `unreachable`: no usable answer after the retries.
 *
 * @typedef {'published' | 'unpublished' | 'not-public' | 'not-found' | 'unreachable'} ProbeState
 * @typedef {{ fetch?: typeof fetch, sleep?: (milliseconds: number) => Promise<unknown> }} Io
 */

/**
 * What the smoke does with one probe state per image.
 *
 * @param {readonly ProbeState[]} states
 * @returns {'run' | 'skip' | 'fail'}
 */
export function smokeDecision(states) {
  if (states.length === 0) return 'fail';
  return states.every((state) => state === 'published') ? 'run' : 'skip';
}

/** @param {string} header a `WWW-Authenticate: Bearer realm="…",service="…"` value */
export function bearerChallenge(header) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const match of header.matchAll(/([a-z]+)="([^"]*)"/gu)) fields[match[1]] = match[2];
  return fields;
}

/** A registry that gave no usable answer within the retries. */
export class RegistryUnreachable extends Error {}

/**
 * One request with a timeout, retried with backoff on a network error, a timeout, 429 or 5xx.
 * Throws {@link RegistryUnreachable} after the last attempt.
 *
 * @param {string | URL} url
 * @param {RequestInit} init
 * @param {Io} [io]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, init, io = {}) {
  const request = io.fetch ?? fetch;
  const sleep = io.sleep ?? delay;
  let reason = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await request(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status !== 429 && response.status < 500) return response;
      reason = `answered ${String(response.status)}`;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (attempt < ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
  }
  throw new RegistryUnreachable(`${new URL(url).origin} ${reason} (${String(ATTEMPTS)} attempts)`);
}

/**
 * Where `registry/repository:tag` stands for an anonymous reader.
 *
 * @param {string} registry e.g. ghcr.io
 * @param {string} repository e.g. indxjp/agent-workspace/web
 * @param {string} tag
 * @param {Io} [io]
 * @returns {Promise<{ state: ProbeState, detail?: string }>}
 */
export async function probeImage(registry, repository, tag, io = {}) {
  try {
    const manifestUrl = `https://${registry}/v2/${repository}/manifests/${tag}`;
    /** @type {Record<string, string>} */
    const authorization = {};
    let response = await fetchWithRetry(
      manifestUrl,
      { method: 'HEAD', headers: { accept: MANIFEST_TYPES } },
      io,
    );
    if (response.status === 401) {
      const { realm, service } = bearerChallenge(response.headers.get('www-authenticate') ?? '');
      if (!realm) return { state: 'not-public' };
      const tokenUrl = new URL(realm);
      if (service) tokenUrl.searchParams.set('service', service);
      tokenUrl.searchParams.set('scope', `repository:${repository}:pull`);
      const token = await fetchWithRetry(tokenUrl, {}, io);
      if (token.status === 404) return { state: 'not-found' };
      if (!token.ok) return { state: 'not-public' };
      const { token: bearer } = /** @type {{ token?: string }} */ (await token.json());
      if (!bearer) return { state: 'not-public' };
      authorization.authorization = `Bearer ${bearer}`;
      response = await fetchWithRetry(
        manifestUrl,
        { method: 'HEAD', headers: { accept: MANIFEST_TYPES, ...authorization } },
        io,
      );
    }
    if (response.ok) return { state: 'published' };
    if (response.status === 401 || response.status === 403) return { state: 'not-public' };
    if (response.status !== 404) {
      return { state: 'unreachable', detail: `the manifest answered ${String(response.status)}` };
    }
    // The tag is unknown. Is the repository readable at all? Then only the version is missing.
    const tags = await fetchWithRetry(
      `https://${registry}/v2/${repository}/tags/list`,
      { headers: authorization },
      io,
    );
    if (tags.ok) return { state: 'unpublished' };
    if (tags.status === 404) return { state: 'not-found' };
    return { state: 'not-public' };
  } catch (error) {
    if (error instanceof RegistryUnreachable)
      return { state: 'unreachable', detail: error.message };
    throw error;
  }
}

/**
 * Whether GitHub knows the owner a `ghcr.io/<owner>` registry names: `false` only on a definite
 * 404, `true` when it does or when GitHub cannot say (a rate limit, no network).
 *
 * @param {string} owner
 * @param {Io} [io]
 */
export async function githubOwnerExists(owner, io = {}) {
  try {
    const response = await fetchWithRetry(
      `https://api.github.com/users/${encodeURIComponent(owner)}`,
      { headers: { accept: 'application/vnd.github+json' } },
      io,
    );
    return response.status !== 404;
  } catch {
    return true;
  }
}

/** @param {readonly { reference: string, state: ProbeState, detail?: string }[]} probes */
function skipMessage(probes, version, registry) {
  const states = probes
    .map(({ reference, state, detail }) => `${reference}: ${state}${detail ? ` (${detail})` : ''}`)
    .join('; ');
  return (
    `SKIPPED: the platform images for ${version} cannot all be pulled anonymously from ` +
    `${registry}/${IMAGE_NAMESPACE} [${states}]. Publish them with the tag images-v${version} on ` +
    'main (.github/workflows/images.yml), then make each package public (docs/release/README.md, ' +
    '"Platform images"). Until then `create` refuses to write a project, by design. This skip ' +
    'is registry state, not this change.'
  );
}

async function main() {
  const { registry, version, images } = readReleaseImages();
  const slash = registry.indexOf('/');
  const host = slash < 0 ? registry : registry.slice(0, slash);
  const ownerName = slash < 0 ? '' : (registry.slice(slash + 1).split('/')[0] ?? '');
  const owner = slash < 0 ? '' : `${registry.slice(slash + 1)}/`;
  const probes = [];
  for (const [field, name] of Object.entries(images)) {
    const reference = `${registry}/${IMAGE_NAMESPACE}/${name}:${version}`;
    const probe = await probeImage(host, `${owner}${IMAGE_NAMESPACE}/${name}`, version);
    process.stdout.write(
      `${probe.state.padEnd(11)} ${reference}${probe.detail ? ` (${probe.detail})` : ''}\n`,
    );
    probes.push({ field, reference, ...probe });
  }
  const decision = smokeDecision(probes.map((probe) => probe.state));
  if (decision === 'fail') throw new Error('packages/cli/src/release-images.json pins no image');
  if (decision === 'skip') {
    if (host === 'ghcr.io' && ownerName && !(await githubOwnerExists(ownerName))) {
      throw new Error(
        `packages/cli/src/release-images.json names the registry ${registry}, but GitHub has no ` +
          `user or organisation ${ownerName}: the registry name is wrong.`,
      );
    }
    const message = skipMessage(probes, version, registry);
    process.stdout.write(`::warning title=Generator smoke skipped::${message}\n`);
    process.stdout.write(`\n${'!'.repeat(100)}\n${message}\n${'!'.repeat(100)}\n`);
    return;
  }
  const workspace = mkdtempSync(path.join(tmpdir(), 'aw-create-smoke-'));
  try {
    const target = path.join(workspace, 'demo');
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^AW_[A-Z_]+_IMAGE$/u.test(key)),
    );
    const result = spawnSync(
      process.execPath,
      [path.join(REPOSITORY_ROOT, 'packages/cli/dist/create.js'), target, '--cloud', 'local'],
      { cwd: workspace, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result.status !== 0) {
      throw new Error(`create --cloud local failed:\n${result.stderr || result.stdout}`);
    }
    const env = readFileSync(path.join(target, '.env'), 'utf8');
    for (const [field, key] of Object.entries(ENV_KEYS)) {
      const line = env.split(/\r?\n/u).find((entry) => entry.startsWith(`${key}=`)) ?? '';
      const expected = `${registry}/${IMAGE_NAMESPACE}/${String(images[field])}@sha256:`;
      if (!line.startsWith(`${key}=${expected}`)) {
        throw new Error(`the generated .env does not pin ${field} by digest: ${line || key}`);
      }
    }
    process.stdout.write(`create --cloud local wrote a digest-pinned project for ${version}\n`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
