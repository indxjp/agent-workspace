/**
 * The pure parts of the lightweight deploy-the-agent-app journey: which lanes and chapters exist,
 * what each needs, the names a lane's cloud resources get, and how a lane's outcome is recorded.
 * `journey.e2e.mjs` runs the chapters, `teardown.mjs` deletes by `resourceNames`, and
 * `journey.test.ts` pins the rules below without a credential.
 *
 * Outcomes are the isolation vocabulary of `infra/tests/isolation/summary.mjs`: `pass`, `fail`,
 * `skipped`. A lane without its credentials is `skipped` on every row and never `pass`; the summary
 * treats `skipped` as not clean.
 */
import { createHash } from 'node:crypto';
import process from 'node:process';

import { redact } from '../../../infra/tests/providers/support.mjs';

/**
 * Credentials a host needs, and those a sandbox provider adds. Neon holds the database: Vercel runs
 * no database and a Cloudflare Worker reaches an external PostgreSQL, so each run takes a branch.
 */
const HOSTS = {
  // The R2 key pair is an R2 API token's: the control plane reaches its bucket with it, on Vercel
  // through R2's S3 endpoint (ADR-0120 LC8).
  vercel: [
    'VERCEL_TOKEN',
    'VERCEL_TEAM_ID',
    'NEON_API_KEY',
    'NEON_PROJECT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ],
  cloudflare: [
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'NEON_API_KEY',
    'NEON_PROJECT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ],
};
const SANDBOXES = {
  'vercel-sandbox': [],
  // The bridge runs the runtime image the journey builds, pushed with the Cloudflare token.
  'cloudflare-sandbox': [],
  // The runtime and tool-host templates are built from the checkout by the journey
  // (`<template>:<build_id>`, ADR-0120 LC2: E2B runs no OCI digest); `E2B_RUNTIME_TEMPLATE` and
  // `E2B_TOOL_HOST_TEMPLATE` are only the production pins.
  e2b: ['E2B_API_KEY'],
};

/**
 * The code the runtime refuses every run with until egress denial is provable on Cloudflare Sandbox
 * (ADR-0131): the lane deploys, then its run rows record `n/a` with this refusal as the proof.
 */
export const CLOUDFLARE_SANDBOX_REFUSAL = 'network_policy_unsupported';

/**
 * The code `aw push` is refused with when the deployment has no tool sandbox to run a code tool in
 * (ADR-0131): the Cloudflare Sandbox and Vercel Sandbox lanes push, are refused, and their agent
 * rows record `n/a`.
 */
export const CODE_TOOL_NEEDS_HOST_REFUSAL = 'code_tool_needs_host';

/** `key` is two letters of the resource names; `deploy` is the path that can deploy the lane. */
export const LANES = [
  {
    id: 'vercel-vercel-sandbox',
    host: 'vercel',
    sandbox: 'vercel-sandbox',
    key: 'vv',
    deploy: 'aw',
    // No Vercel Sandbox tool host yet: the manager has no tool sandbox, so a code tool is refused.
    pushRefusal: CODE_TOOL_NEEDS_HOST_REFUSAL,
  },
  { id: 'vercel-e2b', host: 'vercel', sandbox: 'e2b', key: 've', deploy: 'profile' },
  {
    id: 'cloudflare-cloudflare-sandbox',
    host: 'cloudflare',
    sandbox: 'cloudflare-sandbox',
    key: 'cc',
    deploy: 'profile',
    refusal: CLOUDFLARE_SANDBOX_REFUSAL,
    pushRefusal: CODE_TOOL_NEEDS_HOST_REFUSAL,
  },
  { id: 'cloudflare-e2b', host: 'cloudflare', sandbox: 'e2b', key: 'ce', deploy: 'profile' },
].map((lane) => ({
  ...lane,
  credentials: [...new Set([...HOSTS[lane.host], ...SANDBOXES[lane.sandbox]])],
}));

/**
 * In order; a chapter after a failed one is not reached. No chapter needs a model key: the eval runs
 * a keyless scripted model and the deployment is set up with a fake key, as the Z1 journey does.
 */
export const CHAPTERS = [
  { id: 'create', title: '1 npm create writes the support project' },
  { id: 'eval', title: '2 code tool with a secret; aw eval against a scripted model' },
  { id: 'deploy', title: '3 aw deploy puts the whole app on the host' },
  { id: 'configure', title: '3 setup, runtime, secret and aw push on the deployment' },
  { id: 'gate', title: '3 aw promote refused below the eval bar, moves past it' },
  { id: 'chat-api', title: '4 chat through the API runs the code tool' },
  { id: 'hosted-chat', title: '4 hosted chat page answers a turn' },
  {
    id: 'widget',
    title: '4 /widget.js is served, the frontend origin is allowed, and a turn from it is answered',
  },
  { id: 'frontend', title: '4 the project frontend is served and reaches the API' },
  { id: 'rollback', title: '5 aw rollback moves production back' },
];

/** Every project, branch and Worker a lane creates starts with this; `isLeftover` guards on it. */
const JOURNEY_PREFIX = 'awlj-';

/**
 * A leftover is only swept once it is older than any journey that could still use it: the job times
 * out at 130 minutes, so a younger name may belong to a lane in flight.
 */
export const LEFTOVER_AGE_MS = 4 * 60 * 60 * 1_000;

const TIME_FIELDS = [
  'createdAt',
  'updatedAt',
  'created_on',
  'modified_on',
  'created_at',
  'updated_at',
];

/**
 * The sweep filter for one lane of one run: a name that is exactly `awlj-<8 hex>-<lane key>` or one
 * of its host suffixes, is not this run's own, and whose latest creation/modification time in `item`
 * is older than `LEFTOVER_AGE_MS`. A name without a parseable time is kept. The account also hosts
 * production resources, so anything outside that exact shape is never a leftover.
 *
 * @param {{ key: string }} lane @param {string} runId @param {number} [now]
 * @returns {(name: unknown, item: unknown) => boolean}
 */
export function isLeftover(lane, runId, now = Date.now()) {
  const own = resourceNames(lane, runId).project;
  const shape = new RegExp(
    `^${JOURNEY_PREFIX}[0-9a-f]{8}-${lane.key}(?:-gateway|-manager|-control-plane|-web|-provider)?$`,
    'u',
  );
  return (name, item) => {
    if (typeof name !== 'string' || !shape.test(name)) return false;
    if (name === own || name.startsWith(`${own}-`)) return false;
    const record = /** @type {Record<string, unknown>} */ (
      typeof item === 'object' && item !== null ? item : {}
    );
    const times = TIME_FIELDS.map((field) => {
      const value = record[field];
      if (typeof value === 'number') return value;
      return typeof value === 'string' ? Date.parse(value) : Number.NaN;
    }).filter((time) => Number.isFinite(time));
    return times.length > 0 && now - Math.max(...times) > LEFTOVER_AGE_MS;
  };
}

/** @param {readonly string[]} names @param {Record<string, string | undefined>} env */
export function missingVariables(names, env) {
  return names.filter((name) => (env[name] ?? '') === '');
}

/**
 * Names a lane's cloud resources derive from, so `teardown.mjs` finds them without a state file.
 * Vercel project and Worker names are lowercase; the longest suffix is `-control-plane`. `-provider` is the
 * scripted model every lane's setup is pointed at (a hosted deployment cannot alias `api.anthropic.com`);
 * it is a Cloudflare Worker even for a Vercel lane.
 *
 * @param {{ key: string }} lane @param {string} runId
 */
export function resourceNames(lane, runId) {
  const run = createHash('sha256').update(runId).digest('hex').slice(0, 8);
  const project = `${JOURNEY_PREFIX}${run}-${lane.key}`;
  return {
    project,
    neonBranch: project,
    vercelProjects: ['', '-gateway', '-manager', '-web'].map((suffix) => `${project}${suffix}`),
    workers: ['', '-gateway', '-manager', '-control-plane', '-web', '-provider'].map(
      (suffix) => `${project}${suffix}`,
    ),
    fakeProvider: `${project}-provider`,
    bridgeWorker: `agent-workspace-sandbox-bridge-ci-${runId}`,
  };
}

/**
 * Run the chapters of one lane and record each as it finishes.
 *
 * - Missing lane credentials: every row `skipped`, naming the variables.
 * - A chapter that resolves with a string is `n/a` with that string as the proof, never `pass`.
 * - A chapter that throws is `fail` with the redacted message, and every chapter after it is `fail`
 *   ("not reached"), so nothing downstream of a broken deploy reads as passed or skipped.
 *
 * @param {{ id: string, credentials: readonly string[] }} lane
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, () => Promise<void | string>>} steps one function per chapter id
 * @param {(id: string, outcome: string, detail?: string) => void} record
 * @param {() => readonly string[]} [secretsMade] values the run minted (database URL, API key…)
 */
export async function runChapters(lane, env, steps, record, secretsMade = () => []) {
  const hiddenNow = () => lane.credentials.map((name) => env[name] ?? '').concat(secretsMade());
  const missing = missingVariables(lane.credentials, env);
  /** @type {{ outcome: 'fail' | 'skipped', detail: string } | undefined} */
  let stopped;
  if (missing.length > 0) {
    stopped = { outcome: 'skipped', detail: `not selected: ${missing.join(', ')} not set` };
  }
  for (const chapter of CHAPTERS) {
    if (stopped !== undefined) {
      record(chapter.id, stopped.outcome, stopped.detail);
      continue;
    }
    try {
      const notApplicable = await steps[chapter.id]?.();
      if (typeof notApplicable === 'string') {
        record(chapter.id, 'n/a', redact(notApplicable, hiddenNow()));
      } else {
        record(chapter.id, 'pass');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redacted = redact(message, hiddenNow());
      // The job log is the only place the whole reason survives; the results file keeps the tail.
      process.stderr.write(`chapter "${chapter.id}" failed:\n${redacted}\n`);
      // The tail: a failed tool prints its reason last, and a long log must not fill the summary.
      record(chapter.id, 'fail', redacted.slice(-1_500));
      stopped = { outcome: 'fail', detail: `not reached: "${chapter.title}" failed` };
    }
  }
}

/**
 * The results file `infra/tests/isolation/summary.mjs` reads, rewritten after every row.
 *
 * @param {string} lane @param {(file: string, text: string) => void} write @param {string} file
 */
export function resultsWriter(lane, write, file) {
  const results = {};
  return (
    /** @type {string} */ id,
    /** @type {string} */ outcome,
    /** @type {string | undefined} */ detail,
  ) => {
    const chapter = CHAPTERS.find((candidate) => candidate.id === id);
    results[id] = {
      title: chapter?.title ?? id,
      outcome,
      ...(detail === undefined ? {} : { detail }),
    };
    write(file, `${JSON.stringify({ lane, results }, null, 2)}\n`);
  };
}
