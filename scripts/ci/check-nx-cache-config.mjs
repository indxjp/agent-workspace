#!/usr/bin/env node
// Nx remote-cache configuration guard — ported from a sibling repository (its
// scripts/ci/check-nx-cache-config.mjs, PR #1950) when this repository left Nx Cloud
// (docs/adr/0110-nx-cloud-is-replaced-by-a-self-hosted-oidc-gated-remote-cache.md; how CI uses
// the cache: docs/operations/ci.md "Nx remote cache").
//
// Fails CI if any of these regress. Every rule is a named check scoped to an explicit set of
// ACTIVE configuration files — docs and history are never scanned, so no per-file exceptions.
//
// Secrets never in committed config:
//   no-token-keys         nx.json / a package.json "nx" block defines nxCloudAccessToken / accessToken
//   no-token-values       a token-looking string value in those same blocks
//   no-env-outputs        a cacheable `outputs` glob that could capture .env* (outputs are what
//                         the remote cache stores and serves to every reader)
//   no-tracked-secrets    a tracked .env* file or anything under .nx/
//
// Nx Cloud stays gone:
//   no-nx-cloud-id        nx.json has nxCloudId/nxCloudUrl or an nx-cloud tasks runner
//   never-connect         nx.json lacks "neverConnectToCloud": true
//   no-cloud-ci           an active CI file mentions NX_CLOUD_ACCESS_TOKEN, NX_NO_CLOUD,
//                         `nx-cloud start-ci-run`, `--distribute-on` or
//                         NX_CLOUD_DISTRIBUTED_EXECUTION
//   no-bucket-cache       a deprecated bucket/shared-fs cache package in any workspace
//                         package.json or the lockfile — CREEP / CVE-2025-36852: one shared
//                         read/write bucket credential lets any pull request poison main's cache
//
// The self-hosted cache's trust model holds:
//   no-write-token-in-ci  no workflow references a static NX_SELF_HOSTED_REMOTE_CACHE_WRITE_TOKEN;
//                         CI writes only through the OIDC exchange
//   cache-env-via-action  no workflow sets NX_SELF_HOSTED_REMOTE_CACHE_SERVER / _ACCESS_TOKEN
//                         itself — only .github/actions/nx-remote-cache does
//   pr-write-assertion    every workflow using the action carries the "Assert pull_request runs
//                         cannot select remote-cache write" step
//   cache-kind-plan       every use of the action takes its kind from the workflow's single
//                         `NX_REMOTE_CACHE_KIND` plan, defined exactly once
//   nx-via-wrapper        in a workflow using the action, every task-running `nx` call goes
//                         through scripts/ci/nx.sh: Nx 23 fails a run on any remote-cache
//                         transport error or 5xx, and the wrapper is what keeps the cache from
//                         deciding whether CI is green
//
// Usage: node scripts/ci/check-nx-cache-config.mjs   (no install needed)
// Tests: tests/tooling/check-nx-cache-config.test.ts
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

/** @typedef {{ rule: string, file: string, message: string }} Problem */

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// A token-like string: 24+ chars of base64url/hex alphabet with at least one digit and no
// separators — clears every real Nx config value (globs, commands, paths) while catching a
// pasted token.
const TOKEN_LIKE = /^(?=[A-Za-z0-9+_=-]{24,}$)[A-Za-z0-9+_=-]*\d[A-Za-z0-9+_=-]*$/u;
const FORBIDDEN_KEYS = new Set(['nxCloudAccessToken', 'accessToken']);

export const DEPRECATED_CACHE_PACKAGES = [
  '@nx/s3-cache',
  '@nx/gcs-cache',
  '@nx/azure-cache',
  '@nx/shared-fs-cache',
  '@nx/powerpack-s3-cache',
  '@nx/powerpack-gcs-cache',
  '@nx/powerpack-azure-cache',
  '@nx/powerpack-shared-fs-cache',
];

const CLOUD_CI_PATTERNS = [
  { re: /NX_CLOUD_ACCESS_TOKEN/u, what: 'an Nx Cloud access token (NX_CLOUD_ACCESS_TOKEN*)' },
  { re: /\bNX_NO_CLOUD\b/u, what: 'NX_NO_CLOUD (an Nx Cloud switch; nx.json neverConnectToCloud)' },
  {
    re: /nx-cloud\s+start-ci-run/u,
    what: '`nx-cloud start-ci-run` (paid CI Pipeline Execution + Nx Agents)',
  },
  { re: /--distribute-on\b/u, what: '`--distribute-on` (Nx Agents / managed compute)' },
  { re: /NX_CLOUD_DISTRIBUTED_EXECUTION/u, what: 'NX_CLOUD_DISTRIBUTED_EXECUTION (Nx Agents)' },
];

