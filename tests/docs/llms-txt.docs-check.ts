/**
 * What the llms.txt renderer makes of this repository: every page of the docs-site navigation once,
 * the repository rules first and the generated reference last, the same text on a second render.
 * That the committed llms.txt equals the render is `generate-llms-txt.mjs --check`, in the same
 * `pnpm docs:check`; the renderer's own cases are tests/docs/llms-txt.test.ts.
 *
 * A static check of the `docs-check` lane (tests/static-checks/vitest.config.ts).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { renderLlmsTxt } from '../../scripts/docs/generate-llms-txt.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
let rendered: string;

interface SiteManifest {
  readonly navigation: {
    readonly tabs: readonly {
      readonly groups: readonly { readonly pages?: readonly string[]; readonly openapi?: string }[];
    }[];
  };
}

beforeAll(async () => {
  rendered = await renderLlmsTxt(repoRoot);
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
});
