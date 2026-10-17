import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validatePackageExports } from '../../scripts/check-package-exports.mjs';
import { validateWorkflowDocuments } from '../../scripts/check-workflows.mjs';

/** The `runs-on` of ci.yml's bottleneck jobs: CI_BOTTLENECK_RUNNER, `ubuntu-latest` when unset. */
const BOTTLENECK_RUNS_ON = "${{ vars.CI_BOTTLENECK_RUNNER || 'ubuntu-latest' }}";

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

  // The first `runs-on: ubuntu-latest` is fast-checks', the first bottleneck one is formal's.
  it.each([
    ['ubuntu-latest', '[self-hosted, dgx]', 'never schedules CI onto a self-hosted runner'],
    [
      'ubuntu-latest',
      'blacksmith-4vcpu-ubuntu-2404',
      'never schedules CI onto a self-hosted runner',
    ],
    ['ubuntu-latest', BOTTLENECK_RUNS_ON, 'job fast-checks reads CI_BOTTLENECK_RUNNER'],
    [BOTTLENECK_RUNS_ON, 'blacksmith-4vcpu-ubuntu-2404', 'never schedules CI onto a self-hosted'],
  ])('refuses runs-on: %s replaced by %s', async (from, label, failure) => {
    const workflows = await repositoryWorkflowDocuments();
    const ci = workflows.get('.github/workflows/ci.yml');
    expect(ci).toBeDefined();
    expect(ci).toContain(`runs-on: ${from}`);
    workflows.set('.github/workflows/ci.yml', ci!.replace(`runs-on: ${from}`, `runs-on: ${label}`));
    const template = await readFile(
      path.join(process.cwd(), '.github/pull_request_template.md'),
      'utf8',
    );

    expect(validateWorkflowDocuments(workflows, template)).toContainEqual(
      expect.stringContaining(failure),
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
        '  heavy-checks:\n    name: tests · ${{ matrix.shard }}\n    needs: build\n',
        '  heavy-checks:\n    name: tests · ${{ matrix.shard }}\n    needs: fast-checks\n',
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
        'need fast-checks, build, build-embedded, typecheck-lint, heavy-checks, release-checks, release-images, formal, image-scan, generated-project-e2e, journey-e2e, docs-claims and tool-sandbox-e2e',
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
    ['docs-claims', 'node tests/docs-claims/run.mjs --shard ${{ matrix.shard }}/3'],
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
      'a scope step that answers false off pull requests',
      (job) =>
        job.replace(
          'echo "applies=true" >> "$GITHUB_OUTPUT"\n            exit 0',
          'echo "applies=false" >> "$GITHUB_OUTPUT"\n            exit 0',
        ),
      (jobId) => `${jobId} scope step must answer applies=true for every event but pull_request`,
    ],
    [
      // #514 review: grep -q exits at the first match, git dies of SIGPIPE on a long diff, and
      // pipefail turns that into "no match", so a large pull request skipped the job green.
      'a scope step that pipes git diff into grep -q',
      (job) =>
        job.replace(
          'changed="$(git diff --name-only origin/main...HEAD)"\n          if grep -Eq "$pattern" <<<"$changed"; then',
          'if git diff --name-only origin/main...HEAD | grep -Eq "$pattern"; then',
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
