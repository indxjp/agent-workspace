import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateWorkflowDocuments } from '../../scripts/check-workflows.mjs';
import { mutateJob, repositoryWorkflowDocuments } from './workflow-documents.test-support.js';

describe('workflow validator', () => {
  it.each([
    [
      'heavy-checks with its own shard list',
      (ci: string) =>
        ci.replace(
          '        include: ${{ fromJSON(needs.plan.outputs.test-shards) }}\n',
          '        include:\n          - shard: tests\n            projects: agent-workspace\n',
        ),
      'heavy-checks must take its matrix from the plan',
    ],
    [
      'heavy-checks guarding its no-skip gate',
      (ci: string) =>
        mutateJob(ci, 'heavy-checks', (job) =>
          job.replace(
            '      - name: No test in the run was skipped\n',
            "      - name: No test in the run was skipped\n        if: matrix.shard != 'rest'\n",
          ),
        ),
      'heavy-checks must run its no-skip gate on every leg, unguarded',
    ],
    [
      'heavy-checks restoring embedded',
      (ci: string) =>
        mutateJob(ci, 'heavy-checks', (job) =>
          job.replace("          embedded: 'false'\n", "          embedded: 'true'\n"),
        ),
      "heavy-checks must restore the workspace build with embedded: 'false'",
    ],
    [
      'a typecheck-lint that runs whatever the plan says',
      (ci: string) =>
        ci.replace(
          "    if: needs.plan.outputs.typecheck-lint == 'true'\n",
          "    if: github.event.action != 'edited'\n",
        ),
      "typecheck-lint must need plan and run only if: needs.plan.outputs.typecheck-lint == 'true'",
    ],
    [
      'a build that does not need the plan',
      (ci: string) => mutateJob(ci, 'build', (job) => job.replace('    needs: plan\n', '')),
      "build must need plan and run only if: needs.plan.outputs.build == 'true'",
    ],
    [
      'a plan that waits for fast-checks',
      (ci: string) =>
        ci.replace(
          '    name: plan · which Nx jobs this change needs\n',
          '    name: plan · which Nx jobs this change needs\n    needs: fast-checks\n',
        ),
      'plan must not wait for another job',
    ],
    [
      'a ci-success that accepts any skip of a planned job',
      (ci: string) => ci.replace('($edited or $plan[.key] == "false")', '(true)'),
      'ci-success must accept a skipped build, build-embedded, typecheck-lint or heavy-checks only where the plan said "false" for it',
    ],
  ])('rejects %s', async (_case, mutate, message) => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    if (ci === undefined) throw new Error('.github/workflows/ci.yml is missing');
    const mutated = mutate(ci);
    expect(mutated).not.toBe(ci);
    workflows.set('.github/workflows/ci.yml', mutated);
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining(message),
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

  it('rejects fast-checks that start docs:check in the background but never wait for it', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    expect(ci).toBeDefined();
    const wait = '          exit "$(cat "$RUNNER_TEMP/docs-check.status")"\n';
    expect(ci).toContain(wait);
    workflows.set('.github/workflows/ci.yml', ci!.replace(wait, ''));
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining(
        'fast-checks must start pnpm docs:check and later wait for it, exiting with its status',
      ),
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
      ci!.replace(
        /(\n {2}heavy-checks:\n(?: {4}.*\n)*? {4}needs: )\[plan, build\]\n/u,
        '$1[plan, build, fast-checks]\n',
      ),
    );
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining('heavy-checks must run in parallel with fast-checks'),
    );
  });

  it.each([
    ['cancels on every event', '    if: failure()\n'],
    [
      'cancels a push to main',
      "    if: failure() && (github.event_name == 'pull_request' || github.event_name == 'push')\n",
    ],
  ])('rejects a cancel-on-fast-failure that %s', async (_case, condition) => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    if (ci === undefined) throw new Error('.github/workflows/ci.yml is missing');
    const scoped =
      "    needs: fast-checks\n    if: failure() && (github.event_name == 'pull_request' || github.event_name == 'merge_group')\n";
    expect(ci).toContain(scoped);
    workflows.set(
      '.github/workflows/ci.yml',
      ci.replace(scoped, `    needs: fast-checks\n${condition}`),
    );
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining(
        'cancel-on-fast-failure must need fast-checks and run only on a failed pull_request or merge_group run',
      ),
    );
  });

  const ciSuccessNeeds = [
    'fast-checks',
    'plan',
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
        'need fast-checks, plan, build, build-embedded, typecheck-lint, heavy-checks, release-checks, release-images, formal, image-scan, generated-project-e2e, app-kit-e2e, apps-e2e, journey-e2e, docs-claims, tool-sandbox-e2e, coverage and browser',
      ),
    );
  });
});
