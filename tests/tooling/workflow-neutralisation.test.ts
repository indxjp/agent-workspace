import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateWorkflowDocuments } from '../../scripts/check-workflows.mjs';
import { repositoryWorkflowDocuments, mutateJob } from './workflow-documents.test-support.js';

describe('workflow validator', () => {
  /** Replace the scope guard on the step that runs `command` with `condition`. */
  /** The step's own `if:` (the last one before its `run:`) replaced by `condition`. */
  function guardRunStep(job: string, command: string, condition: string): string {
    const run = job.indexOf(`        run: ${command}\n`);
    const at = job.lastIndexOf('        if: ', run) + '        '.length;
    const lineEnd = job.indexOf('\n', at);
    if (run < 0 || at < '        '.length || lineEnd > run) {
      throw new Error(`no guarded run: ${command}`);
    }
    return job.slice(0, at) + condition + job.slice(lineEnd);
  }

  const scopedJobs = [
    ['formal', 'pnpm formal:build'],
    ['generated-project-e2e', 'node tests/generated-project/run.mjs'],
    ['app-kit-e2e', 'node tests/app-kit/run.mjs'],
    ['apps-e2e', 'node tests/apps/lane.mjs'],
    ['journey-e2e', 'node tests/journey/run.mjs'],
    ['docs-claims', 'node tests/docs-claims/run.mjs'],
    ['tool-sandbox-e2e', 'node tests/e2e/tool-sandbox.e2e.mjs'],
  ] as const;

  const neutralisations: readonly (readonly [
    string,
    (job: string, jobId: string, command: string) => string,
    (jobId: string, command: string) => string,
  ])[] = [
    [
      'a quoted job-level if',
      (job, jobId) => job.replace(`  ${jobId}:\n`, `  ${jobId}:\n    'if': false\n`),
      (jobId) => `${jobId} must not be skipped at job level`,
    ],
    [
      'a spaced job-level if',
      (job, jobId) => job.replace(`  ${jobId}:\n`, `  ${jobId}:\n    if : false\n`),
      (jobId) => `${jobId} must not be skipped at job level`,
    ],
    [
      'a job-level continue-on-error',
      (job, jobId) => job.replace(`  ${jobId}:\n`, `  ${jobId}:\n    continue-on-error: true\n`),
      (jobId) => `${jobId} must not use continue-on-error`,
    ],
    [
      'a step-level continue-on-error',
      (job, _jobId, command) =>
        job.replace(
          `        run: ${command}\n`,
          `        continue-on-error: true\n        run: ${command}\n`,
        ),
      (jobId) => `${jobId} must not use continue-on-error`,
    ],
    [
      'a run line suffixed with || true',
      (job, _jobId, command) =>
        job.replace(`        run: ${command}\n`, `        run: ${command} || true\n`),
      (jobId, command) => `${jobId} must include run: ${command} as a whole step`,
    ],
    [
      'a run line kept only in a comment',
      (job, _jobId, command) =>
        job.replace(
          `        run: ${command}\n`,
          `        # run: ${command}\n        run: echo skipped\n`,
        ),
      (jobId, command) => `${jobId} must include run: ${command} as a whole step`,
    ],
    [
      'a run step guarded by if: false',
      (job, _jobId, command) => guardRunStep(job, command, 'if: false'),
      (jobId, command) => `${jobId} must include run: ${command} as a whole step`,
    ],
    [
      'a scope step that answers false without a diff base',
      (job) =>
        job.replace(
          'echo "applies=true" >> "$GITHUB_OUTPUT"\n            exit 0',
          'echo "applies=false" >> "$GITHUB_OUTPUT"\n            exit 0',
        ),
      (jobId) => `${jobId} scope step must answer applies=true for every event without a diff base`,
    ],
    [
      // #514 review: grep -q exits at the first match, git dies of SIGPIPE on a long diff, and
      // pipefail turns that into "no match", so a large pull request skipped the job green.
      'a scope step that pipes git diff into grep -q',
      (job) =>
        job.replace(
          'changed="$(git diff --name-only "$DIFF_BASE...HEAD")"\n          if grep -Eq "$pattern" <<<"$changed"; then',
          'if git diff --name-only "$DIFF_BASE...HEAD" | grep -Eq "$pattern"; then',
        ),
      (jobId) => `${jobId} scope step must not pipe into grep -q`,
    ],
  ];

  it.each(
    scopedJobs.flatMap(([jobId, command]) =>
      neutralisations.map(
        ([label, mutate, message]) => [jobId, label, command, mutate, message] as const,
      ),
    ),
  )('rejects a %s job neutralised by %s', async (jobId, _label, command, mutate, message) => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    if (ci === undefined) throw new Error('.github/workflows/ci.yml is missing');
    workflows.set(
      '.github/workflows/ci.yml',
      mutateJob(ci, jobId, (job) => mutate(job, jobId, command)),
    );
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining(message(jobId, command)),
    );
  });

  it('accepts the repository ci.yml with LF and with CRLF line endings', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    if (ci === undefined) throw new Error('.github/workflows/ci.yml is missing');
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toEqual([]);
    workflows.set('.github/workflows/ci.yml', ci.replaceAll('\n', '\r\n'));
    expect(validateWorkflowDocuments(workflows, template)).toEqual([]);
  });
});
