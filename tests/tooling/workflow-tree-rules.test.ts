// The unit tests of the workflow rules that replaced the Vitest files asserting the real tree
// (ADR-0053, Amendment 2026-11-19e): `pnpm workflows:check` now holds the tree to them, and these
// tests hold each rule to a fixture it must accept and one it must refuse.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateWorkflowDocuments } from '../../scripts/check-workflows.mjs';
import {
  pullRequestPaths,
  scopePrefixes,
  validatePeripheralWorkflows,
} from '../../scripts/check-workflows/peripheral.mjs';
import {
  checkActionlintLabels,
  configuredRunnerLabels,
  customRunnerLabels,
  validateWorkflowTree,
} from '../../scripts/check-workflows/tree-rules.mjs';
import { validateWorkflowFile } from '../../scripts/check-workflows/workflow-rules.mjs';
import { repositoryWorkflowDocuments } from './workflow-documents.test-support.js';

const ROOT = process.cwd();
const template = () => readFile(path.join(ROOT, '.github/pull_request_template.md'), 'utf8');
const actionlint = () => readFile(path.join(ROOT, '.github/actionlint.yaml'), 'utf8');
// Read once: every test below mutates a copy.
const REPOSITORY = await repositoryWorkflowDocuments();

/** The failures of the peripheral rules alone. */
function peripheral(workflows: ReadonlyMap<string, string>): string[] {
  const failures: string[] = [];
  validatePeripheralWorkflows(failures, workflows);
  return failures;
}

/** The failures of the tree rules alone, without the actionlint config. */
function tree(workflows: ReadonlyMap<string, string>): string[] {
  const failures: string[] = [];
  validateWorkflowTree(failures, workflows, undefined);
  return failures;
}

/** The failures of the per-file rules for one workflow. */
function perFile(relativePath: string, source: string): string[] {
  const failures: string[] = [];
  validateWorkflowFile(failures, relativePath, source, new Map());
  return failures;
}

/** The failures the tree rules alone give for one synthetic workflow. */
function treeFailures(source: string, config?: string): string[] {
  const failures: string[] = [];
  validateWorkflowTree(failures, new Map([['.github/workflows/w.yml', source]]), config);
  return failures;
}

/** `workflows` with `file` changed by `replace`, which must change it. */
function mutated(
  workflows: Map<string, string>,
  file: string,
  from: string | RegExp,
  to: string,
): Map<string, string> {
  const source = workflows.get(file);
  if (source === undefined) throw new Error(`${file} is missing`);
  const next = source.replace(from, to);
  if (next === source) throw new Error(`the mutation did not change ${file}`);
  return new Map(workflows).set(file, next);
}

describe('the actionlint runner-label rule', () => {
  it('reads labels from every runs-on form', () => {
    expect(
      customRunnerLabels(
        [
          'runs-on: [self-hosted, ms-a2]',
          `runs-on: \${{ github.repository_owner == 'INDXDev' && fromJSON('["self-hosted","pool-b"]') || 'ubuntu-latest' }}`,
          `runs-on: \${{ github.repository_owner == 'INDXDev' && 'vendor-4vcpu' || 'windows-latest' }}`,
          `runs-on: \${{ github.repository_owner == 'INDXDev' && fromJSON('{"group":"heavy-ci","labels":["self-hosted","docker"]}') || 'ubuntu-latest' }}`,
          'runs-on: ${{ matrix.os }}',
          'runs-on: ubuntu-24.04',
          '    runs-on:',
          '      - self-hosted',
          "      - 'pool-c'",
          '    steps:',
          '      - run: echo',
        ].join('\n'),
      ),
    ).toEqual(['docker', 'ms-a2', 'pool-b', 'pool-c', 'vendor-4vcpu']);
    expect(
      customRunnerLabels(
        [
          'jobs:',
          '  claims:',
          '    runs-on: ${{ matrix.os }}',
          '    strategy:',
          '      matrix:',
          '        include:',
          '          - lane: ubuntu',
          '            os: [self-hosted, ms-a2]',
          "          - os: 'vendor-6vcpu-macos'",
          '            machine: host',
          '          - os: ubuntu-24.04',
          '        arch:',
          '          - pool-x',
          '  other:',
          '    runs-on: ubuntu-latest',
          '    strategy:',
          '      matrix:',
          '        os: [pool-not-this-job]',
        ].join('\n'),
      ),
    ).toEqual(['ms-a2', 'vendor-6vcpu-macos']);
  });

  it('refuses a label .github/actionlint.yaml does not list, and accepts one it does', () => {
    const config = 'self-hosted-runner:\n  labels:\n    - ms-a2\n    - vendor-4vcpu\n';
    expect(configuredRunnerLabels(config)).toEqual(['ms-a2', 'vendor-4vcpu']);
    const workflow =
      'jobs:\n  a:\n    runs-on: [self-hosted, ms-a2]\n  b:\n    runs-on: pool-new\n';
    const failures: string[] = [];
    checkActionlintLabels(failures, new Map([['.github/workflows/w.yml', workflow]]), config);
    expect(failures).toEqual([
      '.github/workflows/w.yml: runner label "pool-new" is missing from .github/actionlint.yaml (self-hosted-runner.labels), so actionlint reports it as unknown',
    ]);
    expect(treeFailures(workflow, `${config}    - pool-new\n`)).toEqual([]);
  });

  it('checks the labels only when the caller loaded the config', async () => {
    const workflows = REPOSITORY;
    const unknown = mutated(
      workflows,
      '.github/workflows/isolation.yml',
      "'blacksmith-4vcpu-ubuntu-2404'",
      "'blacksmith-unknown-ubuntu-2404'",
    );
    const label: unknown = expect.stringContaining('"blacksmith-unknown-ubuntu-2404" is missing');
    expect(validateWorkflowDocuments(unknown, await template())).not.toContainEqual(label);
    expect(
      validateWorkflowDocuments(unknown, await template(), false, new Map(), await actionlint()),
    ).toContainEqual(label);
  });
});

