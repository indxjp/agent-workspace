import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validatePackageExports } from '../../scripts/check-package-exports.mjs';
import { validateWorkflowDocuments } from '../../scripts/check-workflows.mjs';
import { citationFailures } from '../../scripts/formal/generate.mjs';

const temporaryRoots: string[] = [];

async function packageFixture(importSpecifier = '@agent-workspace/library'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-workspace-package-gate-'));
  temporaryRoots.push(root);
  await Promise.all(
    ['apps/consumer/src', 'packages/library/src', 'scripts', 'tests'].map((directory) =>
      mkdir(path.join(root, directory), { recursive: true }),
    ),
  );
  await writeFile(
    path.join(root, 'packages/library/package.json'),
    JSON.stringify({
      name: '@agent-workspace/library',
      type: 'module',
      main: './dist/index.js',
      types: './src/index.ts',
      exports: { '.': { types: './src/index.ts', default: './dist/index.js' } },
    }),
  );
  await writeFile(
    path.join(root, 'apps/consumer/package.json'),
    JSON.stringify({
      name: '@agent-workspace/consumer',
      type: 'module',
      exports: { '.': './src/index.ts' },
    }),
  );
  await writeFile(path.join(root, 'packages/library/src/index.ts'), 'export const value = 1;\n');
  await writeFile(
    path.join(root, 'apps/consumer/src/index.ts'),
    `import { value } from '${importSpecifier}';\nexport { value };\n`,
  );
  await writeFile(
    path.join(root, 'tsconfig.architecture.json'),
    JSON.stringify({
      compilerOptions: {
        paths: {
          '@agent-workspace/consumer': ['./apps/consumer/src/index.ts'],
          '@agent-workspace/library': ['./packages/library/src/index.ts'],
        },
      },
    }),
  );
  return root;
}

