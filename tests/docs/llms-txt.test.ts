import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compareWithDisk, renderLlmsTxt } from '../../scripts/docs/generate-llms-txt.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
let rendered: string;
const temporaryRoots: string[] = [];

interface SiteManifest {
  readonly navigation: {
    readonly tabs: readonly {
      readonly groups: readonly { readonly pages?: readonly string[]; readonly openapi?: string }[];
    }[];
  };
}

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
    'ENGINEERING_GUIDELINES.md',
    'docs/architecture.md',
    'docs/sdk/site/README.md',
    'docs/spec.md',
    'docs/sdk/README.md',
    'docs/sdk/02-use-cases-and-documentation.md',
    'docs/sdk/03-sdk-design.md',
    'docs/sdk/04-api-specification.md',
    'docs/sdk/07-structure-map.md',
    'docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md',
    'docs/architecture/refactoring/claude-agent-workspace-refactoring-decisions.md',
    'docs/adr/README.md',
    'docs/adr/0052-the-sdk-is-contracts-first-and-the-application-is-its-first-consumer.md',
    'docs/adr/0054-developer-documentation-is-a-mintlify-site-generated-from-the-contracts.md',
    'docs/capability-status.md',
    'docs/runtime-driver-matrix.md',
    'docs/deploy/single-vm.md',
    'docs/deploy/kubernetes.md',
    'docs/deploy/azure-container-apps.md',
    'docs/operations/runbook.md',
    'docs/upgrade-policy.md',
    'docs/dependency-policy.md',
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

beforeAll(async () => {
  rendered = await renderLlmsTxt(repoRoot);
});

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('renderLlmsTxt against this repository', () => {
  it('lists every page of the docs site navigation exactly once, by its committed path', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, 'docs', 'sdk', 'site', 'docs.json'), 'utf8'),
    ) as SiteManifest;
    const pages = manifest.navigation.tabs.flatMap((tab) =>
      tab.groups.flatMap((group) => group.pages ?? []),
    );
    expect(pages.length).toBeGreaterThan(50);
    for (const page of pages) {
      const occurrences = rendered.split(`](docs/sdk/site/${page}.mdx): `).length - 1;
      expect(occurrences, page).toBe(1);
    }
  });

  it('lists the OpenAPI document a Reference group names under Optional', () => {
    const optional = rendered.slice(rendered.indexOf('## Optional'));
    expect(optional).toContain(
      '- [Agent Workspace API (OpenAPI 3.1)](docs/sdk/site/openapi.json): ',
    );
  });

  it('puts the repository rules first and the generated reference last', () => {
    const headings = rendered.split('\n').filter((line) => line.startsWith('## '));
    expect(headings[0]).toBe('## Start here');
    expect(headings.at(-1)).toBe('## Optional');
    expect(rendered.indexOf('](AGENTS.md): ')).toBeLessThan(rendered.indexOf('## Docs site: '));
    expect(rendered.includes('](docs/sdk/site/reference/sdk/client.mdx): ')).toBe(true);
    expect(rendered.indexOf('## Optional')).toBeLessThan(
      rendered.indexOf('](docs/sdk/site/reference/sdk/client.mdx): '),
    );
  });

  it('renders byte-identical output on a second render', async () => {
    expect(await renderLlmsTxt(repoRoot)).toBe(rendered);
    expect(rendered.endsWith('\n')).toBe(true);
    expect(rendered.includes('\r')).toBe(false);
  });

  it('is current with the committed llms.txt', async () => {
    expect(await compareWithDisk(rendered, repoRoot)).toEqual({ ok: true, issue: null });
  });
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
