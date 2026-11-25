/**
 * What every live Agent Store entry shows a visitor: the prompts it suggests and the moment those
 * prompts must show (`demo.check`). The sample records behind them are checked in
 * `sample-data-records.test.ts`, and the numbers the card shows and the files' contents in
 * `sample-data-claims.test.ts`.
 *
 * Every tool a check names is one the demo agent can call, and every file a prompt names is one
 * the demo seeds. These rules hold for a coming-soon entry with a demo block too: its prompts and
 * check are part of the source hash its R1 record carries, so an entry that broke one would pass
 * R1 and still could not go live without a change that makes the record stale.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defineEntry, hasSource, type SourcedEntry } from '../../examples/store/catalog/define.ts';
import {
  bySlugRows,
  callableTools,
  entryOf,
  LANGS,
  live,
  sourceOf,
  withDemo,
} from './sample-data.test-support.ts';

/** The fewest suggested prompts a demo offers, each in both languages. */
const MIN_PROMPTS = 2;

/** The collections any prompt may name as `<collection>/<file>`, besides its entry's own seeds. */
const NAMED_COLLECTIONS = ['contracts', 'transcripts'];

/** A file a prompt names by its own name (`予実_2026年度上期_部門別.csv`), with or without a folder. */
const FILE_NAME =
  /([^\s、。「」（）()/]+\.(?:csv|xlsx|docx|pptx|pdf|md|txt|json))(?=$|[\s、。」）)をのと])/gu;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * A path a prompt of `entry` names as `<collection>/<path>`, at the start or after a space or
 * bracket, for the collections it seeds and the ones every prompt is held to: the named path must
 * be a file or folder under the seed folder of that collection.
 */
function seededPathMention(entry: SourcedEntry): RegExp {
  const names = new Set([...NAMED_COLLECTIONS, ...entry.demo.seed.map((seed) => seed.collection)]);
  const alternatives = [...names].map(escapeRegExp).join('|');
  return new RegExp(`(?:^|[\\s（(])((?:${alternatives})/[^\\s、。）)]+)`, 'gu');
}

/** The names of every file the demo of `entry` seeds or keeps as records. */
function seededFileNames(entry: SourcedEntry): Set<string> {
  const folders = [
    ...entry.demo.seed.map((seed) => seed.from),
    ...(entry.demo.records === undefined ? [] : [entry.demo.records]),
  ].map((folder) => path.join(sourceOf(entry), folder));
  return new Set(
    folders
      .filter((folder) => existsSync(folder))
      .flatMap((folder) => readdirSync(folder, { recursive: true, encoding: 'utf8' }))
      .map((file) => path.basename(file)),
  );
}

/**
 * The seeded files the suggested prompts of `entry` name that the demo does not have: a
 * `<collection>/<path>` with nothing at that path under the collection's seed folder, or a file
 * name (`<name>.csv`, `.md`, `.docx` …) that no seed or records folder of the demo holds.
 */
function missingPromptFiles(entry: SourcedEntry): string[] {
  const problems: string[] = [];
  const mention = seededPathMention(entry);
  const seeded = seededFileNames(entry);
  for (const [at, prompt] of entry.demo.prompts.entries()) {
    for (const lang of LANGS) {
      const where = `${entry.slug}: prompt ${String(at)} (${lang})`;
      for (const match of prompt[lang].matchAll(mention)) {
        const named = (match[1] ?? '').replace(/\.+$/u, '');
        const [collection, ...rest] = named.split('/');
        const seed = entry.demo.seed.find((folder) => folder.collection === collection);
        const file = seed === undefined ? null : path.join(sourceOf(entry), seed.from, ...rest);
        if (file === null || !existsSync(file)) problems.push(`${where} names ${named}`);
      }
      for (const match of prompt[lang].matchAll(FILE_NAME)) {
        const name = match[1] ?? '';
        if (!seeded.has(name)) problems.push(`${where} names the file ${name}`);
      }
    }
  }
  return problems;
}

/** Why the suggested prompts of `entry` could not go live: too few, or a file the demo lacks. */
function promptProblems(entry: SourcedEntry): string[] {
  const count = entry.demo.prompts.length;
  const tooFew =
    count < MIN_PROMPTS
      ? [`${entry.slug}: ${String(count)} suggested prompt(s), fewer than ${String(MIN_PROMPTS)}`]
      : [];
  return [...tooFew, ...missingPromptFiles(entry)];
}

/**
 * Why the moment check of `entry` could not go live: none, a tool its demo agent cannot call, the
 * approval tool listed among the others, or a tool listed twice.
 */
