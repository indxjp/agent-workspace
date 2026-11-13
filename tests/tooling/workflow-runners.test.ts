import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateWorkflowDocuments } from '../../scripts/check-workflows.mjs';
import { repositoryWorkflowDocuments, mutateJob } from './workflow-documents.test-support.js';

describe('workflow validator', () => {
  it('rejects a security workflow whose GHAS jobs skip without a warning', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const security = workflows.get('.github/workflows/security.yml');
    if (security === undefined) throw new Error('.github/workflows/security.yml is missing');
    expect(security).toContain('::warning');
    workflows.set('.github/workflows/security.yml', security.replaceAll('::warning', '::notice'));
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining('security.yml: skipped GHAS jobs must emit a ::warning'),
    );
  });

  it('rejects a packing job that does not restore the embedded build', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    if (ci === undefined) throw new Error('.github/workflows/ci.yml is missing');
    const restore =
      "        uses: ./.github/actions/workspace-build\n        with:\n          embedded: 'true'\n";
    workflows.set(
      '.github/workflows/ci.yml',
      mutateJob(ci, 'journey-e2e', (job) => {
        expect(job).toContain(restore);
        return job.replace(restore, '        uses: ./.github/actions/workspace-build\n');
      }),
    );
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining(
        "journey-e2e must need build, have actions: read and restore the workspace build with embedded: 'true'",
      ),
    );
  });

  it('rejects a build-embedded job without the no-skip gate', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    if (ci === undefined) throw new Error('.github/workflows/ci.yml is missing');
    const gate =
      '\n      - name: No test in the run was skipped\n        run: node scripts/ci/vitest-no-skip.mjs\n';
    expect(ci).toContain(gate);
    workflows.set('.github/workflows/ci.yml', ci.replace(gate, '\n'));
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining(
        'build-embedded must include run: node scripts/ci/vitest-no-skip.mjs',
      ),
    );
  });

  // The first MS-A2 runs-on is release-checks' (fast-checks left the pool, Amendment 2026-11-05). Each job names its INDXDev runner and the
  // GitHub-hosted fallback the public export and forks run on (ADR-0053, Amendment 2026-10-26).
  const msA2 = `\${{ github.repository_owner == 'INDXDev' && fromJSON('["self-hosted","ms-a2"]') || 'ubuntu-latest' }}`;

  const offloaded = `\${{ github.repository_owner == 'INDXDev' && 'blacksmith-8vcpu-ubuntu-2404' || 'ubuntu-latest' }}`;

  const refusal = 'every Linux CI job runs on the MS-A2 pool here and GitHub-hosted elsewhere';

  it.each([
    ['[self-hosted, ms-a2]'],
    ['[self-hosted, dgx]'],
    ['ubuntu-latest'],
    ['blacksmith-8vcpu-ubuntu-2404'],
    ["${{ vars.CI_BOTTLENECK_RUNNER || 'ubuntu-latest' }}"],
    [
      `\${{ github.repository_owner == 'INDXDev' && fromJSON('["self-hosted","ms-a2"]') || 'blacksmith-4vcpu-ubuntu-2404' }}`,
    ],
    [
      `\${{ github.repository_owner != 'INDXDev' && fromJSON('["self-hosted","ms-a2"]') || 'ubuntu-latest' }}`,
    ],
  ])('refuses the MS-A2 runs-on replaced by %s', async (label) => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    expect(ci).toBeDefined();
    expect(ci).toContain(`runs-on: ${msA2}`);
    workflows.set('.github/workflows/ci.yml', ci!.replace(`runs-on: ${msA2}`, `runs-on: ${label}`));
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining(refusal),
    );
  });

  it('allows the Blacksmith label on the offloaded jobs only, and only that size', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );
    expect(ci).toContain(`runs-on: ${offloaded}`);
    expect(validateWorkflowDocuments(workflows, template)).not.toContainEqual(
      expect.stringContaining(refusal),
    );

    workflows.set(
      '.github/workflows/ci.yml',
      ci!.replace(`runs-on: ${offloaded}`, `runs-on: ${offloaded.replace('8vcpu', '16vcpu')}`),
    );
    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining(refusal),
    );
  });

  it('runs the light jobs on plain ubuntu-latest, and no other job', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );
    const ci = workflows.get('.github/workflows/ci.yml');
    const fastChecks = /(\n {2}fast-checks:\n(?:.*\n)*? {4}runs-on: )ubuntu-latest\n/u;
    expect(ci).toMatch(fastChecks);
    expect(validateWorkflowDocuments(workflows, template)).not.toContainEqual(
      expect.stringContaining(refusal),
    );

    // A light job does not move to Blacksmith or back to the pool by accident.
    for (const label of [offloaded, msA2, 'ubuntu-24.04']) {
      const changed = new Map(workflows);
      changed.set('.github/workflows/ci.yml', ci!.replace(fastChecks, `$1${label}\n`));
      expect(validateWorkflowDocuments(changed, template)).toContainEqual(
        expect.stringContaining(refusal),
      );
    }

    // A heavy job is not on the hosted list: `typecheck-lint` on ubuntu-latest is refused.
    const heavy = new Map(workflows);
    heavy.set(
      '.github/workflows/ci.yml',
      ci!.replace(/(\n {2}typecheck-lint:\n(?:.*\n)*? {4}runs-on: ).+\n/u, '$1ubuntu-latest\n'),
    );
    expect(validateWorkflowDocuments(heavy, template)).toContainEqual(
      expect.stringContaining(refusal),
    );
  });

  it.each([
    ["    if: github.repository == 'indxjp/agent-workspace'\n", '', 'a release job must have'],
    [
      '    runs-on: ubuntu-latest\n',
      '    runs-on: [self-hosted, ms-a2]\n',
      'a release job runs on ubuntu-latest',
    ],
  ])(
    'refuses a release job that could run outside the public repository (%#)',
    async (from, to, failure) => {
      const workflows = await repositoryWorkflowDocuments();
      const images = workflows.get('.github/workflows/images.yml');
      const template = await readFile(
        path.join(process.cwd(), '.github/pull_request_template.md'),
        'utf8',
      );
      expect(images).toContain(from);
      workflows.set('.github/workflows/images.yml', images!.replace(from, to));

      expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
        expect.stringContaining(failure),
      );
    },
  );

  it('refuses an internal-only job that a fork or the public repository could start', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const live = workflows.get('.github/workflows/providers-live.yml');
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );
    expect(validateWorkflowDocuments(workflows, template)).not.toContainEqual(
      expect.stringContaining('an internal-only job'),
    );
    const guard = "    if: github.repository_owner == 'INDXDev'\n";
    expect(live).toContain(guard);
    workflows.set('.github/workflows/providers-live.yml', live!.replace(guard, ''));

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining('providers-live.yml#e2b: an internal-only job'),
    );
  });

  it('keeps the wave-plan gate in internal-checks.yml, and requires that file with the internal wave records', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );
    const gate = 'must exist and contain the step "Wave plans declare disjoint ownership"';

    workflows.delete('.github/workflows/internal-checks.yml');
    expect(validateWorkflowDocuments(workflows, template, false)).not.toContainEqual(
      expect.stringContaining(gate),
    );
    expect(validateWorkflowDocuments(workflows, template, true)).toContainEqual(
      expect.stringContaining(gate),
    );
    workflows.set('.github/workflows/internal-checks.yml', 'permissions: {}');
    expect(validateWorkflowDocuments(workflows, template, false)).toContainEqual(
      expect.stringContaining(gate),
    );
  });
});
