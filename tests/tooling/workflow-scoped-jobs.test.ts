import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateWorkflowDocuments } from '../../scripts/check-workflows.mjs';
import { repositoryWorkflowDocuments } from './workflow-documents.test-support.js';

describe('workflow validator', () => {
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
});
