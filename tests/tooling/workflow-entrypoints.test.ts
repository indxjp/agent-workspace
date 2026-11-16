import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateWorkflowDocuments } from '../../scripts/check-workflows.mjs';
import { repositoryWorkflowDocuments } from './workflow-documents.test-support.js';

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

  it.each([
    'Secret scan (gitleaks)',
    'Dependency vulnerability scan (osv-scanner)',
    'pnpm stories:check --base',
  ])('rejects fast-checks without the %s step', async (step) => {
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
  });

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
});
