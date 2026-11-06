// The rules every workflow file is held to, one function per rule. validateWorkflowFile runs them
// in a fixed order so the gate's output order never changes.
import path from 'node:path';

import { isInternalOnlyJob, workflowJobs } from '../ci/workflow-jobs.mjs';
import { CI_WORKFLOW, WORKFLOWS_DIRECTORY } from './ci-text.mjs';

const IMMUTABLE_REF = /^[0-9a-f]{40}$/u;
/**
 * The status checks main's ruleset requires (docs/adr/0149). main merges through a merge queue
 * (Amendment 2026-10-19, owner decision D6), so the workflow producing each one must run on
 * merge_group; otherwise the check never reports for a queued group and the queue waits forever.
 */
const REQUIRED_CHECKS = ['CI success', 'OSS export · dry run'];
const MERGE_GROUP_TRIGGER = /^ {2}merge_group:\r?\n {4}types: \[checks_requested\]\r?$/mu;

/** @type {ReadonlyMap<string, readonly [string, string]>} */
const approvedActions = new Map([
  ['actions/cache', ['55cc8345863c7cc4c66a329aec7e433d2d1c52a9', 'v6.1.0']],
  ['actions/cache/restore', ['55cc8345863c7cc4c66a329aec7e433d2d1c52a9', 'v6.1.0']],
  ['actions/cache/save', ['55cc8345863c7cc4c66a329aec7e433d2d1c52a9', 'v6.1.0']],
  ['actions/checkout', ['3d3c42e5aac5ba805825da76410c181273ba90b1', 'v7']],
  ['actions/dependency-review-action', ['a1d282b36b6f3519aa1f3fc636f609c47dddb294', 'v5.0.0']],
  ['actions/download-artifact', ['9000827ccba6bdab643e8b6fd33ac0654aef8333', 'v8']],
  ['actions/setup-node', ['949feb2413d6458794dcd2491c4babbbce0c15c1', 'v7']],
  ['actions/upload-artifact', ['cf430e030ddbb5b0abf93d22962f4752f3646cd9', 'v7']],
  ['anchore/sbom-action/download-syft', ['66cbf4bc1f1c0d2edc94016e65bc221b6bb0ad6c', 'v0.24.3']],
  ['aquasecurity/setup-trivy', ['81e514348e19b6112ce2a7e3ecbafe19c1e1f567', 'v0.3.1']],
  ['azure/login', ['a641126d1b8aa4d1fa005f4f92df94a3a4c4c906', 'v3.1.0']],
  ['azure/setup-helm', ['9bc31f4ebc9c6b171d7bfbaa5d006ae7abdb4310', 'v5']],
  ['docker/setup-buildx-action', ['f87e5991a6d7451dcb8d9637bfbc97413f497069', 'v4.4.1']],
  ['docker/setup-qemu-action', ['99012661954931238ded8c8b007157a8430204e1', 'v4.4.0']],
  ['github/codeql-action/analyze', ['9b3254085494b55a0f7c4c2b3d2d52cc712ce370', 'v4.39.1']],
  ['github/codeql-action/init', ['9b3254085494b55a0f7c4c2b3d2d52cc712ce370', 'v4.39.1']],
  ['google-github-actions/auth', ['7c6bc770dae815cd3e89ee6cdf493a5fab2cc093', 'v3.0.0']],
  ['google-github-actions/setup-gcloud', ['aa5489c8933f4cc7a4f7d45035b3b1440c9c10db', 'v3.0.1']],
  ['hashicorp/setup-terraform', ['dfe3c3f87815947d99a8997f908cb6525fc44e9e', 'v4.0.1']],
  ['pnpm/action-setup', ['ea17c68df8912ef543352723c149a84f56e3d413', 'v6.1.0']],
  ['sigstore/cosign-installer', ['6f9f17788090df1f26f669e9d70d6ae9567deba6', 'v4.1.2']],
]);