async function repositoryWorkflowDocuments(): Promise<Map<string, string>> {
  const directory = path.join(process.cwd(), '.github/workflows');
  const documents = new Map<string, string>();
  for (const filename of await readdir(directory)) {
    if (!filename.endsWith('.yml') && !filename.endsWith('.yaml')) continue;
    // Export-excluded: its private reusable-workflow pin lives in .github/indx-dev.actions.json, which
    // these fixtures do not load; scripts/check-workflows.mjs validates it with that file.
    if (filename === 'indx-dev.yml') continue;
    documents.set(
      `.github/workflows/${filename}`,
      await readFile(path.join(directory, filename), 'utf8'),
    );
  }
  return documents;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('package export validator', () => {
  it('rejects imports through undeclared internal package subpaths', async () => {
    const root = await packageFixture('@agent-workspace/library/internal');
    const result = await validatePackageExports({ repositoryRoot: root, mode: 'source' });

    expect(result.errors).toContainEqual(
      expect.stringContaining('imports undeclared subpath @agent-workspace/library/internal'),
    );
  });

  it('allows source-backed declarations in fast mode but requires their built files in artifact mode', async () => {
    const root = await packageFixture();

    await expect(validatePackageExports({ repositoryRoot: root, mode: 'source' })).resolves.toEqual(
      { errors: [], workspaceCount: 2 },
    );
    const artifacts = await validatePackageExports({ repositoryRoot: root, mode: 'artifacts' });
    expect(artifacts.errors).toContainEqual(
      expect.stringContaining('is missing built artifact ./dist/index.js'),
    );
  });

  it('resolves a built CSS export to its source file before any build', async () => {
    const root = await packageFixture();
    const manifestPath = path.join(root, 'packages/library/package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      exports: Record<string, unknown>;
    };
    manifest.exports['./styles.css'] = { default: './dist/styles.css' };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const aliasPath = path.join(root, 'tsconfig.architecture.json');
    const aliases = JSON.parse(await readFile(aliasPath, 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    aliases.compilerOptions.paths['@agent-workspace/library/styles.css'] = [];
    await writeFile(aliasPath, JSON.stringify(aliases));

    const missing = await validatePackageExports({ repositoryRoot: root, mode: 'source' });
    expect(missing.errors).toContainEqual(
      expect.stringContaining('does not resolve to source: ./dist/styles.css'),
    );

    await writeFile(path.join(root, 'packages/library/src/styles.css'), 'a {}');
    const present = await validatePackageExports({ repositoryRoot: root, mode: 'source' });
    expect(present.errors).toEqual([]);
  });

  it('imports present JavaScript entrypoints and rejects a broken module graph', async () => {
    const root = await packageFixture();
    await mkdir(path.join(root, 'packages/library/dist'), { recursive: true });
    await writeFile(
      path.join(root, 'packages/library/dist/index.js'),
      "export { missing } from './missing.js';\n",
    );

    const result = await validatePackageExports({ repositoryRoot: root, mode: 'artifacts' });
    expect(result.errors).toContainEqual(expect.stringContaining('could not be imported'));
  });
});

describe('workflow validator', () => {
  it('rejects a mutable action reference', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    expect(ci).toBeDefined();
    workflows.set(
      '.github/workflows/ci.yml',
      ci!.replace(
        'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7',
        'actions/checkout@v7',
      ),
    );
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining('must use an immutable 40-character commit SHA'),
    );
  });

  it('accepts an action pinned only in the export-excluded extra-actions file', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const sha = '0123456789abcdef0123456789abcdef01234567';
    workflows.set(
      '.github/workflows/private.yml',
      `name: private\npermissions:\n  contents: read\njobs:\n  call:\n    uses: private-org/shared/.github/workflows/dev.yml@${sha} # main\n`,
    );
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );
    const extra = new Map([
      ['private-org/shared/.github/workflows/dev.yml', [sha, 'main'] as const],
    ]);

    const own = (failures: string[]) => failures.filter((f) => f.includes('private.yml'));

    expect(own(validateWorkflowDocuments(workflows, template, false, extra))).toEqual([]);
    expect(own(validateWorkflowDocuments(workflows, template))).toEqual([
      expect.stringContaining('is not in the reviewed action allowlist'),
    ]);
  });

  it('rejects a push workflow whose concurrency cancels main runs', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    if (ci === undefined) throw new Error('.github/workflows/ci.yml is missing');
    const cancel = "cancel-in-progress: ${{ github.event_name == 'pull_request' }}";
    expect(ci).toContain(cancel);
    workflows.set('.github/workflows/ci.yml', ci.replace(cancel, 'cancel-in-progress: true'));
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining(
        'cancel-in-progress must not be true on a workflow that runs on push',
      ),
    );
  });

  // A PR body edit re-runs only the fast checks; sharing a cancel-in-progress group with the code
  // run let that edit cancel the real tests while CI success still reported green.
  it('rejects a workflow whose edited runs share a cancel-in-progress group with code runs', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    if (ci === undefined) throw new Error('.github/workflows/ci.yml is missing');
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );
    const edited = (failures: string[]) =>
      failures.filter((failure) => failure.includes('an `edited` run'));
    expect(edited(validateWorkflowDocuments(workflows, template))).toEqual([]);

    const sharedGroup = ci.replace(/^( {2}group: .*?)-\$\{\{ github\.event\.action[^\n]*$/mu, '$1');
    expect(sharedGroup).not.toBe(ci);
    workflows.set('.github/workflows/ci.yml', sharedGroup);

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining('.github/workflows/ci.yml: an `edited` run'),
    );

    // `types:` below another key, or as a block list, is still read rather than taken as empty.
    const typesBelowBranches = sharedGroup.replace(
      /^( {2}pull_request:\r?\n)/mu,
      '$1    branches: [main]\n',
    );
    expect(typesBelowBranches).not.toBe(sharedGroup);
    workflows.set('.github/workflows/ci.yml', typesBelowBranches);
    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining('.github/workflows/ci.yml: an `edited` run'),
    );
    const blockList = sharedGroup.replace(
      /^ {4}types: \[opened, synchronize, reopened, edited\]$/mu,
      '    types:\n      - synchronize\n      - edited',
    );
    expect(blockList).not.toBe(sharedGroup);
    workflows.set('.github/workflows/ci.yml', blockList);
    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining('.github/workflows/ci.yml: an `edited` run'),
    );

    // A `types` value the check cannot read fails closed instead of passing as an empty set.
    workflows.set(
      '.github/workflows/ci.yml',
      ci.replace(/^( {4}types:) \[[^\]]*\]$/mu, '$1 ${{ fromJSON(vars.TYPES) }}'),
    );
    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining('.github/workflows/ci.yml: on.pull_request.types must be'),
    );
  });

  it.each(['Secret scan (gitleaks)', 'Dependency vulnerability scan (osv-scanner)'])(
    'rejects fast-checks without the %s step',
    async (step) => {
      const workflows = await repositoryWorkflowDocuments();
      const ci = workflows.get('.github/workflows/ci.yml');
      if (ci === undefined) throw new Error('.github/workflows/ci.yml is missing');
      expect(ci).toContain(step);
      workflows.set('.github/workflows/ci.yml', ci.replaceAll(step, 'renamed'));
      const template = await readFile(
        path.join(process.cwd(), '.github/pull_request_template.md'),
        'utf8',
      );

      expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
        expect.stringContaining(`fast-checks must include ${step}`),
      );
    },
  );

  // Owner decision D6 (docs/adr/0149, Amendment 2026-10-19): main merges through a merge queue,
  // and a required check whose workflow does not run on merge_group never reports there, so every
  // queued pull request would wait forever.
  it('rejects ci.yml when CI success does not run on merge_group', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    if (ci === undefined) throw new Error('.github/workflows/ci.yml is missing');
    const trigger = '  merge_group:\n    types: [checks_requested]\n';
    expect(ci).toContain(trigger);
    workflows.set('.github/workflows/ci.yml', ci.replace(trigger, ''));
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining(
        'ci.yml: produces the required check "CI success" and must run on merge_group',
      ),
    );
  });

  it('rejects any workflow producing a required check without merge_group', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const job = `jobs:\n  dry-run:\n    name: OSS export · dry run\n    runs-on: ubuntu-latest\n`;
    const head = 'name: required\non:\n  pull_request:\n';
    workflows.set(
      '.github/workflows/required.yml',
      `${head}permissions:\n  contents: read\n${job}`,
    );
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );
    const own = (failures: string[]) => failures.filter((f) => f.includes('required.yml'));

    expect(own(validateWorkflowDocuments(workflows, template))).toEqual([
      expect.stringContaining(
        'required.yml: produces the required check "OSS export · dry run" and must run on merge_group',
      ),
    ]);
    workflows.set(
      '.github/workflows/required.yml',
      `${head}  merge_group:\n    types: [checks_requested]\npermissions:\n  contents: read\n${job}`,
    );
    expect(own(validateWorkflowDocuments(workflows, template))).toEqual([]);
  });

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

  // The first MS-A2 runs-on is fast-checks'. Each job names its INDXDev runner and the
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
        'need fast-checks, build, build-embedded, typecheck-lint, heavy-checks, release-checks, release-images, formal, image-scan, generated-project-e2e, journey-e2e, docs-claims, tool-sandbox-e2e, coverage and browser',
      ),
    );
  });

  it('rejects a formal job that is skipped at job level or drops its checksum check', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    expect(ci).toBeDefined();
    workflows.set(
      '.github/workflows/ci.yml',
      ci!
        .replace(
          '  formal:\n    name: formal · Lean specification\n',
          "  formal:\n    if: contains(github.head_ref, 'formal')\n    name: formal · Lean specification\n",
        )
        .replace(' | sha256sum -c -', ''),
    );
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    const failures = validateWorkflowDocuments(workflows, template);
    expect(failures).toContainEqual(
      expect.stringContaining('formal must not be skipped at job level'),
    );
    expect(failures).toContainEqual(expect.stringContaining('formal must include sha256sum -c'));
  });

  // ADR-0053, Amendment 2026-10-24: the heavy tier runs nightly and as the release gate, not in the
  // merge queue; only `formal` keeps the queue in its gate.
  it('rejects an end-to-end job gated back into the merge queue', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    expect(ci).toBeDefined();
    const journey = ci!.indexOf('  journey-e2e:\n');
    const gate = "      github.event_name == 'schedule'";
    const at = ci!.indexOf(gate, journey);
    expect(at).toBeGreaterThan(journey);
    workflows.set(
      '.github/workflows/ci.yml',
      `${ci!.slice(0, at)}      github.event_name == 'merge_group' || ${ci!.slice(at + 6)}`,
    );
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining('journey-e2e must not be skipped at job level'),
    );
  });

  it('rejects a generated-project E2E that is skipped at job level or runs nothing', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    expect(ci).toBeDefined();
    const header =
      '  generated-project-e2e:\n    name: generated project · create, start, chat (API, CLI, browser), teardown\n';
    expect(ci).toContain(header);
    workflows.set(
      '.github/workflows/ci.yml',
      ci!
        .replace(header, `${header}    if: github.event_name == 'push'\n`)
        .replace('run: node tests/generated-project/run.mjs', 'run: echo skipped'),
    );
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    const failures = validateWorkflowDocuments(workflows, template);
    expect(failures).toContainEqual(
      expect.stringContaining('generated-project-e2e must not be skipped at job level'),
    );
    expect(failures).toContainEqual(
      expect.stringContaining(
        'generated-project-e2e must include run: node tests/generated-project/run.mjs',
      ),
    );
  });

  it('rejects a developer-journey job that is skipped at job level or runs nothing', async () => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    if (ci === undefined) {
      throw new Error('.github/workflows/ci.yml is missing');
    }
    const header = '  journey-e2e:\n    name: developer journey · ${{ matrix.part }}\n';
    const runLine = 'run: node tests/journey/run.mjs';
    expect(ci).toContain(header);
    expect(ci).toContain(runLine);
    workflows.set(
      '.github/workflows/ci.yml',
      ci
        .replace(header, `${header}    if: github.event_name == 'push'\n`)
        .replaceAll(runLine, 'run: echo skipped'),
    );
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    const failures = validateWorkflowDocuments(workflows, template);
    expect(failures).toContainEqual(
      expect.stringContaining(
        'journey-e2e must not be skipped at job level; filter paths in a step',
      ),
    );
    expect(failures).toContainEqual(
      expect.stringContaining('journey-e2e must include run: node tests/journey/run.mjs'),
    );
  });

  /** Apply `mutate` to one top-level job of ci.yml and leave the rest of the file as it is. */
  function mutateJob(ci: string, jobId: string, mutate: (job: string) => string): string {
    const start = ci.indexOf(`\n  ${jobId}:\n`);
    if (start < 0) throw new Error(`ci.yml has no ${jobId} job`);
    const next = /\n {2}[a-zA-Z0-9_-]+:\n/gu;
    next.lastIndex = start + 1;
    const end = next.exec(ci)?.index ?? ci.length;
    const job = ci.slice(start, end);
    const mutated = mutate(job);
    if (mutated === job) throw new Error(`the mutation did not change the ${jobId} job`);
    return ci.slice(0, start) + mutated + ci.slice(end);
  }

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