const USES_ACTION = /uses:\s*\.\/\.github\/actions\/nx-remote-cache\b/u;
const PR_WRITE_ASSERTION = /name:\s*Assert pull_request runs cannot select remote-cache write/u;
const KIND_INPUT = /^\s*kind:\s*(.*?)\s*$/u;
const PLANNED_KIND = '${{ env.NX_REMOTE_CACHE_KIND }}';
const PLAN_DEFINITION = /^\s*NX_REMOTE_CACHE_KIND:/u;
// A task-running nx invocation that bypasses scripts/ci/nx.sh: `pnpm nx run-many …`,
// `pnpm exec nx affected …`, `npx nx run …`, or a root script that is itself `nx run-many`
// (package.json: build, typecheck, lint).
const RAW_NX = [
  /\b(?:pnpm(?:\s+exec)?|npx|yarn)\s+nx\s+(?:run|run-many|affected)\b/u,
  /^\s*(?:-\s+)?run:\s*pnpm\s+(?:run\s+)?(?:build|typecheck|lint)\s*$/u,
];

/**
 * @param {unknown} node
 * @param {string} file
 * @param {string} [path]
 * @returns {Problem[]}
 */
export function checkNxConfigObject(node, file, path = '') {
  /** @type {Problem[]} */
  const out = [];
  /** @param {unknown} n @param {string} p */
  const walk = (n, p) => {
    if (n === null || n === undefined) return;
    if (Array.isArray(n)) {
      for (const [i, item] of n.entries()) walk(item, `${p}[${String(i)}]`);
      return;
    }
    if (typeof n === 'object') {
      for (const [key, value] of Object.entries(n)) {
        const childPath = p ? `${p}.${key}` : key;
        if (key.startsWith('//')) continue; // documentation strings
        if (FORBIDDEN_KEYS.has(key)) {
          out.push({
            rule: 'no-token-keys',
            file,
            message: `forbidden key "${childPath}" — cache credentials are supplied via env in CI, never in a committed file.`,
          });
          continue;
        }
        if (key === 'outputs' && Array.isArray(value)) {
          for (const glob of value) {
            if (typeof glob === 'string' && glob.includes('.env')) {
              out.push({
                rule: 'no-env-outputs',
                file,
                message: `outputs glob "${glob}" matches ".env" — the remote cache stores and serves declared outputs; an env file there leaks secrets to every cache reader.`,
              });
            }
          }
        }
        walk(value, childPath);
      }
      return;
    }
    if (typeof n === 'string' && TOKEN_LIKE.test(n)) {
      out.push({
        rule: 'no-token-values',
        file,
        message: `value at "${p}" looks like a token (${String(n.length)} opaque chars) — remove it; tokens live only in GitHub secrets / Secret Manager.`,
      });
    }
  };
  walk(node, path);
  return out;
}

/**
 * @param {Record<string, unknown>} nxJson
 * @param {string} [file]
 * @returns {Problem[]}
 */
export function checkNxJson(nxJson, file = 'nx.json') {
  /** @type {Problem[]} */
  const out = [];
  if ('nxCloudId' in nxJson || 'nxCloudUrl' in nxJson) {
    out.push({
      rule: 'no-nx-cloud-id',
      file,
      message:
        'nxCloudId/nxCloudUrl present — Nx would connect to (and bill) Nx Cloud again. Remote caching is the self-hosted server (infra/nx-cache).',
    });
  }
  const runnerOptions = /** @type {Record<string, { runner?: unknown }>} */ (
    nxJson['tasksRunnerOptions'] ?? {}
  );
  if (Object.values(runnerOptions).some((r) => /nx-cloud/u.test(String(r.runner ?? '')))) {
    out.push({
      rule: 'no-nx-cloud-id',
      file,
      message: 'an nx-cloud tasks runner is configured — Nx Cloud is decommissioned.',
    });
  }
  if (nxJson['neverConnectToCloud'] !== true) {
    out.push({
      rule: 'never-connect',
      file,
      message:
        '"neverConnectToCloud": true is required — it makes Nx ignore any ambient NX_CLOUD_ACCESS_TOKEN or a re-added nxCloudId.',
    });
  }
  const rest = Object.fromEntries(
    Object.entries(nxJson).filter(([key]) => key !== 'nxCloudId' && key !== 'nxCloudUrl'),
  );
  out.push(...checkNxConfigObject(rest, file));
  return out;
}