describe('the aw build rule', () => {
  it('refuses a build of aw without platforms, and accepts platforms or the closure', () => {
    expect(
      treeFailures(
        '      - run: scripts/ci/nx.sh run-many -t build --projects=@indx-workspace/aw\n',
      ),
    ).toEqual([
      '.github/workflows/w.yml:1: builds @indx-workspace/aw without @indx-workspace/platforms, which aw imports from dist (add it, or build @indx-workspace/aw...)',
    ]);
    for (const line of [
      'run: nx run-many -t build --projects=@indx-workspace/platforms,@indx-workspace/aw',
      'run: pnpm --filter @indx-workspace/aw... build',
      'run: pnpm --filter @indx-workspace/aw-legacy build',
      'run: pnpm --filter @indx-workspace/aw test',
    ]) {
      expect(treeFailures(`      - ${line}\n`), line).toEqual([]);
    }
  });
});

describe('the Cloud Run environment rule', () => {
  it('refuses a --set-env-vars list outside a comment', () => {
    expect(treeFailures('  gcloud run deploy x --set-env-vars A=1,B=2\n')).toEqual([
      '.github/workflows/w.yml:1: never pass a --set-env-vars list; use --env-vars-file',
    ]);
    expect(treeFailures('  # never --set-env-vars A=1\n')).toEqual([]);
  });

  it('keeps --update-env-vars to one NAME=value pair without a delimiter', () => {
    expect(treeFailures('  gcloud run services update x --update-env-vars A_B=plain\n')).toEqual(
      [],
    );
    expect(treeFailures('  gcloud run services update x --update-env-vars "A=1"\n')).toEqual([]);
    for (const value of ['A=1,B=2', '"^@^A=x@y"', 'lower=1']) {
      expect(treeFailures(`  gcloud run x --update-env-vars ${value}\n`), value).toHaveLength(1);
    }
  });

  it("refuses the preview's IAM probe once it leaves the env-vars file or claims a denial unread", () => {
    const workflows = REPOSITORY;
    const preview = '.github/workflows/gcp-cloudrun-preview.yml';
    const own = (map: Map<string, string>) =>
      tree(map).filter((failure) => failure.includes("Probe the runner manager's IAM condition"));
    expect(own(workflows)).toEqual([]);
    expect(
      own(mutated(workflows, preview, '--env-vars-file "$RUNNER_TEMP/iam-probe.env.yaml"', '')),
    ).toHaveLength(1);
    expect(
      own(
        mutated(
          workflows,
          preview,
          'if grep -q \'PERMISSION_DENIED\' "$deploy_log"; then',
          'if true; then',
        ),
      ),
    ).toHaveLength(1);
    expect(
      own(
        mutated(
          workflows,
          preview,
          "      - name: Probe the runner manager's IAM condition\n",
          '      - name: renamed\n',
        ),
      ),
    ).toEqual([
      '.github/workflows/gcp-cloudrun-preview.yml: the step "Probe the runner manager\'s IAM condition" is missing',
    ]);
  });
});

