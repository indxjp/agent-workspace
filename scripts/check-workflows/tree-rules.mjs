// The rules that read what a workflow RUNS rather than how it is triggered, moved here from the Vitest
// files that asserted them on the real tree (ADR-0053, Amendment 2026-11-19e):
// tests/actionlint-config.test.ts, tests/tooling/workflow-aw-build.test.ts and
// tests/tooling/workflow-cloud-run-env.test.ts. `pnpm workflows:check` holds the tree to them in
// fast-checks; tests/tooling/workflow-tree-rules.test.ts holds the rules to fixtures.
import path from 'node:path';

import { WORKFLOWS_DIRECTORY } from './ci-text.mjs';
import { checkServiceImages } from './docker-hub.mjs';

const HOSTED = /^(?:ubuntu|windows|macos)-(?:latest|\d+(?:\.\d+)?)(?:-arm)?$/u;
export const ACTIONLINT_CONFIG = '.github/actionlint.yaml';

/** @param {string} line */
const indent = (line) => line.length - line.trimStart().length;

/**
 * A block list's `- item` values, read from the lines after its key.
 * @param {readonly string[]} lines
 */
function blockList(lines) {
  /** @type {string[]} */
  const items = [];
  for (const next of lines) {
    const item = /^\s*-\s+(.+)$/u.exec(next)?.[1];
    if (item === undefined) break;
    items.push(item.replace(/^["']|["']$/gu, ''));
  }
  return items;
}

/**
 * The values a job's matrix gives `key`: each `key:` line in the job, inline or as a block list.
 * @param {readonly string[]} job @param {string} key
 */
function matrixValues(job, key) {
  const pattern = new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(.*)$`, 'u');
  return job.flatMap((line, index) => {
    const value = pattern.exec(line)?.[1]?.trim();
    if (value === undefined) return [];
    if (value === '') return [`[${blockList(job.slice(index + 1)).join(',')}]`];
    return [value.replace(/^["']|["']$/gu, '')];
  });
}

/**
 * Each `runs-on` value: an inline one as written, a bare `runs-on:` as the `[a, b]` list its
 * block-list `- label` lines spell, and `${{ matrix.<key> }}` as each value the job's matrix gives
 * that key.
 * @param {string} workflow
 */
function runsOnValues(workflow) {
  const lines = workflow.split(/\r?\n/u);
  return lines.flatMap((line, index) => {
    const value = /^\s*runs-on:\s*(.*)$/u.exec(line)?.[1]?.trim();
    if (value === undefined) return [];
    if (value === '') return [`[${blockList(lines.slice(index + 1)).join(',')}]`];
    const key = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/u.exec(value)?.[1];
    if (key === undefined) return [value];
    // The job is every line around runs-on indented at least as deep as it.
    const depth = indent(line);
    /** @param {string} other */
    const inJob = (other) => other.trim() === '' || indent(other) >= depth;
    let start = index;
    while (start > 0 && inJob(lines[start - 1] ?? '')) start -= 1;
    let end = index + 1;
    while (end < lines.length && inJob(lines[end] ?? '')) end += 1;
    return matrixValues(lines.slice(start, end), key);
  });
}

/**
 * The literals of an expression's quoted strings. A runner group object,
 * `fromJSON('{"group":…,"labels":[…]}')`, gives its `labels` only: its keys and the group name are
 * not labels (actionlint reads no group).
 * @param {string} value
 */
function expressionLabels(value) {
  const object = /fromJSON\('(\{.*?\})'\)/u.exec(value)?.[1];
  const rest = object === undefined ? value : value.replace(object, '');
  /** @type {unknown} */
  const parsed = object === undefined ? undefined : JSON.parse(object);
  const labels =
    typeof parsed === 'object' &&
    parsed !== null &&
    'labels' in parsed &&
    Array.isArray(parsed.labels)
      ? parsed.labels.map(String)
      : [];
  return [
    ...labels,
    ...Array.from(rest.matchAll(/["']([a-z0-9][a-z0-9.-]*)["']/gu), (match) => match[1] ?? ''),
  ];
}

/**
 * The literal runner labels in a workflow's `runs-on` values, the hosted ones left out, sorted.
 * @param {string} workflow
 */
export function customRunnerLabels(workflow) {
  /** @type {Set<string>} */
  const labels = new Set();
  for (const value of runsOnValues(workflow)) {
    const literals = value.startsWith('[')
      ? value.replace(/[[\]]/gu, '').split(',')
      : value.startsWith('${{')
        ? expressionLabels(value)
        : [value];
    for (const label of literals.map((literal) => literal.trim())) {
      if (label !== '' && label !== 'self-hosted' && !HOSTED.test(label) && !label.includes('$')) {
        labels.add(label);
      }
    }
  }
  return [...labels].sort();
}

/** @param {string} config the text of .github/actionlint.yaml */
export function configuredRunnerLabels(config) {
  return Array.from(config.matchAll(/^ {4}- ([a-z0-9][a-z0-9.-]*)$/gmu), (match) => match[1] ?? '');
}

/**
 * actionlint only knows GitHub's hosted runner labels, so `.github/actionlint.yaml` lists every
 * other label a workflow's `runs-on` names. A label missing there makes actionlint report each job
 * that uses it as an unknown runner (#1835).
 * @param {string[]} failures @param {ReadonlyMap<string, string>} workflows
 * @param {string} actionlintConfig
 */
export function checkActionlintLabels(failures, workflows, actionlintConfig) {
  const configured = new Set(configuredRunnerLabels(actionlintConfig));
  for (const [relativePath, source] of workflows) {
    for (const label of customRunnerLabels(source)) {
      if (!configured.has(label)) {
        failures.push(
          `${relativePath}: runner label "${label}" is missing from ${ACTIONLINT_CONFIG} (self-hosted-runner.labels), so actionlint reports it as unknown`,
        );
      }
    }
  }
}

const AW = '@indx-workspace/aw';
const PLATFORMS = '@indx-workspace/platforms';

/**
 * aw imports @indx-workspace/platforms from dist, so a workflow that builds aw from source must
 * build platforms too (or build aw's whole dependency closure with `aw...`).
 * @param {string[]} failures @param {string} relativePath @param {string} source
 */
function checkAwBuildsPlatforms(failures, relativePath, source) {
  const awProject = new RegExp(`${AW}(?![\\w/-])`, 'u');
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!/\bbuild\b/u.test(line) || !awProject.test(line)) continue;
    if (line.includes(`${AW}...`) || line.includes(PLATFORMS)) continue;
    failures.push(
      `${relativePath}:${String(index + 1)}: builds ${AW} without ${PLATFORMS}, which aw imports from dist (add it, or build ${AW}...)`,
    );
  }
}

/**
 * gcloud splits a --set-env-vars / --update-env-vars list on commas, or on the delimiter a `^x^`
 * prefix names, so a value that holds one (a URL, a script, a service-account email with `@`)
 * breaks the deploy: live run 42182594901 failed on `RUNTIME_SA=…-runtime@…` under `^@^`. A
 * workflow passes Cloud Run environment through --env-vars-file and keeps --update-env-vars to one
 * plain NAME=value pair.
 * @param {string[]} failures @param {string} relativePath @param {string} source
 */
function checkCloudRunEnv(failures, relativePath, source) {
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const where = `${relativePath}:${String(index + 1)}`;
    if (/--set-env-vars[\s=]/u.test(line) && !line.trimStart().startsWith('#')) {
      failures.push(`${where}: never pass a --set-env-vars list; use --env-vars-file`);
    }
    for (const match of line.matchAll(/--update-env-vars[\s=]+("[^"]*"|\S+)/gu)) {
      const value = (match[1] ?? '').replace(/^"|"$/gu, '');
      if (!/^[A-Z_][A-Z0-9_]*=[^,^@]*$/u.test(value)) {
        failures.push(
          `${where}: --update-env-vars must be one NAME=value pair without a delimiter, not ${value}`,
        );
      }
    }
  }
}

const PREVIEW = path.posix.join(WORKFLOWS_DIRECTORY, 'gcp-cloudrun-preview.yml');
const IAM_PROBE_STEP = "Probe the runner manager's IAM condition";

/**
 * The live preview's IAM probe deploys from an env-vars file (its RUNTIME_SA holds an `@`) and
 * claims PERMISSION_DENIED once, only when gcloud's deploy log said it.
 * @param {string[]} failures @param {string} source
 */
function checkPreviewIamProbe(failures, source) {
  const start = source.indexOf(`      - name: ${IAM_PROBE_STEP}\n`);
  if (start < 0) {
    failures.push(`${PREVIEW}: the step "${IAM_PROBE_STEP}" is missing`);
    return;
  }
  const end = source.indexOf('\n      - name: ', start + 1);
  const step = source.slice(start, end < 0 ? undefined : end);
  const claims = step
    .split('\n')
    .filter((line) => line.includes('probe_failed') && line.includes('PERMISSION_DENIED'));
  if (
    !step.includes('--env-vars-file "$RUNNER_TEMP/iam-probe.env.yaml"') ||
    !/RUNTIME_SA=\$\{PREFIX\}-runtime@\$\{GCP_PROJECT\}\.iam\.gserviceaccount\.com/u.test(step) ||
    claims.length !== 1 ||
    !/if grep -q 'PERMISSION_DENIED' "\$deploy_log"; then\n\s+probe_failed "[^\n]*PERMISSION_DENIED/u.test(
      step,
    )
  ) {
    failures.push(
      `${PREVIEW}: "${IAM_PROBE_STEP}" must deploy from --env-vars-file "$RUNNER_TEMP/iam-probe.env.yaml" with RUNTIME_SA in it, and claim PERMISSION_DENIED once, only after grep found it in "$deploy_log"`,
    );
  }
}

/**
 * Every tree rule, in the gate's order. The actionlint rule runs only when the caller loaded the
 * config (scripts/check-workflows.mjs always does).
 * @param {string[]} failures @param {ReadonlyMap<string, string>} workflows
 * @param {string | undefined} actionlintConfig
 */
export function validateWorkflowTree(failures, workflows, actionlintConfig) {
  if (actionlintConfig !== undefined) checkActionlintLabels(failures, workflows, actionlintConfig);
  for (const [relativePath, source] of workflows) {
    checkAwBuildsPlatforms(failures, relativePath, source);
    checkCloudRunEnv(failures, relativePath, source);
    checkServiceImages(failures, relativePath, source);
  }
  const preview = workflows.get(PREVIEW);
  if (preview !== undefined) checkPreviewIamProbe(failures, preview);
}