/**
 * @param {Record<string, unknown>} pkg
 * @param {string} file
 * @returns {Problem[]}
 */
export function checkPackageJson(pkg, file) {
  const out = pkg['nx'] ? checkNxConfigObject(pkg['nx'], file, 'nx') : [];
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const deps = /** @type {Record<string, string>} */ (pkg[field] ?? {});
    for (const name of Object.keys(deps)) {
      if (DEPRECATED_CACHE_PACKAGES.includes(name)) {
        out.push({
          rule: 'no-bucket-cache',
          file,
          message: `${field} includes ${name} — deprecated bucket cache (CREEP, CVE-2025-36852). Use the self-hosted HTTP cache (infra/nx-cache).`,
        });
      }
    }
  }
  return out;
}

/**
 * @param {string} text
 * @param {string} [file]
 * @returns {Problem[]}
 */
export function checkLockfile(text, file = 'pnpm-lock.yaml') {
  return DEPRECATED_CACHE_PACKAGES.filter((name) =>
    new RegExp(`(^|[\\s'"/])${name.replace('/', '\\/')}@`, 'mu').test(text),
  ).map((name) => ({
    rule: 'no-bucket-cache',
    file,
    message: `lockfile resolves ${name} — deprecated bucket cache (CREEP, CVE-2025-36852).`,
  }));
}

/**
 * Rules for an active CI file (workflow, composite action, CI script).
 * @param {string} text
 * @param {string} file
 * @param {{ isWorkflow?: boolean }} [options]
 * @returns {Problem[]}
 */
export function checkCiText(text, file, { isWorkflow = false } = {}) {
  /** @type {Problem[]} */
  const out = [];
  const usesAction = isWorkflow && USES_ACTION.test(text);
  let planDefinitions = 0;
  text.split(/\r?\n/u).forEach((line, i) => {
    const at = `${file}:${String(i + 1)}`;
    for (const { re, what } of CLOUD_CI_PATTERNS) {
      if (re.test(line)) {
        out.push({
          rule: 'no-cloud-ci',
          file: at,
          message: `${what} — Nx Cloud is decommissioned.`,
        });
      }
    }
    if (!isWorkflow) return;
    if (/NX_SELF_HOSTED_REMOTE_CACHE_WRITE_TOKEN/u.test(line)) {
      out.push({
        rule: 'no-write-token-in-ci',
        file: at,
        message:
          'workflows must not reference a static write token — CI obtains write access only through the OIDC exchange in .github/actions/nx-remote-cache.',
      });
    }
    const set = /^\s*(NX_SELF_HOSTED_REMOTE_CACHE_(?:SERVER|ACCESS_TOKEN))\s*:/u.exec(line);
    if (set) {
      out.push({
        rule: 'cache-env-via-action',
        file: at,
        message: `${String(set[1])} is set directly — only .github/actions/nx-remote-cache may set it.`,
      });
    }
    if (!usesAction) return;
    if (PLAN_DEFINITION.test(line)) planDefinitions += 1;
    const kind = KIND_INPUT.exec(line);
    if (kind && kind[1] !== PLANNED_KIND) {
      out.push({
        rule: 'cache-kind-plan',
        file: at,
        message: `the nx-remote-cache kind must be ${PLANNED_KIND} (the workflow's one plan), not "${String(kind[1])}".`,
      });
    }
    if (RAW_NX.some((re) => re.test(line))) {
      out.push({
        rule: 'nx-via-wrapper',
        file: at,
        message:
          'a task-running nx call bypasses scripts/ci/nx.sh — with the remote cache connected, Nx 23 fails the step on any cache transport error or 5xx even when every task passed. Run it as `scripts/ci/nx.sh <nx args>`.',
      });
    }
  });
  if (usesAction && !PR_WRITE_ASSERTION.test(text)) {
    out.push({
      rule: 'pr-write-assertion',
      file,
      message:
        'uses nx-remote-cache but has no "Assert pull_request runs cannot select remote-cache write" step.',
    });
  }
  if (usesAction && planDefinitions !== 1) {
    out.push({
      rule: 'cache-kind-plan',
      file,
      message: `uses nx-remote-cache, so it must define NX_REMOTE_CACHE_KIND exactly once (found ${String(planDefinitions)}).`,
    });
  }
  return out;
}

/**
 * @param {string[]} tracked
 * @returns {Problem[]}
 */