describe('the peripheral workflow rules', () => {
  it('keeps both isolation kind lanes off the pull request', () => {
    const workflows = REPOSITORY;
    const own = (map: Map<string, string>) =>
      peripheral(map).filter((failure) => failure.includes('the kind lane'));
    expect(own(workflows)).toEqual([]);
    const isolation = '.github/workflows/isolation.yml';
    expect(
      own(
        mutated(
          workflows,
          isolation,
          "    if: github.event_name != 'pull_request'",
          "    if: github.event_name != 'push'",
        ),
      ),
    ).toEqual([
      ".github/workflows/isolation.yml#kind: the kind lane must run only if: github.event_name != 'pull_request'",
    ]);
    expect(
      own(
        mutated(
          workflows,
          isolation,
          /\n {4}if: github\.event_name != 'pull_request'\n(?![\s\S]*\n {4}if: github\.event_name != 'pull_request'\n)/u,
          '\n',
        ),
      ),
    ).toEqual([
      ".github/workflows/isolation.yml#kind-deploy: the kind lane must run only if: github.event_name != 'pull_request'",
    ]);
  });

  it("filters journey-live's pull requests by every path its scope steps read", () => {
    const workflows = REPOSITORY;
    const journey = '.github/workflows/journey-live.yml';
    const source = workflows.get(journey) ?? '';
    expect(scopePrefixes(source)).toContain('.github/workflows/journey-live.yml');
    expect(pullRequestPaths(source)).toContain('packages/cli/src/create**');
    const own = (map: Map<string, string>) =>
      peripheral(map).filter((failure) => failure.startsWith(journey));
    expect(own(workflows)).toEqual([]);
    expect(own(mutated(workflows, journey, '      - packages/platforms/**\n', ''))).toEqual([
      '.github/workflows/journey-live.yml: on.pull_request.paths must list packages/platforms/**, which a scope step reads',
    ]);
    expect(own(mutated(workflows, journey, /\n {4}paths:\n(?: {6}- .*\n)+/u, '\n'))).toEqual([
      '.github/workflows/journey-live.yml: on.pull_request must carry the paths its scope steps read, so an unrelated pull request starts no MS-A2 job',
    ]);
  });

  it('reads the paths of a pull_request trigger and nothing after it', () => {
    expect(
      pullRequestPaths('on:\n  pull_request:\n  push:\n    paths:\n      - a/**\n'),
    ).toBeNull();
    expect(
      pullRequestPaths(
        "on:\n  pull_request:\n    branches: [main]\n    paths:\n      - 'a/**'\n      - b.yml\n    types: [opened]\n  push:\n",
      ),
    ).toEqual(['a/**', 'b.yml']);
  });

  it('makes the alarm watch Isolation on main', () => {
    const workflows = REPOSITORY;
    const alarm = '.github/workflows/nightly-alarm.yml';
    const own = (map: Map<string, string>) =>
      peripheral(map).filter((failure) => failure.startsWith(alarm));
    expect(own(workflows)).toEqual([]);
    expect(own(mutated(workflows, alarm, ', Isolation]', ']'))).toHaveLength(1);
    expect(
      own(
        mutated(
          workflows,
          alarm,
          "github.event.workflow_run.event == 'push'",
          "github.event.workflow_run.event == 'pull_request'",
        ),
      ),
    ).toHaveLength(1);
  });

  it('refuses a path or branch filter on a workflow producing a required check', () => {
    const workflows = REPOSITORY;
    const ci = '.github/workflows/ci.yml';
    const own = (map: Map<string, string>) =>
      [...map]
        .filter(([file]) => file === ci || file.endsWith('/required.yml'))
        .flatMap(([file, source]) => perFile(file, source))
        .filter((failure) => failure.includes('must not filter its triggers'));
    expect(own(workflows)).toEqual([]);
    expect(
      own(
        mutated(
          workflows,
          ci,
          '  push:\n    branches: [main]\n',
          '  push:\n    branches: [main]\n    paths-ignore:\n      - docs/**\n',
        ),
      ),
    ).toEqual([
      '.github/workflows/ci.yml: produces the required check "CI success" and must not filter its triggers by paths or branches-ignore',
    ]);
    const required = [
      'name: required',
      'on:',
      '  pull_request:',
      '    paths:',
      '      - src/**',
      '  merge_group:',
      '    types: [checks_requested]',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  dry-run:',
      '    name: OSS export · dry run',
      '',
    ].join('\n');
    expect(own(new Map(workflows).set('.github/workflows/required.yml', required))).toEqual([
      '.github/workflows/required.yml: produces the required check "OSS export · dry run" and must not filter its triggers by paths or branches-ignore',
    ]);
  });
});
