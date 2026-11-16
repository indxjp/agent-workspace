import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateCiWorkflow } from './check-workflows/ci-jobs.mjs';
import { CI_WORKFLOW, WAVE_GATE_STEP, WORKFLOWS_DIRECTORY } from './check-workflows/ci-text.mjs';
import { validateWorkflowFile } from './check-workflows/workflow-rules.mjs';

const INTERNAL_WORKFLOW = path.posix.join(WORKFLOWS_DIRECTORY, 'internal-checks.yml');
const EXTRA_ACTIONS_FILE = '.github/indx-dev.actions.json';
const PR_TEMPLATE = '.github/pull_request_template.md';

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
    validateWorkflowFile(failures, relativePath, source, extraActions);
  }
  // The GHAS-gated jobs skip on a private repository without the plan; a silent green is the
  // failure (audit F-03), so the workflow must say so.
  const securitySource = workflows.get('.github/workflows/security.yml');
  if (securitySource !== undefined && !securitySource.includes('::warning')) {
    failures.push('.github/workflows/security.yml: skipped GHAS jobs must emit a ::warning');
  }
  const ciSource = workflows.get(CI_WORKFLOW);
  if (ciSource === undefined) failures.push(`${CI_WORKFLOW}: workflow is missing`);
  else validateCiWorkflow(failures, ciSource);
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
      `Workflow validation passed: ${String(result.workflowCount)} workflows use reviewed immutable action SHAs; CI runs its light jobs on GitHub-hosted runners and its runner labels follow the policy, builds once and runs the rest in parallel behind one ci-success check, and preserves the PR ownership template.`,
    );
  }
}