// Every Linux CI job runs on the organisation's own MS-A2 pool (docs/adr/0053, Amendment 2026-10-23)
// in this repository, and on a GitHub-hosted runner in the public export (Amendment 2026-10-26).
// One file serves both, so a job's runs-on is an expression on `github.repository_owner`: the
// internal label for INDXDev, a free GitHub-hosted label anywhere else. A fork or the public
// repository therefore can never select a self-hosted or paid runner. Any other value — a bare
// label, `ubuntu-latest`, another self-hosted pool such as `[self-hosted, dgx]` or a variable — is
// a policy failure, not a configuration choice. indx-dev.yml belongs to the agent tooling and is
// out of scope here on purpose (see docs/adr/0053). ci-nx-cache.yml is a gate on the Nx remote
// cache (docs/adr/0110) and is held to it too.
const RUNNER_POLICY_WORKFLOWS = new Set(
  ['ci.yml', 'ci-nx-cache.yml', 'internal-checks.yml', 'quality.yml', 'security.yml'].map((name) =>
    path.posix.join(WORKFLOWS_DIRECTORY, name),
  ),
);
/** @param {string} internal the INDXDev runner, as an expression @param {string} hosted */
const internalOr = (internal, hosted) =>
  `\${{ github.repository_owner == 'INDXDev' && ${internal} || '${hosted}' }}`;
const MS_A2_RUNS_ON = internalOr(`fromJSON('["self-hosted","ms-a2"]')`, 'ubuntu-latest');
// The few jobs that leave the pool for a Blacksmith runner (ADR-0053, Amendments 2026-10-23b and
// 2026-10-25): the ones that hold a shared MS-A2 slot longest for the least Blacksmith money, the
// inner-loop jobs every pull request and queue group waits on (typecheck-lint, heavy-checks), and
// the Docker E2Es that need a daemon of their own. Keyed by
// `<workflow>#<job id>`; any other job on that label is still refused.
const OFFLOADED_JOBS = new Map(
  [
    'build',
    'build-embedded',
    'typecheck-lint',
    'heavy-checks',
    'formal',
    'formal-cache',
    'journey-e2e',
    'docs-claims',
    'tool-sandbox-e2e',
    'browser',
  ].map((job) => [
    `${CI_WORKFLOW}#${job}`,
    internalOr(`'blacksmith-8vcpu-ubuntu-2404'`, 'ubuntu-latest'),
  ]),
);

// The light jobs that run on a GitHub-hosted runner here too (ADR-0053, Amendment 2026-11-05): they
// only check, call an API or summarise, take seconds to two minutes, and waited 5-18 minutes for a
// pool slot. The plain label, with no override, as indx-everything#394 does for its light jobs.
// Keyed by `<workflow>#<job id>`; any other job on `ubuntu-latest` is still refused.
const HOSTED_RUNS_ON = 'ubuntu-latest';
const HOSTED_JOBS = new Set(
  [
    'ci.yml#fast-checks',
    'ci.yml#cancel-on-fast-failure',
    'ci.yml#cancel-on-build-failure',
    'ci.yml#ci-success',
    'quality.yml#helm',
    'security.yml#dependency-review',
    'security.yml#ghas-skipped-notice',
    'security.yml#dependency-audit',
    'security.yml#codeql',
    'internal-checks.yml#internal-checks',
    'ci-nx-cache.yml#server',
    'ci-nx-cache.yml#live-trust',
  ].map((key) => path.posix.join(WORKFLOWS_DIRECTORY, key)),
);

// Workflows that spend the Owner's money or reach the Owner's accounts: live providers, real
// models, cloud deployments, the Nx cache server and the nightly alarm. The public export ships them,
// because its tests read them, but every job carries the INDXDev guard, so neither the public
// repository nor a fork ever starts one (docs/adr/0053, Amendment 2026-10-26).
const INTERNAL_ONLY_WORKFLOWS = new Set(
  [
    'azure-preview.yml',
    'ci-nx-cache.yml',
    'e2b-template.yml',
    'gcp-small-acceptance.yml',
    'install-live.yml',
    'journey-live.yml',
    'lightweight-journey.yml',
    'live-e2e.yml',
    'nightly-alarm.yml',
    'providers-live.yml',
    'terraform.yml',
  ].map((name) => path.posix.join(WORKFLOWS_DIRECTORY, name)),
);

