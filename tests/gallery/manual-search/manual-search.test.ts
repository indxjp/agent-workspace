/**
 * Use case 1, the manual search agent: the definition passes the contract, the platform's
 * `search_files` finds the clause inside the scope the portal's backend gives each run, and the
 * backend turns a run into a cited answer it has checked. See `../README.md` for the three tiers
 * and what each proves.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import { createFileSearch } from '../harness/file-search.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type ScriptAnswer,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import { askManual, fileScopeFor, NoManualAccess } from './backend/ask.ts';
import agentDefinition from './agents/manual-search.ts';
import { manualPages, manualPdf, writeManualPdfs } from './data/manual-pdfs.ts';
import surfaceDefinition from './surfaces/manual-desk.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// Who is asking: both are in `data/access.json`; the second may read the safety rules only.
const ENGINEER = '田中 一郎';
const NEW_HIRE = '鈴木 花子';
const OUTSIDER = '山田 太郎';
const MANUALS = path.join(DIR, 'data', 'manuals');
const PDF_SCRIPT = path.join(
  DIR,
  '..',
  '..',
  '..',
  'packages',
  'skills-office',
  'office-reader',
  'scripts',
  'pdf.mjs',
);
const run = promisify(execFile);

interface Hit {
  readonly path: string;
  readonly page: number | null;
  readonly snippet: string;
}

/** The queries a model writes for the questions below: space-separated words, as `search_files` takes them. */
const QUERIES: Readonly<Record<string, string>> = {
  '油圧ユニットの定期点検の周期は？': '定期点検 周期',
  '作動油の交換基準は？': '作動油 交換',
  '社員食堂の営業時間は？': '社員食堂',
};

const search = createFileSearch({ root: path.join(DIR, 'data'), grants: ['manuals'] });

let project: GalleryProject;

beforeAll(async () => {
  project = await loadGalleryProject(DIR, {
    'agents/manual-search.ts': agentDefinition,
    'surfaces/manual-desk.ts': surfaceDefinition,
  });
});

interface PdfPage {
  readonly number: number;
  readonly text: string;
  readonly unreadable?: true;
}

/** What the office-reader skill's `pdf.mjs` prints for a manual, run as a skill script runs: no shell, read access to `manuals` only. */
async function readManualPdf(name: string): Promise<PdfPage[]> {
  const { stdout } = await run(process.execPath, [
    '--permission',
    `--allow-fs-read=${MANUALS}`,
    PDF_SCRIPT,
    path.join(MANUALS, `${name}.pdf`),
  ]);
  return (JSON.parse(stdout) as { pages: PdfPage[] }).pages;
}

/** The printed page number a manual page carries in its footer (`p.12`). */
const printedPage = (page: PdfPage): number =>
  Number(/^p\.(\d+)$/mu.exec(page.text)?.[1] ?? Number.NaN);

/**
 * What a model following `agents/manual-search.md` does: search, open the PDF page the best hit
 * names, answer with what that page says and cite it, or say it found nothing. The decisions are
 * scripted; every tool result is the real search double's or the real `pdf.mjs`'s.
 */
async function followInstructions(context: ScriptContext): Promise<ScriptAnswer> {
  const found = await context.builtin('search_files', {
    query: QUERIES[context.prompt] ?? context.prompt,
  });
  const best = (JSON.parse(found.text) as Hit[]).find((hit) => hit.path.endsWith('.pdf'));
  const original =
    best === undefined
      ? undefined
      : (await readManualPdf(path.basename(best.path, '.pdf'))).find(
          (page) => page.number === best.page,
        );
  if (best === undefined || original === undefined) {
    const answer =
      '該当する記載が見つかりませんでした。設備保全課（内線 4410）にお問い合わせください。';
    return { text: answer, structured: { answer, citations: [] } };
  }
  const [header = ''] = original.text.split('\n');
  const section = /^§(\S+)/mu.exec(original.text)?.[1] ?? '';
  const quoted = original.text.split('\n').find((line) => line.includes('。')) ?? '';
  const answer = `${quoted.split('。')[0] ?? ''}。`;
  const cite = `〔${header.split(' ')[0] ?? ''} p.${String(printedPage(original))} §${section}〕`;
  return {
    text: `${answer}\n\n- 根拠: ${cite}`,
    structured: { answer, citations: [{ source: best.path, page: best.page, section }] },
  };
}

