import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateWorkflowDocuments } from '../../scripts/check-workflows.mjs';
import { repositoryWorkflowDocuments } from './workflow-documents.test-support.js';

describe('workflow validator', () => {
  it('rejects a test shard list that drifts from the shards', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    expect(ci).toBeDefined();
    const shard = "            projects: '@agent-workspace/web @agent-workspace/core'\n";
    expect(ci).toContain(shard);
    workflows.set(
      '.github/workflows/ci.yml',
      ci!.replace(
        shard,
        "            projects: '@agent-workspace/web @agent-workspace/core @agent-workspace/runner'\n",
      ),
    );
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining('heavy-checks NAMED_PROJECTS must list exactly the projects'),
    );
  });

  it('rejects fast-checks without the lockfile dedupe step', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    expect(ci).toBeDefined();
    const step = '      - name: Lockfile is deduplicated\n        run: pnpm dedupe --check\n\n';
    expect(ci).toContain(step);
    workflows.set('.github/workflows/ci.yml', ci!.replace(step, ''));
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining('fast-checks must include pnpm dedupe --check'),
    );
  });

  it('rejects fast-checks that wait for the build', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    expect(ci).toBeDefined();
    const header = '  fast-checks:\n    name: fast checks · PR contract · workflow policy\n';
    expect(ci).toContain(header);
    workflows.set('.github/workflows/ci.yml', ci!.replace(header, `${header}    needs: build\n`));
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining('fast-checks must not wait for another job'),
    );
  });

  it('rejects heavy-checks queued behind fast-checks', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    expect(ci).toBeDefined();
    workflows.set(
      '.github/workflows/ci.yml',
      ci!.replace(/(\n {2}heavy-checks:\n(?: {4}.*\n)*? {4}needs: )build\n/u, '$1fast-checks\n'),
    );
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining('heavy-checks must run in parallel with fast-checks'),
    );
  });

  const ciSuccessNeeds = [
    'fast-checks',
    'build',
    'build-embedded',
    'typecheck-lint',
    'heavy-checks',
    'release-checks',
    'release-images',
    'formal',
    'image-scan',
    'generated-project-e2e',
    'app-kit-e2e',
    'apps-e2e',
    'journey-e2e',
    'docs-claims',
    'tool-sandbox-e2e',
    'coverage',
    'browser',
  ];

  /** ci.yml with ci-success's needs list replaced by `needs`, on one line. */
  function withCiSuccessNeeds(ci: string, needs: readonly string[]): string {
    const list = /\n {2}ci-success:\n(?:.*\n)*? {4}(needs:\s*\[[^\]]*\])\n/u.exec(ci)?.[1];
    if (list === undefined) throw new Error('ci-success has no needs list');
    return ci.replace(list, `needs: [${needs.join(', ')}]`);
  }

  it('accepts the ci-success needs list on one line as well as wrapped', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    if (ci === undefined) throw new Error('.github/workflows/ci.yml is missing');
    workflows.set('.github/workflows/ci.yml', withCiSuccessNeeds(ci, ciSuccessNeeds));
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).not.toContainEqual(
      expect.stringContaining('ci-success must run with if: always()'),
    );
  });

  it.each(ciSuccessNeeds)('rejects a ci-success that does not require the %s job', async (job) => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    if (ci === undefined) throw new Error('.github/workflows/ci.yml is missing');
    workflows.set(
      '.github/workflows/ci.yml',
      withCiSuccessNeeds(
        ci,
        ciSuccessNeeds.filter((need) => need !== job),
      ),
    );
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining(
        'need fast-checks, build, build-embedded, typecheck-lint, heavy-checks, release-checks, release-images, formal, image-scan, generated-project-e2e, app-kit-e2e, apps-e2e, journey-e2e, docs-claims, tool-sandbox-e2e, coverage and browser',
      ),
    );
  });
});
