/**
 * The llms.txt renderer, on fixture repositories. What it renders from this repository is checked
 * by `pnpm docs:check`: `generate-llms-txt.mjs --check` (byte-identical with the committed file)
 * and tests/docs/llms-txt.docs-check.ts (the navigation, the order, a stable second render).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { compareWithDisk, renderLlmsTxt } from '../../scripts/docs/generate-llms-txt.mjs';

const temporaryRoots: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-workspace-llms-txt-'));
  temporaryRoots.push(root);
  return root;
}

/** A minimal repository: every curated document present, one site page in one group. */
async function writeFixtureRepository(root: string, options: { readonly omit?: string }) {
  const curated = [
    'AGENTS.md',
    'CLAUDE.md',
    'docs/README.md',
    'ENGINEERING_GUIDELINES.md',
    'docs/architecture.md',
    'docs/20-design/architecture/ssot/ARCHITECTURE.md',
    'docs/30-reference/policies/testing-strategy.md',
    'docs/sdk/site/README.md',
    'docs/spec.md',
    'docs/10-product/sdk/README.md',
    'docs/10-product/sdk/02-use-cases-and-documentation.md',
    'docs/10-product/sdk/03-sdk-design.md',
    'docs/10-product/sdk/04-api-specification.md',
    'docs/10-product/sdk/07-structure-map.md',
    'docs/20-design/architecture/refactoring/claude-agent-workspace-refactoring-plan.md',
    'docs/20-design/architecture/refactoring/claude-agent-workspace-refactoring-decisions.md',
    'docs/adr/README.md',
    'docs/adr/0052-the-sdk-is-contracts-first-and-the-application-is-its-first-consumer.md',
    'docs/adr/0054-developer-documentation-is-a-mintlify-site-generated-from-the-contracts.md',
    'docs/30-reference/capabilities/capability-status.md',
    'docs/30-reference/matrices/runtime-driver-matrix.md',
    'docs/40-operate/deploy/single-vm.md',
    'docs/40-operate/deploy/kubernetes.md',
    'docs/40-operate/deploy/azure-container-apps.md',
    'docs/40-operate/operations/runbook.md',
    'docs/30-reference/policies/upgrade-policy.md',
    'docs/30-reference/policies/dependency-policy.md',
  ];
  for (const relativePath of curated) {
    if (relativePath === options.omit) continue;
    const target = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `# Title of ${relativePath}\n\nBody.\n`, 'utf8');
  }
  const site = path.join(root, 'docs', 'sdk', 'site');
  await mkdir(path.join(site, 'concepts'), { recursive: true });
  await writeFile(
    path.join(site, 'docs.json'),
    JSON.stringify({
      navigation: {
        tabs: [
          { tab: 'Documentation', groups: [{ group: 'Concepts', pages: ['concepts/one'] }] },
          { tab: 'Reference', groups: [{ group: 'SDK', pages: ['concepts/one'] }] },
        ],
      },
    }),
    'utf8',
  );
  await writeFile(
    path.join(site, 'concepts', 'one.mdx'),
    '---\ntitle: "One"\ndescription: "A page that says \\"one\\"."\n---\n\nBody.\n',
    'utf8',
  );
}

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('renderLlmsTxt against a fixture repository', () => {
  it('titles a document by its own heading and unescapes a quoted description', async () => {
    const root = await freshRoot();
    await writeFixtureRepository(root, {});

    const text = await renderLlmsTxt(root);

    expect(text).toContain('- [Title of AGENTS.md](AGENTS.md): The operational checklist');
    expect(text).toContain(
      '## Docs site: Concepts\n\n- [One](docs/sdk/site/concepts/one.mdx): A page that says "one".',
    );
    expect(text).toContain(
      '## Optional\n\n- [One](docs/sdk/site/concepts/one.mdx): A page that says "one".\n',
    );
  });

  it('refuses to index a document that does not exist instead of dropping the line', async () => {
    const root = await freshRoot();
    await writeFixtureRepository(root, { omit: 'docs/adr/README.md' });

    await expect(renderLlmsTxt(root)).rejects.toThrow(
      'llms.txt lists docs/adr/README.md, which does not exist',
    );
  });

  it('reports a missing or stale llms.txt as drift', async () => {
    const root = await freshRoot();
    await writeFixtureRepository(root, {});
    const text = await renderLlmsTxt(root);

    expect(await compareWithDisk(text, root)).toEqual({
      ok: false,
      issue: 'missing: llms.txt — run `pnpm docs:generate`',
    });
    await writeFile(path.join(root, 'llms.txt'), `${text}- edited by hand\n`, 'utf8');
    expect(await compareWithDisk(text, root)).toEqual({
      ok: false,
      issue: 'stale: llms.txt — run `pnpm docs:generate`',
    });
    await writeFile(path.join(root, 'llms.txt'), text, 'utf8');
    expect(await compareWithDisk(text, root)).toEqual({ ok: true, issue: null });
  });
});