describe('formal citation check', () => {
  const entry = (...ts: string[]) => [
    {
      name: 'Spec.thing',
      module: 'Spec',
      kind: 'theorem',
      tier: null,
      doc: [],
      ts,
      docstring: '',
      statement: '',
    },
  ];
  const failuresFor = (fragment: string, source: string, file = 'planted.ts') =>
    citationFailures(entry(`${file}#${fragment}`), () => source);

  it('rejects a symbol that only a comment, an import or a plain use mentions', () => {
    const message = 'symbol not declared in the file';
    expect(failuresFor('Thing', '// Thing\n/** Thing */\nexport const other = 1;\n')).toEqual([
      expect.stringContaining(message),
    ]);
    expect(failuresFor('Thing', "import { Thing } from './elsewhere';\n")).toEqual([
      expect.stringContaining(message),
    ]);
    expect(failuresFor('Thing', "import { Thing } from './elsewhere';\nuse(Thing);\n")).toEqual([
      expect.stringContaining(message),
    ]);
    expect(failuresFor('Thing', "export { Thing } from './elsewhere';\n")).toEqual([]);
  });

  it.each([
    ['an exported const', 'export const Thing = 1;'],
    ['a destructured const', 'const { a: [Thing] } = source;'],
    ['a function', 'function Thing() {}'],
    ['a class', 'class Thing {}'],
    ['a class member', 'class Box { Thing = 1; }'],
    ['an interface', 'interface Thing {}'],
    ['an interface member', 'interface Box { readonly Thing: string }'],
    ['a type alias', 'type Thing = string;'],
    ['a type literal member', 'type Box = { Thing(): void };'],
    ['an enum', 'enum Thing { A }'],
    ['an enum member', 'enum Box { Thing }'],
    ['a renamed export', 'const a = 1; export { a as Thing };'],
    ['an object literal property', 'export const wiring = { Thing: async () => 1 };'],
    [
      'a named database object',
      "const t = table(check('Thing', sql`1`));".replace('table(check', 'pgTable(check'),
    ],
  ])('accepts %s', (_label, source) => {
    expect(failuresFor('Thing', source)).toEqual([]);
  });

  it('resolves a non-identifier citation against a string literal and not a comment', () => {
    expect(failuresFor('runs wait', "program.command('runs wait');")).toEqual([]);
    expect(failuresFor('runs wait', '// runs wait\n')).toEqual([
      expect.stringContaining('symbol not declared in the file'),
    ]);
  });

  it('reads a data file as text', () => {
    expect(failuresFor('agents', 'ALTER TABLE agents ADD COLUMN x int;', 'planted.sql')).toEqual(
      [],
    );
  });

  it('resolves every citation of the committed catalogue', async () => {
    const catalogue = JSON.parse(
      await readFile(path.join(process.cwd(), 'formal/generated/catalogue.json'), 'utf8'),
    ) as { entries: Parameters<typeof citationFailures>[0] };

    expect(citationFailures(catalogue.entries)).toEqual([]);
  });
});