function checkProblems(entry: SourcedEntry): string[] {
  const check = entry.demo.check;
  if (check === undefined) return [`${entry.slug}: no demo.check`];
  const callable = callableTools(entry);
  const named = check.approval === null ? check.tools : [...check.tools, check.approval];
  const approvalAmongOthers = check.approval !== null && check.tools.includes(check.approval);
  return [
    ...named
      .filter((name) => !callable.has(name))
      .map((name) => `${entry.slug}: cannot call ${name}`),
    ...(approvalAmongOthers
      ? [`${entry.slug}: lists its approval tool ${String(check.approval)} among the others`]
      : []),
    ...(new Set(check.tools).size === check.tools.length
      ? []
      : [`${entry.slug}: lists a tool twice`]),
  ];
}

/** A coming-soon copy of the meeting-prep entry under another slug, with `demo` changed. */
function plantedSoon(demo: Partial<SourcedEntry['demo']>): SourcedEntry {
  const planted = defineEntry({
    ...entryOf(withDemo, 'meeting-prep'),
    slug: 'planted',
    status: 'soon',
    wave: 2,
  });
  if (!hasSource(planted)) throw new Error('the planted entry has no demo');
  return { ...planted, demo: { ...planted.demo, ...demo } };
}

describe('the moment each entry with a demo shows, live or coming soon', () => {
  it('is stated for every entry with a demo, as the tools one suggested prompt must call', () => {
    expect(withDemo.some((entry) => entry.status === 'soon')).toBe(true);
    const missing = withDemo.filter((entry) => entry.demo.check === undefined).map((e) => e.slug);
    expect(missing).toEqual([]);
  });

  it.each(bySlugRows(withDemo))(
    '%s: names only tools its demo agent can call, and the approval tool apart from the others',
    (_slug, entry) => {
      expect(checkProblems(entry)).toEqual([]);
    },
  );

  it('knows the tools an app agent gets and the ones a gallery agent gets', () => {
    // A guard on the helper itself: if it stopped finding tools, every check above would fail
    // for the wrong reason, or worse pass on an empty set.
    const bySlug = (slug: string): Set<string> => callableTools(entryOf(live, slug));
    expect(bySlug('crm-sales')).toContain('contact_update');
    expect(bySlug('crm-sales')).not.toContain('deal_create');
    expect(bySlug('wiki')).toContain('page_create');
    expect(bySlug('service-desk')).toContain('kb_article_search');
    expect(bySlug('service-desk')).not.toContain('kb_article_update');
    expect(bySlug('quotation')).toEqual(
      new Set(['Read', 'run_skill_script', 'searchParts', 'getOrder', 'getRate', 'createQuote']),
    );
    expect(bySlug('ringi-review')).toContain('check_authority');
    expect(bySlug('meeting-minutes')).toContain('list_members');
    // A use case's connector is served by the copy's stand-in from the seed's table.
    expect(callableTools(entryOf(withDemo, 'incident'))).toContain('create_task');
  });

  it('is exercised by suggested prompts in both languages, each naming only files the demo has', () => {
    expect(withDemo.flatMap(promptProblems)).toEqual([]);
  });

  it('refuses, while an entry is coming soon, one suggested prompt or a file it lacks', () => {
    const one = [{ ja: '2026-11-24 の商談の準備ブリーフを作成して', en: 'Prepare the briefs' }];
    expect(promptProblems(plantedSoon({ prompts: one }))).toEqual([
      'planted: 1 suggested prompt(s), fewer than 2',
    ]);
    const naming = [
      ...one,
      { ja: 'meeting-prep/none.csv を読んで', en: 'Read (contracts/x.md) and meetings.csv' },
      { ja: 'accounts.csv と 名簿.xlsx を比べて', en: 'Compare accounts.csv' },
    ];
    expect(promptProblems(plantedSoon({ prompts: naming }))).toEqual([
      'planted: prompt 1 (ja) names meeting-prep/none.csv',
      'planted: prompt 1 (ja) names the file none.csv',
      'planted: prompt 1 (en) names contracts/x.md',
      'planted: prompt 1 (en) names the file x.md',
      'planted: prompt 2 (ja) names the file 名簿.xlsx',
    ]);
  });

  it('refuses, while an entry is coming soon, a check with its approval tool among the others', () => {
    const check = { tools: ['search_files', 'Write'], approval: 'Write' };
    expect(checkProblems(plantedSoon({ check }))).toEqual([
      'planted: lists its approval tool Write among the others',
    ]);
    expect(checkProblems(plantedSoon({ check: undefined }))).toEqual(['planted: no demo.check']);
    const unknown = { tools: ['send_mail', 'send_mail'], approval: null };
    expect(checkProblems(plantedSoon({ check: unknown }))).toEqual([
      'planted: cannot call send_mail',
      'planted: cannot call send_mail',
      'planted: lists a tool twice',
    ]);
  });
});