export function checkTrackedFiles(tracked) {
  /** @type {Problem[]} */
  const out = [];
  /** @param {string} p */
  const isAllowedExample = (p) => /\.env[.\w-]*\.example$/u.test(p);
  for (const f of tracked) {
    if (/(^|\/)\.env(\..*)?$/u.test(f) && !isAllowedExample(f)) {
      out.push({
        rule: 'no-tracked-secrets',
        file: f,
        message: 'an env file is tracked by git — .env* must stay untracked.',
      });
    }
    if (/(^|\/)\.nx\//u.test(f)) {
      out.push({
        rule: 'no-tracked-secrets',
        file: f,
        message: "a file under .nx/ (Nx's local cache / workspace data) is tracked by git.",
      });
    }
  }
  return out;
}

/** @param {string} p */
const toPosix = (p) => p.split('\\').join('/');

/**
 * @param {string} dir
 * @param {(relativePath: string) => boolean} accept
 * @returns {string[]}
 */
function listFiles(dir, accept) {
  const abs = join(REPO_ROOT, dir);
  if (!existsSync(abs)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const rel = toPosix(relative(REPO_ROOT, join(entry.parentPath, entry.name)));
    if (rel.includes('/node_modules/')) continue;
    if (accept(rel)) out.push(rel);
  }
  return out;
}

/** The ACTIVE configuration surface, nothing else. */
export function activeCiFiles() {
  const self = 'scripts/ci/check-nx-cache-config.mjs';
  return [
    ...listFiles('.github/workflows', (p) => /\.ya?ml$/u.test(p)).map((p) => ({
      p,
      isWorkflow: true,
    })),
    ...listFiles('.github/actions', (p) => /\.ya?ml$/u.test(p)).map((p) => ({
      p,
      isWorkflow: false,
    })),
    ...listFiles('scripts', (p) => /\.(sh|mjs|mts|js|cjs)$/u.test(p) && p !== self).map((p) => ({
      p,
      isWorkflow: false,
    })),
    ...listFiles(
      'infra/nx-cache',
      (p) => /\.(mjs|sh|ya?ml)$/u.test(p) && !p.includes('/test/'),
    ).map((p) => ({ p, isWorkflow: false })),
  ];
}

/** Workspace package.json files, from pnpm-workspace.yaml's `packages:` globs (dir or dir/*). */
export function workspacePackageJsons() {
  const yaml = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const block = /^packages:\s*\n((?:\s+-\s+.*\n?)+)/mu.exec(yaml)?.[1] ?? '';
  const globs = [...block.matchAll(/-\s+["']?([^"'\n]+?)["']?\s*$/gmu)].map((m) => String(m[1]));
  const files = ['package.json'];
  for (const g of globs) {
    if (g.endsWith('/*')) {
      const base = g.slice(0, -2);
      if (!existsSync(join(REPO_ROOT, base))) continue;
      for (const d of readdirSync(join(REPO_ROOT, base), { withFileTypes: true })) {
        if (d.isDirectory() && existsSync(join(REPO_ROOT, base, d.name, 'package.json'))) {
          files.push(`${base}/${d.name}/package.json`);
        }
      }
    } else if (existsSync(join(REPO_ROOT, g, 'package.json'))) {
      files.push(`${g}/package.json`);
    }
  }
  return files;
}

/** @returns {Problem[]} */
export function runAll() {
  /** @param {string} p */
  const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');
  const problems = [...checkNxJson(JSON.parse(read('nx.json')))];
  for (const p of workspacePackageJsons()) {
    /** @type {Record<string, unknown>} */
    let pkg;
    try {
      pkg = JSON.parse(read(p));
    } catch {
      continue; // not this script's job to validate JSON syntax
    }
    problems.push(...checkPackageJson(pkg, p));
  }
  problems.push(...checkLockfile(read('pnpm-lock.yaml')));
  for (const { p, isWorkflow } of activeCiFiles()) {
    problems.push(...checkCiText(read(p), p, { isWorkflow }));
  }
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  problems.push(...checkTrackedFiles(tracked.split('\n').filter(Boolean)));
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = runAll();
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::[${p.rule}] ${p.file}: ${p.message}`);
    console.error(
      `\n${String(problems.length)} problem(s). See docs/operations/ci.md "Nx remote cache" for the rules this guard enforces.`,
    );
    process.exit(1);
  }
  console.log(
    'check-nx-cache-config: OK — no Nx Cloud path, no committed or long-lived CI write credential, no deprecated bucket cache, no secret-capturing outputs, every cached nx call through scripts/ci/nx.sh.',
  );
}
