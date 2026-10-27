import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { isInternalOnlyJob, workflowJobs } from './ci/workflow-jobs.mjs';

const WORKFLOWS_DIRECTORY = '.github/workflows';
const CI_WORKFLOW = path.posix.join(WORKFLOWS_DIRECTORY, 'ci.yml');
const INTERNAL_WORKFLOW = path.posix.join(WORKFLOWS_DIRECTORY, 'internal-checks.yml');
const WAVE_GATE_STEP = 'Wave plans declare disjoint ownership';
const EXTRA_ACTIONS_FILE = '.github/indx-dev.actions.json';
const PR_TEMPLATE = '.github/pull_request_template.md';
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

/** @param {string} source @param {string} jobId */
function jobBlock(source, jobId) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start < 0) return null;
  const nextJob = lines.findIndex(
    (line, index) => index > start && /^ {2}[a-zA-Z0-9_-]+:\s*$/u.test(line),
  );
  return lines.slice(start, nextJob < 0 ? undefined : nextJob).join('\n');
}

// The two job-level gates of ci.yml's tiers (ci.yml, COST; ADR-0053, Amendment 2026-10-24): the
// heavy tier runs nightly, on a dispatch, on a `ci:full` pull request (never on its `edited` runs,
// which skip `build`) and as the release gate (`inputs.full`); `formal` and `image-scan` also run
// in the merge queue, path-scoped.
const HEAVY_TIER_CONDITION =
  "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || inputs.full || (github.event.action != 'edited' && contains(github.event.pull_request.labels.*.name, 'ci:full'))";
const QUEUE_TIER_CONDITION = `github.event_name == 'merge_group' || ${HEAVY_TIER_CONDITION}`;
/** @param {string} text */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const SCOPE_APPLIES = "if: steps.scope.outputs.applies == 'true'";

/**
 * The policy every required, path-scoped job of ci.yml shares (`formal`, `generated-project-e2e`,
 * `journey-e2e`, `docs-claims`, `tool-sandbox-e2e`). ci-success counts a skipped job as a failure, so such a job filters paths in a
 * `scope` step and must still really run its check when the diff reaches it. Text checks, like the
 * rest of this file, but each one closes a way to keep the job green while it runs nothing: a
 * job-level `if` (however the key is quoted or spaced), `continue-on-error`, a scope step that
 * fails open (`git diff | grep -q` under pipefail dies of SIGPIPE on a long diff and reads as "no
 * match") or answers false for a push or a dispatch (no DIFF_BASE), and a check whose `run:` line is commented out,
 * suffixed (`|| true`) or guarded by any condition other than the scope step's answer.
 * @param {string[]} failures
 * @param {string} job
 * @param {string} jobId
 * @param {readonly (string | readonly [command: string, guard: string])[]} commands each must be a
 *   step whose whole `run:` value is this command, guarded by the scope step's answer only, or by
 *   the given guard (a matrix leg's condition joined to that answer)
 */
