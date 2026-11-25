/**
 * The code-review entry's recorder: the patch the prompt names, read with the six rules of the
 * coding standard, one verdict per rule with the new file's line quoted, and the review written
 * behind the approval. Nothing is run: the review says only what the diff shows. The line numbers
 * are the new file's, counted from the hunk header `@@ -0,0 +1,17 @@` of src/members/search.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import codeReviewAgent from '../../../../use-cases/code-review/agents/code-review.ts';
import type { Lang, Recorder } from '../types.ts';
import { carries, reporting, table } from '../use-case-script.ts';
import { playUseCase } from '../use-case-desk.ts';

const PATCH = '0001-member-search';
const STANDARDS = [
  'CS-01-secrets',
  'CS-02-input',
  'CS-03-sql',
  'CS-04-errors',
  'CS-05-logging',
  'CS-06-tests',
].map((name) => `code-review/standards/${name}.md`);

const FILE = 'src/members/search.ts';
const PATCH_PATH = fileURLToPath(
  new URL(`../../../../use-cases/code-review/data/ja/inbox/${PATCH}.patch`, import.meta.url),
);

/** The new file's lines of `file` in `patch`: its one hunk adds them all, from line 1. */
function addedLines(patch: string, file: string): string[] {
  const start = patch.indexOf(`+++ b/${file}\n@@ -0,0 +1,`);
  if (start === -1) throw new Error(`code-review: the patch adds no ${file}`);
  const lines = patch.slice(start).split('\n').slice(2);
  const end = lines.findIndex((line) => !line.startsWith('+'));
  return lines.slice(0, end).map((line) => line.slice(1));
}

/** `file:line` with the line quoted; fails unless the patch adds that code on that line. */
function where(line: number, code: string): string {
  if (addedLines(readFileSync(PATCH_PATH, 'utf8'), FILE)[line - 1]?.trim() !== code) {
    throw new Error(`code-review: ${FILE}:${String(line)} is not ${code}`);
  }
  return `${FILE}:${String(line)} \`\` ${code} \`\``;
}

/** Where each finding is, checked against the patch when the recorder runs. */
const quoted = (): Record<'parse' | 'log' | 'sql' | 'catch', string> => ({
  parse: where(
    10,
    "const query = SearchQuerySchema.parse({ name: url.searchParams.get('name') });",
  ),
  log: where(11, 'logger.info(`member search: ${query.name}`);'),
  sql: where(
    13,
    "return await db.query(`SELECT id, name FROM members WHERE name LIKE '%${query.name}%'`);",
  ),
  catch: where(14, '} catch {'),
});
const FIX = {
  sql: "``return await db.query('SELECT id, name FROM members WHERE name LIKE $1', [`%${query.name}%`]);``",
  catch: '`} catch (error) { logger.error(error); throw error; }`',
  log: {
    ja: "`logger.info('member search');`（検索語は出さず、件数やIDを出す）",
    en: "`logger.info('member search');` (log no search term; an id or a count instead)",
  },
};

/** The review table in `lang`. */
function review(lang: Lang): string {
  const LINE = quoted();
  return {
    ja: () =>
      table(
        ['ルール', '判定', '該当箇所', '理由', '修正案'],
        [
          ['〔CS-01〕', 'OK', '', '追加された行に秘密情報の文字列がない', ''],
          [
            '〔CS-02〕',
            'OK',
            LINE.parse,
            '外部から入る検索語を、使う前に zod のスキーマで検証している',
            '',
          ],
          [
            '〔CS-03〕',
            'NG',
            LINE.sql,
            '検索語をテンプレート文字列で SQL に埋め込んでいる',
            FIX.sql,
          ],
          ['〔CS-04〕', 'NG', LINE.catch, 'catch で何も記録せず、空の配列を返している', FIX.catch],
          [
            '〔CS-05〕',
            '要注意',
            LINE.log,
            '個人情報を含みうる検索語をログに出している',
            FIX.log.ja,
          ],
          [
            '〔CS-06〕',
            'OK',
            'src/members/search.test.ts',
            '変更した振る舞いを確かめるテストファイルが追加されている',
            '',
          ],
        ],
      ),
    en: () =>
      table(
        ['Rule', 'Verdict', 'Where', 'Why', 'Fix'],
        [
          ['[CS-01]', 'OK', '', 'No added line holds a secret', ''],
          [
            '[CS-02]',
            'OK',
            LINE.parse,
            'The search term from outside is validated with a zod schema before use',
            '',
          ],
          [
            '[CS-03]',
            'NG',
            LINE.sql,
            'The search term is put into the SQL with a template string',
            FIX.sql,
          ],
          [
            '[CS-04]',
            'NG',
            LINE.catch,
            'The catch records nothing and returns an empty array',
            FIX.catch,
          ],
          [
            '[CS-05]',
            'caution',
            LINE.log,
            'It logs the search term, which may hold personal data',
            FIX.log.en,
          ],
          [
            '[CS-06]',
            'OK',
            'src/members/search.test.ts',
            'A test file that checks the new behaviour is added',
            '',
          ],
        ],
      ),
  }[lang]();
}

/** The answer in `lang`, around the review table `reviewed`. */
function answer(lang: Lang, reviewed: string): string {
  return {
    ja: `${PATCH}.patch を、コーディング規約の CS-01〜CS-06 でレビューしました。NGが2件（CS-03 SQL、CS-04 例外）、要注意が1件（CS-05 ログ）、OKが3件です。差分を読んだだけで、コードは実行していません。承認されたレビューを code-review-reports/${PATCH}_review.md に保存しました。\n\n${reviewed}\n\nマージするかどうかはレビュー担当者が判断してください。`,
    en: `I reviewed ${PATCH}.patch against CS-01 to CS-06 of the coding standard: 2 NG (CS-03, SQL; CS-04, exceptions), 1 caution (CS-05, logging) and 3 OK. I only read the diff and did not run the code. The approved review is saved to code-review-reports/${PATCH}_review.md.\n\n${reviewed}\n\nA person decides whether to merge.`,
  }[lang];
}

export const codeReview: Recorder = (ask) => {
  carries(ask, `code-review/inbox/${PATCH}.patch`);
  const reviewed = review(ask.lang);
  return playUseCase(
    ask.slug,
    codeReviewAgent,
    reporting({
      queries: [],
      open: [`code-review/inbox/${PATCH}.patch`, ...STANDARDS],
      file: `code-review-reports/${PATCH}_review.md`,
      report: `# ${PATCH} ${ask.lang === 'ja' ? 'レビュー' : 'review'}\n\n${reviewed}\n`,
      answer: answer(ask.lang, reviewed),
    }),
    ask,
  );
};
