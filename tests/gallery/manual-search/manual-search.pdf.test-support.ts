import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { manualPages, manualPdf, writeManualPdfs } from './data/manual-pdfs.ts';
import {
  MANUALS,
  printedPage,
  project,
  readManualPdf,
} from './manual-search.fixture.test-support.ts';

export function definePdfCases(): void {
  it('the project passes the contract aw check applies', () => {
    const [agent] = project.agents;
    expect(project.agents).toHaveLength(1);
    const definition = agent?.body.definition;
    expect(definition?.agent.permissions).toStrictEqual({
      readFiles: true,
      writeFiles: false,
      runCommands: true,
      unrestrictedNetwork: false,
    });
    expect(definition?.policy).toMatchObject({
      tools: {
        permissionMode: 'default',
        autoApprove: [
          'mcp__agent-workspace__run_skill_script',
          'mcp__agent-workspace__search_files',
        ],
      },
    });
    expect(definition?.resources).toMatchObject({
      connectors: [],
      skills: ['office-reader', 'cite-answer'],
      files: [{ path: 'manuals', access: 'read' }],
    });
    expect(agent?.body.surfaces?.map((surface) => surface.name)).toStrictEqual(['manual-desk']);
    expect(agent?.body.surfaces?.[0]?.toolResults).toStrictEqual({
      search_files: 'card',
    });
    expect(definition?.agent.instructions).toContain('`search_files`');
    expect(definition?.agent.instructions).toContain('pdf.mjs');
    expect(project.skills.map((skill) => skill.name).sort()).toStrictEqual([
      'cite-answer',
      'office-reader',
    ]);
    expect(project.project.policy?.permissions).toMatchObject({
      writeFiles: false,
      runCommands: true,
      unrestrictedNetwork: false,
    });
  });

  it('ships each manual as a PDF written from its Markdown (GALLERY_WRITE=1 regenerates them)', () => {
    if (process.env['GALLERY_WRITE'] === '1') writeManualPdfs(MANUALS);
    const names = readdirSync(MANUALS)
      .filter((file) => file.endsWith('.md'))
      .map((file) => file.replace(/\.md$/u, ''));
    expect(names).toHaveLength(2);
    for (const name of names) {
      const markdown = readFileSync(path.join(MANUALS, `${name}.md`), 'utf8');
      expect(
        readFileSync(path.join(MANUALS, `${name}.pdf`)).equals(manualPdf(markdown)),
        name,
      ).toBe(true);
    }
  });

  it('maps a character outside the BMP to its UTF-16BE surrogate pair in ToUnicode', () => {
    const pdf = manualPdf('title: 𠮷\ncode: X\n<!-- page 1 -->\n𠮷\n').toString('latin1');
    expect(pdf).toContain('<0006> <d842dfb7>');
    expect(pdf).not.toMatch(/<20bb7>/u);
  });

  it('office-reader pdf.mjs returns each manual page as the Markdown has it, under the page number printed on it', async () => {
    for (const name of ['hydraulic-unit', 'safety-rules']) {
      const markdown = readFileSync(path.join(MANUALS, `${name}.md`), 'utf8');
      const expected = manualPages(markdown);
      const pages = await readManualPdf(name);
      expect(
        pages.map((page) => page.text),
        name,
      ).toStrictEqual(expected.map((page) => page.lines.join('\n')));
      expect(pages.map(printedPage), name).toStrictEqual(expected.map((page) => page.number));
      expect(pages.some((page) => page.unreadable === true)).toBe(false);
    }
    const [, page12] = await readManualPdf('hydraulic-unit');
    expect(page12?.text).toContain(
      '定期点検は 6か月 ごと、または稼働 2,000時間 ごとのいずれか早い方で実施する。',
    );
  });

  it('the eval file and the promotion bar are valid', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases.map((entry) => entry.name)).toHaveLength(4);
    expect(cases.some((entry) => entry.expect.notContains?.includes('〔'))).toBe(true);
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });
}