// The release workflows publish from the public repository only, on its free GitHub-hosted runners
// (docs/adr/0082 and docs/adr/0086, Amendments 2026-10-26): a tag here, or in a fork, starts nothing.
const PUBLIC_RELEASE_WORKFLOWS = new Set(
  ['images.yml', 'publish-packages.yml', 'release.yml'].map((name) =>
    path.posix.join(WORKFLOWS_DIRECTORY, name),
  ),
);
const PUBLIC_RELEASE_GUARD = "    if: github.repository == 'indxjp/agent-workspace'";

/**
 * The lines of `on.pull_request`'s body, or `null` when the trigger is written inline.
 * @param {string[]} lines @param {number} header
 */
function pullRequestBody(lines, header) {
  if (!/^ {2}pull_request:\s*(#.*)?$/u.test(lines[header] ?? '')) return null;
  /** @type {string[]} */
  const body = [];
  for (const line of lines.slice(header + 1)) {
    if (line.trim() !== '' && !line.startsWith('    ')) break;
    body.push(line);
  }
  return body;
}

/**
 * The raw items of the `types` key at `body[at]`: an inline `[a, b]` list, or the `- a` lines below.
 * @param {string[]} body @param {number} at
 */
function typesItems(body, at) {
  const value = (body[at] ?? '')
    .replace(/^ {4}types:/u, '')
    .replace(/#.*$/u, '')
    .trim();
  if (/^\[[^\]]*\]$/u.test(value)) return value.slice(1, -1).split(',');
  if (value !== '') return [];
  /** @type {string[]} */
  const items = [];
  for (const line of body.slice(at + 1)) {
    const item = /^ {6,}-\s*([^#]*)/u.exec(line);
    if (item === null) break;
    items.push(item[1] ?? '');
  }
  return items;
}

/**
 * The activity types of a workflow's `on.pull_request`: an empty set when it has no such trigger or
 * no `types` key (the defaults exclude `edited`), `null` when a `types` key is there but neither an
 * inline `[a, b]` list nor a block of `- a` items, so the caller fails closed instead of reading it
 * as empty.
 * @param {string} source
 * @returns {Set<string> | null}
 */
function pullRequestTypes(source) {
  const lines = source.split(/\r?\n/u);
  const header = lines.findIndex((line) => /^ {2}pull_request:/u.test(line));
  if (header === -1) return new Set();
  const body = pullRequestBody(lines, header);
  if (body === null) return null;
  const at = body.findIndex((line) => /^ {4}types\b/u.test(line));
  if (at === -1) return new Set();
  const events = new Set(
    typesItems(body, at)
      .map((type) => type.trim())
      .filter((type) => type !== ''),
  );
  return events.size === 0 ? null : events;
}

/**
 * Whether a workflow's `pull_request` runs for both `edited` and `synchronize` in one top-level
 * concurrency group that may cancel in progress, i.e. a group key that ignores the event action.
 * @param {Set<string>} events the workflow's `pull_request` types
 * @param {string} source
 */
function editedSharesCancellingGroup(events, source) {
  if (!events.has('edited') || !events.has('synchronize')) return false;
  const concurrency = source.match(/^concurrency:\r?\n((?:[ #].*\r?\n|\r?\n)*)/mu)?.[1];
  if (concurrency === undefined) return false;
  if (/^ {2}cancel-in-progress:\s*false\s*$/mu.test(concurrency)) return false;
  const group = concurrency.match(/^ {2}group:(.*)$/mu)?.[1] ?? '';
  return !group.includes('github.event.action');
}

/** @param {string[]} failures @param {string} relativePath @param {string} source */
function checkPermissions(failures, relativePath, source) {
  if (!/^permissions:/mu.test(source)) {
    failures.push(`${relativePath}: workflow must declare top-level permissions`);
  }
}

/**
 * A push to main must never cancel an earlier main run (audit F-02): CI there is the trunk's only signal.
 * @param {string[]} failures @param {string} relativePath @param {string} source
 */
function checkPushNeverCancels(failures, relativePath, source) {
  if (/^ {2}push:/mu.test(source) && /^ {2}cancel-in-progress:\s*true\s*$/mu.test(source)) {
    failures.push(
      `${relativePath}: concurrency.cancel-in-progress must not be true on a workflow that runs on push; make it conditional on github.event_name == pull_request`,
    );
  }
}

/**
 * A PR body edit re-runs only the fast checks; if it shares a cancel-in-progress group with the
 * code run it cancels the real tests, and the skipped jobs still let CI success report green.
 * @param {string[]} failures @param {string} relativePath @param {string} source
 */
function checkEditedRunConcurrency(failures, relativePath, source) {
  const pullRequestEvents = pullRequestTypes(source);
  if (pullRequestEvents === null) {
    failures.push(
      `${relativePath}: on.pull_request.types must be an inline [a, b] list or a block of - items so the edited-run concurrency check can read it`,
    );
  } else if (editedSharesCancellingGroup(pullRequestEvents, source)) {
    failures.push(
      `${relativePath}: an \`edited\` run shares a cancel-in-progress concurrency group with code runs (synchronize); key concurrency.group on github.event.action`,
    );
  }
}

/** @param {string[]} failures @param {string} relativePath @param {string} source */
function checkRequiredChecksRunInQueue(failures, relativePath, source) {
  for (const check of REQUIRED_CHECKS) {
    const producesCheck = source
      .split(/\r?\n/u)
      .some((line) => /^ {4}name:/u.test(line) && line.trim() === `name: ${check}`);
    if (producesCheck && !MERGE_GROUP_TRIGGER.test(source)) {
      failures.push(
        `${relativePath}: produces the required check "${check}" and must run on merge_group (types: [checks_requested]) so the merge queue gets it`,
      );
    }
  }
}

/** @param {string[]} failures @param {string} relativePath @param {string} source */
function checkNoPullRequestTarget(failures, relativePath, source) {
  if (/^\s*pull_request_target:/mu.test(source)) {
    failures.push(`${relativePath}: pull_request_target is prohibited`);
  }
}

/** @param {string[]} failures @param {string} relativePath @param {string} source */
function checkRunnerPolicy(failures, relativePath, source) {
  if (!RUNNER_POLICY_WORKFLOWS.has(relativePath)) return;
  let jobId = '';
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    jobId = line.match(/^ {2}([a-zA-Z0-9_-]+):\s*$/u)?.[1] ?? jobId;
    const runsOn = line.match(/^\s*runs-on:\s*(.+?)\s*$/u);
    if (runsOn === null) continue;
    const label = runsOn[1] ?? '';
    // A hosted job stays hosted: neither the pool nor Blacksmith takes it back by accident.
    if (HOSTED_JOBS.has(`${relativePath}#${jobId}`)) {
      if (label === HOSTED_RUNS_ON) continue;
    } else if (
      label === MS_A2_RUNS_ON ||
      OFFLOADED_JOBS.get(`${relativePath}#${jobId}`) === label
    ) {
      continue;
    }
    failures.push(
      `${relativePath}:${String(index + 1)}: runs-on "${label}" is not ${MS_A2_RUNS_ON} — every Linux CI job runs on the MS-A2 pool here and GitHub-hosted elsewhere`,
    );
  }
}

/** @param {string[]} failures @param {string} relativePath @param {string} source */
function checkPublicReleaseJobs(failures, relativePath, source) {
  if (!PUBLIC_RELEASE_WORKFLOWS.has(relativePath)) return;
  for (const job of workflowJobs(source)) {
    const lines = job.lines.map(({ text }) => text);
    if (!lines.includes(PUBLIC_RELEASE_GUARD)) {
      failures.push(`${relativePath}#${job.id}: a release job must have${PUBLIC_RELEASE_GUARD}`);
    }
    const runsOn = lines.find((text) => /^ {4}runs-on:/u.test(text));
    if (runsOn !== undefined && runsOn.trim() !== 'runs-on: ubuntu-latest') {
      failures.push(`${relativePath}#${job.id}: a release job runs on ubuntu-latest`);
    }
  }
}

/** @param {string[]} failures @param {string} relativePath @param {string} source */
function checkInternalOnlyJobs(failures, relativePath, source) {
  if (!INTERNAL_ONLY_WORKFLOWS.has(relativePath)) return;
  for (const job of workflowJobs(source)) {
    if (!isInternalOnlyJob(job.lines)) {
      failures.push(
        `${relativePath}#${job.id}: an internal-only job must start with if: github.repository_owner == 'INDXDev' (alone, or && one parenthesised condition)`,
      );
    }
  }
}

/**
 * The failures of one `uses:` reference: an immutable SHA, on the allowlist, matching its pin and
 * carrying the pin's version comment.
 * @param {string} location
 * @param {string} specifier
 * @param {string | undefined} versionComment
 * @param {ReadonlyMap<string, readonly [string, string]>} extraActions
 * @returns {string[]}
 */
function actionPinFailures(location, specifier, versionComment, extraActions) {
  const separator = specifier.lastIndexOf('@');
  const action = separator < 1 ? specifier : specifier.slice(0, separator);
  const ref = separator < 1 ? '' : specifier.slice(separator + 1);
  if (!IMMUTABLE_REF.test(ref)) {
    return [`${location}: ${action} must use an immutable 40-character commit SHA`];
  }
  const approved = approvedActions.get(action) ?? extraActions.get(action);
  if (approved === undefined) {
    return [`${location}: ${action} is not in the reviewed action allowlist`];
  }
  const [approvedRef, approvedVersion] = approved;
  /** @type {string[]} */
  const failures = [];
  if (ref !== approvedRef) {
    failures.push(`${location}: ${action}@${ref} does not match reviewed ${approvedRef}`);
  }
  if (versionComment !== approvedVersion) {
    failures.push(`${location}: keep the human-readable version comment "# ${approvedVersion}"`);
  }
  return failures;
}

/**
 * @param {string[]} failures @param {string} relativePath @param {string} source
 * @param {ReadonlyMap<string, readonly [string, string]>} extraActions
 */
function checkActionPins(failures, relativePath, source, extraActions) {
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?\s*$/u);
    const specifier = match?.[1];
    if (specifier === undefined || specifier.startsWith('./')) continue;
    const location = `${relativePath}:${String(index + 1)}`;
    failures.push(...actionPinFailures(location, specifier, match?.[2], extraActions));
  }
}

/**
 * Every per-file rule, in the gate's order.
 * @param {string[]} failures @param {string} relativePath @param {string} source
 * @param {ReadonlyMap<string, readonly [string, string]>} extraActions
 */
export function validateWorkflowFile(failures, relativePath, source, extraActions) {
  checkPermissions(failures, relativePath, source);
  checkPushNeverCancels(failures, relativePath, source);
  checkEditedRunConcurrency(failures, relativePath, source);
  checkRequiredChecksRunInQueue(failures, relativePath, source);
  checkNoPullRequestTarget(failures, relativePath, source);
  checkRunnerPolicy(failures, relativePath, source);
  checkPublicReleaseJobs(failures, relativePath, source);
  checkInternalOnlyJobs(failures, relativePath, source);
  checkActionPins(failures, relativePath, source, extraActions);
}
