/**
 * Use case 1, the manual search agent: the definition passes the contract, the platform's
 * `search_files` finds the clause inside the scope the portal's backend gives each run, and the
 * backend turns a run into a cited answer it has checked. See `../README.md` for the three tiers
 * and what each proves.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll } from 'vitest';

import { createFileSearch } from '../harness/file-search.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import type { ScriptAnswer, ScriptContext } from '../harness/scripted-workspace.ts';
import agentDefinition from './agents/manual-search.ts';
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

export {
  DIR,
  ENGINEER,
  NEW_HIRE,
  OUTSIDER,
  MANUALS,
  type Hit,
  search,
  project,
  readManualPdf,
  printedPage,
  followInstructions,
};