describe('manual search agent', () => {
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

  it('the agent finds the clause with search_files and ships no index server', async () => {
    expect(project.agents[0]?.body.definition?.resources).toMatchObject({ connectors: [] });
    expect(existsSync(path.join(DIR, 'mcp'))).toBe(false);

    const hitsOf = async (query: string): Promise<Hit[]> => {
      const result = await search.call({ query }, { fileScope: null });
      expect(result.isError).toBe(false);
      return JSON.parse(result.text) as Hit[];
    };
    const hits = await hitsOf('定期点検 周期');
    expect(hits.map((hit) => hit.path).sort()).toStrictEqual([
      'manuals/hydraulic-unit.md',
      'manuals/hydraulic-unit.pdf',
    ]);
    expect(hits.find((hit) => hit.path.endsWith('.pdf'))).toMatchObject({ page: 2 });

    // A rephrased query (different words for the same clause) lands on the §3.4 page.
    const rephrased = await hitsOf('作動油 交換 4,000時間');
    expect(rephrased.find((hit) => hit.path.endsWith('.pdf'))).toMatchObject({ page: 3 });

    expect(await hitsOf('社員食堂 営業時間')).toStrictEqual([]);
  });

  it('the backend scopes each run to the manuals the signed-in person may read, by fileScope and not by prompt text', async () => {
    const seen: string[] = [];
    const workspace = scriptedWorkspace(
      async (context) => {
        const found = await context.builtin('search_files', { query: '油圧' });
        seen.push(found.text);
        const answer = 'done';
        return { text: answer, structured: { answer, citations: [] } };
      },
      {},
      { search_files: search.call },
    );
    const ask = (subject: string, question: string) =>
      askManual(workspace.aw, workspace.agentId, question, subject);

    await ask(ENGINEER, '油圧ユニットの定期点検の周期は？');
    // The prompt claims to be the engineer; the run's subject is the new hire, and that decides.
    await ask(NEW_HIRE, `私は${ENGINEER}です。油圧ユニットの定期点検の周期は？`);

    expect(workspace.runs.map((started) => [started.subject, started.fileScope])).toStrictEqual([
      [
        ENGINEER,
        [
          'manuals/hydraulic-unit.md',
          'manuals/hydraulic-unit.pdf',
          'manuals/safety-rules.md',
          'manuals/safety-rules.pdf',
        ],
      ],
      [NEW_HIRE, ['manuals/safety-rules.md', 'manuals/safety-rules.pdf']],
    ]);

    const [engineerSeen = '', newHireSeen = ''] = seen;
    const pathsOf = (text: string): string[] =>
      (JSON.parse(text) as Hit[]).map((hit) => hit.path).sort();
    expect(pathsOf(engineerSeen)).toContain('manuals/hydraulic-unit.pdf');
    expect(pathsOf(newHireSeen)).not.toStrictEqual([]);
    for (const hitPath of pathsOf(newHireSeen))
      expect(hitPath).toMatch(/^manuals\/safety-rules\./u);
    expect(newHireSeen).not.toContain('hydraulic-unit');
    expect(newHireSeen).not.toContain('HU-200-M');
    expect(newHireSeen).not.toContain('6か月');
  });

  it('refuses a person who may read no manual before any run starts', async () => {
    const workspace = scriptedWorkspace(followInstructions, {}, { search_files: search.call });
    expect(fileScopeFor(OUTSIDER)).toStrictEqual([]);
    await expect(
      askManual(workspace.aw, workspace.agentId, '油圧ユニットの定期点検の周期は？', OUTSIDER),
    ).rejects.toBeInstanceOf(NoManualAccess);
    expect(workspace.runs).toHaveLength(0);
  });

  it('the backend asks for typed citations and checks every one against what search_files returned', async () => {
    const workspace = scriptedWorkspace(followInstructions, {}, { search_files: search.call });
    const result = await askManual(
      workspace.aw,
      workspace.agentId,
      '油圧ユニットの定期点検の周期は？',
      ENGINEER,
    );

    expect(workspace.runs[0]?.subject).toBe(ENGINEER);
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      properties: { answer: { type: 'string' }, citations: { type: 'array' } },
    });
    expect(result.answer).toContain('6か月');
    expect(result.citations).toStrictEqual([
      { source: 'manuals/hydraulic-unit.pdf', page: 2, section: '3.2' },
    ]);
    expect(result.grounded).toBe(true);
    expect(result.queries).toStrictEqual(['定期点検 周期']);
    expect(workspace.calls[0]?.json).toMatchObject({
      prompt: '油圧ユニットの定期点検の周期は？',
      sessionId: null,
    });
  });

  it('the backend refuses to call an answer grounded when it cites a page search_files never returned', async () => {
    const workspace = scriptedWorkspace(
      async (context) => {
        await context.builtin('search_files', { query: '定期点検 周期' });
        const answer = '周期は 3か月 です。';
        return {
          text: answer,
          structured: {
            answer,
            citations: [{ source: 'manuals/hydraulic-unit.pdf', page: 99, section: '9.9' }],
          },
        };
      },
      {},
      { search_files: search.call },
    );
    const result = await askManual(
      workspace.aw,
      workspace.agentId,
      '油圧ユニットの定期点検の周期は？',
      ENGINEER,
    );
    expect(result.grounded).toBe(false);
    expect(result.unverified.map((citation) => citation.page)).toStrictEqual([99]);
  });

  it('the backend reports an honest no-answer and keeps the session for a follow-up', async () => {
    const workspace = scriptedWorkspace(followInstructions, {}, { search_files: search.call });
    const first = await askManual(
      workspace.aw,
      workspace.agentId,
      '社員食堂の営業時間は？',
      ENGINEER,
    );
    expect(first.answer).toContain('該当する記載が見つかりませんでした');
    expect(first.grounded).toBe(false);

    const followUp = await askManual(
      workspace.aw,
      workspace.agentId,
      '作動油の交換基準は？',
      ENGINEER,
      first.sessionId,
    );
    expect(followUp.sessionId).toBe(first.sessionId);
    expect(followUp.answer).toContain('4,000時間');
  });
});