function checkScopedRequiredJob(failures, job, jobId, commands) {
  // The one job-level `if` allowed is a tier gate of ci.yml (COST): the heavy tier's, or for
  // `formal` the queue tier's. ci-success accepts the skip on a pull request, a push and in the
  // queue only.
  const tier = jobId === 'formal' ? QUEUE_TIER_CONDITION : HEAVY_TIER_CONDITION;
  const withoutQueueTier = job.replace(
    new RegExp(`^ {4}if: >-\\r?\\n {6}${escapeRegExp(tier)}\\r?\\n`, 'mu'),
    '',
  );
  if (/^ {4}(['"]?)if\1[ \t]*:/mu.test(withoutQueueTier)) {
    failures.push(
      `${CI_WORKFLOW}: ${jobId} must not be skipped at job level; filter paths in a step`,
    );
  }
  if (/^[ \t]*(?:-[ \t]+)?(['"]?)continue-on-error\1[ \t]*:/mu.test(job)) {
    failures.push(`${CI_WORKFLOW}: ${jobId} must not use continue-on-error`);
  }
  /** @type {string[][]} */
  const steps = [];
  for (const line of job.split(/\r?\n/u)) {
    if (/^ {6}- /u.test(line)) steps.push([line]);
    else steps.at(-1)?.push(line);
  }
  const scope = steps.find((step) => step.some((line) => line.trim() === 'id: scope'));
  if (scope === undefined) {
    failures.push(`${CI_WORKFLOW}: ${jobId} must decide its path scope in a step with id: scope`);
  } else {
    const body = scope.join('\n');
    if (/\|[ \t]*grep\b[^\n]*[ \t]-[A-Za-z]*q/u.test(body)) {
      failures.push(
        `${CI_WORKFLOW}: ${jobId} scope step must not pipe into grep -q (fails open under pipefail); read the list first`,
      );
    }
    if (
      !/if \[ -z "\$DIFF_BASE" \]; then\n {12}echo "applies=true" >> "\$GITHUB_OUTPUT"\n {12}exit 0\n/u.test(
        body,
      )
    ) {
      failures.push(
        `${CI_WORKFLOW}: ${jobId} scope step must answer applies=true for every event without a diff base`,
      );
    }
  }
  for (const entry of commands) {
    const [command, guard] = typeof entry === 'string' ? [entry, SCOPE_APPLIES] : entry;
    const step = steps.find((candidate) => candidate.includes(`        run: ${command}`));
    const conditions = step?.filter((line) => /^ {8}(['"]?)if\1[ \t]*:/u.test(line)) ?? [];
    if (step === undefined || conditions.length !== 1 || conditions[0] !== `        ${guard}`) {
      failures.push(
        `${CI_WORKFLOW}: ${jobId} must include run: ${command} as a whole step guarded only by ${guard}`,
      );
    }
  }
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
  if (!/^ {2}pull_request:\s*(#.*)?$/u.test(lines[header] ?? '')) return null;
  /** @type {string[]} */
  const block = [];
  for (const line of lines.slice(header + 1)) {
    if (line.trim() !== '' && !line.startsWith('    ')) break;
    block.push(line);
  }
  const at = block.findIndex((line) => /^ {4}types\b/u.test(line));
  if (at === -1) return new Set();
  const value = (block[at] ?? '')
    .replace(/^ {4}types:/u, '')
    .replace(/#.*$/u, '')
    .trim();
  /** @type {string[]} */
  const items = [];
  if (/^\[[^\]]*\]$/u.test(value)) {
    items.push(...value.slice(1, -1).split(','));
  } else if (value === '') {
    for (const line of block.slice(at + 1)) {
      const item = /^ {6,}-\s*([^#]*)/u.exec(line);
      if (item === null) break;
      items.push(item[1] ?? '');
    }
  }
  const events = new Set(items.map((type) => type.trim()).filter((type) => type !== ''));
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

/**
 * Validate already-loaded workflow documents. Exported so negative fixtures test the policy.
 * @param {ReadonlyMap<string, string>} workflows
 * @param {string} _prTemplate unused since the ownership gate was removed; kept so callers need no change
 * @param {boolean} [hasInternalWaves]
 * @param {ReadonlyMap<string, readonly [string, string]>} [extraActions] pins from the export-excluded
 *   `.github/indx-dev.actions.json`; a missing file only makes the check stricter.
 */
export function validateWorkflowDocuments(
  workflows,
  _prTemplate,
  hasInternalWaves = false,
  extraActions = new Map(),
) {
  /** @type {string[]} */
  const failures = [];
  // The wave-plan ownership gate runs from its own export-excluded workflow, so the internal
  // repository can never lose it: it must exist whenever the internal wave records do, and carry the step.
  const internalChecks = workflows.get(INTERNAL_WORKFLOW);
  if (internalChecks === undefined ? hasInternalWaves : !internalChecks.includes(WAVE_GATE_STEP)) {
    failures.push(`${INTERNAL_WORKFLOW}: must exist and contain the step "${WAVE_GATE_STEP}"`);
  }
  for (const [relativePath, source] of workflows) {
    if (!/^permissions:/mu.test(source)) {
      failures.push(`${relativePath}: workflow must declare top-level permissions`);
    }
    // A push to main must never cancel an earlier main run (audit F-02): CI there is the trunk's only signal.
    if (/^ {2}push:/mu.test(source) && /^ {2}cancel-in-progress:\s*true\s*$/mu.test(source)) {
      failures.push(
        `${relativePath}: concurrency.cancel-in-progress must not be true on a workflow that runs on push; make it conditional on github.event_name == pull_request`,
      );
    }
    // A PR body edit re-runs only the fast checks; if it shares a cancel-in-progress group with the
    // code run it cancels the real tests, and the skipped jobs still let CI success report green.
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
    if (/^\s*pull_request_target:/mu.test(source)) {
      failures.push(`${relativePath}: pull_request_target is prohibited`);
    }
    if (RUNNER_POLICY_WORKFLOWS.has(relativePath)) {
      let jobId = '';
      for (const [index, line] of source.split(/\r?\n/u).entries()) {
        jobId = line.match(/^ {2}([a-zA-Z0-9_-]+):\s*$/u)?.[1] ?? jobId;
        const runsOn = line.match(/^\s*runs-on:\s*(.+?)\s*$/u);
        if (runsOn === null) continue;
        const label = runsOn[1] ?? '';
        if (label === MS_A2_RUNS_ON) continue;
        if (OFFLOADED_JOBS.get(`${relativePath}#${jobId}`) === label) continue;
        failures.push(
          `${relativePath}:${String(index + 1)}: runs-on "${label}" is not ${MS_A2_RUNS_ON} — every Linux CI job runs on the MS-A2 pool here and GitHub-hosted elsewhere`,
        );
      }
    }
    if (PUBLIC_RELEASE_WORKFLOWS.has(relativePath)) {
      for (const job of workflowJobs(source)) {
        const lines = job.lines.map(({ text }) => text);
        if (!lines.includes(PUBLIC_RELEASE_GUARD))
          failures.push(
            `${relativePath}#${job.id}: a release job must have${PUBLIC_RELEASE_GUARD}`,
          );
        const runsOn = lines.find((text) => /^ {4}runs-on:/u.test(text));
        if (runsOn !== undefined && runsOn.trim() !== 'runs-on: ubuntu-latest')
          failures.push(`${relativePath}#${job.id}: a release job runs on ubuntu-latest`);
      }
    }
    if (INTERNAL_ONLY_WORKFLOWS.has(relativePath)) {
      for (const job of workflowJobs(source)) {
        if (!isInternalOnlyJob(job.lines))
          failures.push(
            `${relativePath}#${job.id}: an internal-only job must start with if: github.repository_owner == 'INDXDev' (alone, or && one parenthesised condition)`,
          );
      }
    }
    for (const [index, line] of source.split(/\r?\n/u).entries()) {
      const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?\s*$/u);
      if (match === null) continue;
      const specifier = match[1];
      const versionComment = match[2];
      if (specifier === undefined || specifier.startsWith('./')) continue;
      const separator = specifier.lastIndexOf('@');
      const action = separator < 1 ? specifier : specifier.slice(0, separator);
      const ref = separator < 1 ? '' : specifier.slice(separator + 1);
      const location = `${relativePath}:${String(index + 1)}`;
      if (!IMMUTABLE_REF.test(ref)) {
        failures.push(`${location}: ${action} must use an immutable 40-character commit SHA`);
        continue;
      }
      const approved = approvedActions.get(action) ?? extraActions.get(action);
      if (approved === undefined) {
        failures.push(`${location}: ${action} is not in the reviewed action allowlist`);
        continue;
      }
      const [approvedRef, approvedVersion] = approved;
      if (ref !== approvedRef) {
        failures.push(`${location}: ${action}@${ref} does not match reviewed ${approvedRef}`);
      }
      if (versionComment !== approvedVersion) {
        failures.push(
          `${location}: keep the human-readable version comment "# ${approvedVersion}"`,
        );
      }
    }
  }

  // The GHAS-gated jobs skip on a private repository without the plan; a silent green is the
  // failure (audit F-03), so the workflow must say so.
  const securitySource = workflows.get('.github/workflows/security.yml');
  if (securitySource !== undefined && !securitySource.includes('::warning')) {
    failures.push('.github/workflows/security.yml: skipped GHAS jobs must emit a ::warning');
  }
  const ciSource = workflows.get(CI_WORKFLOW);
  if (ciSource === undefined) {
    failures.push(`${CI_WORKFLOW}: workflow is missing`);
  } else {
    const fastChecks = jobBlock(ciSource, 'fast-checks');
    const heavyChecks = jobBlock(ciSource, 'heavy-checks');
    const fullE2e = jobBlock(ciSource, 'full-e2e');
    if (fastChecks === null) {
      failures.push(`${CI_WORKFLOW}: missing fast-checks job`);
    } else {
      if (/^ {4}services:/mu.test(fastChecks)) {
        failures.push(`${CI_WORKFLOW}: fast-checks must not provision service containers`);
      }
      const requiredFastChecks = [
        'Workflow policy and PR template gate',
        'node scripts/ci/check-nx-cache-config.mjs',
        'Changelog fragment gate',
        'No new type or lint suppressions in the diff',
        'Generated blocks are current',
        'pnpm dedupe --check',
        'pnpm format:check',
        'pnpm stories:check --base',
        'node scripts/check-licenses.mjs --dev',
        'Secret scan (gitleaks)',
        'Dependency vulnerability scan (osv-scanner)',
      ];
      for (const requiredCheck of requiredFastChecks) {
        if (!fastChecks.includes(requiredCheck)) {
          failures.push(`${CI_WORKFLOW}: fast-checks must include ${requiredCheck}`);
        }
      }
      if (fastChecks.includes('package-exports:check:artifacts')) {
        failures.push(`${CI_WORKFLOW}: built-artifact validation belongs in heavy-checks`);
      }
      // fast-checks is the job that fails a malformed pull request in seconds, so it waits for no
      // other job and runs no Nx task: anything that needs built packages belongs behind `build`.
      if (/^ {4}needs:/mu.test(fastChecks)) {
        failures.push(`${CI_WORKFLOW}: fast-checks must not wait for another job`);
      }
      if (/^\s+(?:run: )?scripts\/ci\/nx\.sh /mu.test(fastChecks)) {
        failures.push(
          `${CI_WORKFLOW}: fast-checks must not run Nx tasks; they belong behind build`,
        );
      }
    }

    // `build` builds every workspace but embedded once and hands the outputs to the other jobs;
    // `build-embedded` builds embedded beside it and runs embedded's tests, which read that build,
    // under the same no-skip gate as the test shards.
    const build = jobBlock(ciSource, 'build');
    if (build === null) {
      failures.push(`${CI_WORKFLOW}: missing build job`);
    } else {
      for (const requiredCheck of [
        'run: scripts/ci/nx.sh run-many -t build --exclude=@indx-workspace/embedded ',
        'name: workspace-build',
      ]) {
        if (!build.includes(requiredCheck)) {
          failures.push(`${CI_WORKFLOW}: build must include ${requiredCheck}`);
        }
      }
    }
    const buildEmbedded = jobBlock(ciSource, 'build-embedded');
    if (buildEmbedded === null) {
      failures.push(`${CI_WORKFLOW}: missing build-embedded job`);
    } else {
      for (const requiredCheck of [
        'scripts/ci/nx.sh run @indx-workspace/embedded:build ',
        'name: embedded-build',
        'run: scripts/ci/nx.sh run @indx-workspace/embedded:test ',
        'run: node scripts/ci/vitest-no-skip.mjs',
      ]) {
        if (!buildEmbedded.includes(requiredCheck)) {
          failures.push(`${CI_WORKFLOW}: build-embedded must include ${requiredCheck}`);
        }
      }
    }
    // The jobs that pack the published set need embedded's build too. They run after `build`
    // and beside build-embedded, and .github/actions/workspace-build waits for its artifact (it
    // reads the run's API, hence `actions: read`). A job that restored only `workspace-build`
    // would pack without embedded and fail late.
    // journey-e2e and docs-claims run on paid Blacksmith runners, so they need build-embedded
    // outright rather than wait for its artifact on the clock.
    for (const jobId of ['release-checks', 'generated-project-e2e', 'journey-e2e', 'docs-claims']) {
      const job = jobBlock(ciSource, jobId);
      if (
        job === null ||
        !/^ {4}needs: (build|\[build, build-embedded\])$/mu.test(job) ||
        !/^ {6}actions: read$/mu.test(job) ||
        !/uses: \.\/\.github\/actions\/workspace-build\n {8,10}with:\n {10,12}embedded: 'true'/u.test(
          job,
        )
      ) {
        failures.push(
          `${CI_WORKFLOW}: ${jobId} must need build, have actions: read and restore the workspace build with embedded: 'true'`,
        );
      }
    }

    // Typecheck and lint, one target per runner. Both spellings are required: the affected run
    // is what a pull request gets, the run-many is what `main` gets, and a workflow that dropped
    // either would silently narrow one of the two. Both go through scripts/ci/nx.sh, so a
    // remote-cache outage cannot fail them (docs/adr/0110).
    const typecheckLint = jobBlock(ciSource, 'typecheck-lint');
    if (typecheckLint === null) {
      failures.push(`${CI_WORKFLOW}: missing typecheck-lint job`);
    } else {
      for (const requiredCheck of [
        'target: [typecheck, lint]',
        'uses: ./.github/actions/workspace-build',
        'scripts/ci/nx.sh affected -t ${{ matrix.target }}',
        'scripts/ci/nx.sh run-many -t ${{ matrix.target }}',
        'pnpm architecture:check',
        'pnpm deadcode:check',
        'pnpm duplication:check',
      ]) {
        if (!typecheckLint.includes(requiredCheck)) {
          failures.push(`${CI_WORKFLOW}: typecheck-lint must include ${requiredCheck}`);
        }
      }
    }

    if (heavyChecks === null) {
      failures.push(`${CI_WORKFLOW}: missing heavy-checks job`);
    } else {
      // heavy-checks runs BESIDE fast-checks, not behind it: the two gate jobs no longer queue
      // on one another, and ci-success (below) is the single check that requires both. A
      // `needs: fast-checks` here would put the static gates back on the test job's critical
      // path.
      if (/^ {4}needs:.*fast-checks/mu.test(heavyChecks)) {
        failures.push(`${CI_WORKFLOW}: heavy-checks must run in parallel with fast-checks`);
      }
      if (
        !/^ {4}services:\s*$/mu.test(heavyChecks) ||
        !heavyChecks.includes('postgres:17-alpine')
      ) {
        failures.push(`${CI_WORKFLOW}: heavy-checks must provision the PostgreSQL 17 service`);
      }
      for (const requiredCheck of [
        'uses: ./.github/actions/workspace-build',
        'PostgreSQL service is a real PostgreSQL 17',
        'Start the S3 test server for the object-store contract suite',
        // Same pair as typecheck-lint: the affected projects for pull requests, all for main.
        'nx show projects --with-target test --affected',
        'nx show projects --with-target test)',
        'scripts/ci/nx.sh run-many -t test',
        'No test in the run was skipped',
        'run: node scripts/ci/vitest-no-skip.mjs',
        // Tested in build-embedded, which is checked above to run them.
        "ELSEWHERE_PROJECTS: '@indx-workspace/embedded'",
      ]) {
        if (!heavyChecks.includes(requiredCheck)) {
          failures.push(`${CI_WORKFLOW}: heavy-checks must include ${requiredCheck}`);
        }
      }
      // The test shards: `rest` runs every project NAMED_PROJECTS does not list, so the list
      // must be exactly the projects the named shards run — a project in a shard but missing
      // from the list would run twice, one in the list but in no shard would never run.
      const shardProjects = [...heavyChecks.matchAll(/^ {12}projects: '?([^'\n]*)'?$/gmu)]
        .flatMap((match) => (match[1] ?? '').split(/\s+/u))
        .filter((project) => project !== '')
        .sort();
      const namedProjects = (heavyChecks.match(/^ {10}NAMED_PROJECTS: '([^']*)'$/mu)?.[1] ?? '')
        .split(/\s+/u)
        .filter((project) => project !== '')
        .sort();
      if (
        !/^ {10}- shard: rest\n {12}projects: ''$/mu.test(heavyChecks) ||
        shardProjects.length === 0 ||
        shardProjects.join(' ') !== namedProjects.join(' ')
      ) {
        failures.push(
          `${CI_WORKFLOW}: heavy-checks NAMED_PROJECTS must list exactly the projects of its named shards, beside a \`rest\` shard with no projects`,
        );
      }
      for (const { label, command } of [
        { label: 'pnpm typecheck', command: /^\s+run: pnpm typecheck$/mu },
        { label: 'pnpm lint', command: /^\s+run: pnpm lint$/mu },
        { label: 'pnpm architecture:check', command: /^\s+run: pnpm architecture:check$/mu },
        { label: 'pnpm deadcode:check', command: /^\s+run: pnpm deadcode:check$/mu },
        { label: 'pnpm duplication:check', command: /^\s+run: pnpm duplication:check$/mu },
      ]) {
        if (command.test(heavyChecks)) {
          failures.push(`${CI_WORKFLOW}: heavy-checks repeats fast check ${label}`);
        }
      }
      for (const misplacedCheck of [
        'No new type or lint suppressions in the diff',
        WAVE_GATE_STEP,
        'Generated blocks are current',
      ]) {
        if (heavyChecks.includes(misplacedCheck)) {
          failures.push(`${CI_WORKFLOW}: heavy-checks must not contain ${misplacedCheck}`);
        }
      }
    }
    if (fullE2e === null || !/^ {4}needs: \[fast-checks, heavy-checks\]$/mu.test(fullE2e)) {
      failures.push(`${CI_WORKFLOW}: full-e2e must depend on fast-checks and heavy-checks`);
    }
    const releaseChecks = jobBlock(ciSource, 'release-checks');
    if (releaseChecks === null) {
      failures.push(`${CI_WORKFLOW}: missing release-checks job`);
    } else {
      for (const requiredCheck of [
        'uses: ./.github/actions/workspace-build',
        'run: pnpm package-exports:check:artifacts',
        'run: pnpm release:pack --smoke',
        'run: pnpm release:check',
      ]) {
        if (!releaseChecks.includes(requiredCheck)) {
          failures.push(`${CI_WORKFLOW}: release-checks must include ${requiredCheck}`);
        }
      }
    }
    // The Lean specification job (docs/adr/0060). Its path filter lives in a step, never on
    // the job, because ci-success counts a skipped job as a failure; so the job must exist, must
    // not be conditional at job level, and must keep the checksum-verified elan install, the
    // soundness/generated-artefact check and the vector replay.
    const formal = jobBlock(ciSource, 'formal');
    if (formal === null) {
      failures.push(`${CI_WORKFLOW}: missing formal job`);
    } else {
      checkScopedRequiredJob(failures, formal, 'formal', [
        'pnpm formal:build',
        'pnpm formal:check',
      ]);
      for (const requiredCheck of ['sha256sum -c', 'tests/formal']) {
        if (!formal.includes(requiredCheck)) {
          failures.push(`${CI_WORKFLOW}: formal must include ${requiredCheck}`);
        }
      }
    }
    // The generated-project E2E (#398): a new user's whole flow against the change's own packages
    // and images. Required, so like `formal` it filters paths in a step and never at job level.
    const generatedProject = jobBlock(ciSource, 'generated-project-e2e');
    if (generatedProject === null) {
      failures.push(`${CI_WORKFLOW}: missing generated-project-e2e job`);
    } else {
      checkScopedRequiredJob(failures, generatedProject, 'generated-project-e2e', [
        'node tests/generated-project/run.mjs',
      ]);
    }
    // The developer-journey exit test (S1-19, #514): required, so like `formal` it filters paths
    // in a step and never at job level.
    const journey = jobBlock(ciSource, 'journey-e2e');
    if (journey === null) {
      failures.push(`${CI_WORKFLOW}: missing journey-e2e job`);
    } else {
      // Two legs: the journey, and the first-hour stopwatch beside it.
      checkScopedRequiredJob(failures, journey, 'journey-e2e', [
        [
          'node tests/journey/run.mjs',
          "if: matrix.part == 'journey' && steps.scope.outputs.applies == 'true'",
        ],
      ]);
      if (!/^ {8}part: \[journey, first-hour\]$/mu.test(journey)) {
        failures.push(
          `${CI_WORKFLOW}: journey-e2e must run the matrix part: [journey, first-hour]`,
        );
      }
    }
    // The docs claims (#880): required, filtered in a step like the journey.
    const docsClaims = jobBlock(ciSource, 'docs-claims');
    if (docsClaims === null) {
      failures.push(`${CI_WORKFLOW}: missing docs-claims job`);
    } else {
      checkScopedRequiredJob(failures, docsClaims, 'docs-claims', [
        'node tests/docs-claims/run.mjs',
      ]);
    }
    // The tool sandbox E2E (#847, ADR-0118): required, so like `formal` it filters paths in a step
    // and never at job level.
    const toolSandbox = jobBlock(ciSource, 'tool-sandbox-e2e');
    if (toolSandbox === null) {
      failures.push(`${CI_WORKFLOW}: missing tool-sandbox-e2e job`);
    } else {
      checkScopedRequiredJob(failures, toolSandbox, 'tool-sandbox-e2e', [
        'node tests/e2e/tool-sandbox.e2e.mjs',
      ]);
    }
    const ciSuccess = jobBlock(ciSource, 'ci-success');
    // The flow list, on one line or as Prettier wraps it once it passes the print width.
    const needs = ciSuccess
      ?.match(/^ {4}needs:\s*\[([^\]]*)\]$/mu)?.[1]
      ?.split(',')
      .map((need) => need.trim())
      .filter((need) => need !== '')
      .join(', ');
    if (
      ciSuccess === null ||
      !/^ {4}if: always\(\)$/mu.test(ciSuccess) ||
      needs !==
        'fast-checks, build, build-embedded, typecheck-lint, heavy-checks, release-checks, release-images, formal, image-scan, generated-project-e2e, journey-e2e, docs-claims, tool-sandbox-e2e, coverage, browser'
    ) {
      failures.push(
        `${CI_WORKFLOW}: ci-success must run with if: always() and need fast-checks, build, build-embedded, typecheck-lint, heavy-checks, release-checks, release-images, formal, image-scan, generated-project-e2e, journey-e2e, docs-claims, tool-sandbox-e2e, coverage and browser`,
      );
    }
  }

  return failures;
}

/** @param {string} [repositoryRoot] */
export async function validateWorkflows(repositoryRoot = process.cwd()) {
  const workflowsDirectory = path.join(repositoryRoot, WORKFLOWS_DIRECTORY);
  const workflowFiles = (await readdir(workflowsDirectory))
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  /** @type {Map<string, string>} */
  const workflows = new Map();
  for (const filename of workflowFiles) {
    const relativePath = path.posix.join(WORKFLOWS_DIRECTORY, filename);
    workflows.set(relativePath, await readFile(path.join(repositoryRoot, relativePath), 'utf8'));
  }
  const prTemplate = await readFile(path.join(repositoryRoot, PR_TEMPLATE), 'utf8');
  const extraFile = path.join(repositoryRoot, EXTRA_ACTIONS_FILE);
  const extraActions = existsSync(extraFile)
    ? new Map(Object.entries(JSON.parse(await readFile(extraFile, 'utf8'))))
    : new Map();
  return {
    failures: validateWorkflowDocuments(
      workflows,
      prTemplate,
      existsSync(path.join(repositoryRoot, 'internal', 'waves')),
      extraActions,
    ),
    workflowCount: workflowFiles.length,
  };
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  const result = await validateWorkflows();
  if (result.failures.length > 0) {
    console.error(
      `Workflow validation failed:\n${result.failures.map((failure) => `- ${failure}`).join('\n')}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Workflow validation passed: ${String(result.workflowCount)} workflows use reviewed immutable action SHAs; CI keeps its gate jobs on the MS-A2 runner pool, builds once and runs the rest in parallel behind one ci-success check, and preserves the PR ownership template.`,
    );
  }
}
