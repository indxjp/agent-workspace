/**
 * What the sample files of the live Agent Store entries may hold and what the card says about them:
 * no file is oversized, none names a real address or phone number, and the numbers `demo.data`
 * states are the counts of the records or files the demo runs on.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LiveEntry } from '../../examples/store/catalog/define.ts';
import { DEMO_SAMPLE_FILE_MAX_BYTES } from '../../apps/web/server/demo/provision/limits.ts';
import { REPOSITORY_ROOT } from '../apps/registry.ts';
import {
  bySlugRows,
  LANGS,
  live,
  readJson,
  recordsFolder,
  sourceOf,
  withRecords,
} from './sample-data.test-support.ts';

// ---------------------------------------------------------------------------------------------
// Nothing real in a sample file
// ---------------------------------------------------------------------------------------------

/** Files a reader can scan for an address or number: text, not a binary the agent opens. */
const TEXT_FILE = /\.(?:md|json|txt|vtt|csv|ts|mjs|yaml)$/u;

/** Every file under `folder`, at any depth. */
const filesUnder = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory() ? filesUnder(path.join(folder, item.name)) : [path.join(folder, item.name)],
  );

function sampleFiles(entry: LiveEntry): string[] {
  const folders = [
    ...entry.demo.seed.map(({ from }) => path.join(sourceOf(entry), from)),
    ...(entry.demo.records === undefined ? [] : [path.join(sourceOf(entry), entry.demo.records)]),
  ];
  return folders.flatMap(filesUnder);
}

/** Addresses on a domain nobody owns (RFC 2606): `example.com`, `*.example`, `*.test`. */
const FICTIONAL_HOST = /^(?:example\.com|(?:[a-z0-9-]+\.)*example|(?:[a-z0-9-]+\.)*test)$/u;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/gu;
/** Phone-like numbers: grouped digits with hyphens or spaces, and a leading `+` or `0`. */
const PHONE = /(?<![\d-])(?:\+\d{1,3}[ -])?0?\d{1,4}[ -]\d{2,4}[ -]\d{3,4}(?![\d-])/gu;
/**
 * A number a reviewed seed file already carries: the fictional store's support line in the
 * customer-inquiry FAQ, which the gallery's backend also holds as a constant (`PUBLIC_NUMBERS`), so
 * it cannot change in the sample file alone. A new entry here is a decision, not a convenience.
 */
const REVIEWED_PHONES: ReadonlySet<string> = new Set(['0120-555-310']);
/** The ranges set aside for fiction: `0000` as the exchange, or the `555-01xx` block. */
const FICTIONAL_PHONE = /(?:^|[ -])0000[ -]\d{4}$|555[ -]01\d\d$/u;

/** The real-looking addresses and numbers one text file holds, each as `<file>: <kind> <value>`. */
function realContactProblems(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const where = path.relative(REPOSITORY_ROOT, file);
  const emails = [...text.matchAll(EMAIL)]
    .filter((match) => !FICTIONAL_HOST.test((match[1] ?? '').toLowerCase()))
    .map((match) => `${where}: email ${match[0]}`);
  const phones = [...text.matchAll(PHONE)]
    .filter((match) => !FICTIONAL_PHONE.test(match[0]) && !REVIEWED_PHONES.has(match[0]))
    .map((match) => `${where}: phone ${match[0]}`);
  return [...emails, ...phones];
}

describe('every sample file', () => {
  it('is no larger than a sample file may be', () => {
    const tooLarge = live
      .flatMap((entry) => sampleFiles(entry))
      .filter((file) => statSync(file).size > DEMO_SAMPLE_FILE_MAX_BYTES)
      .map((file) => path.relative(REPOSITORY_ROOT, file));
    expect(tooLarge).toEqual([]);
  });

  it('holds no email address outside example.com, .example and .test, and no real phone number', () => {
    const problems = live
      .flatMap((entry) => sampleFiles(entry))
      .filter((name) => TEXT_FILE.test(name))
      .flatMap(realContactProblems);
    expect(problems).toEqual([]);
  });

  it('is judged by checks that can fail: a real address and a real number are refused', () => {
    expect(FICTIONAL_HOST.test('example.com')).toBe(true);
    expect(FICTIONAL_HOST.test('aoba-seiki.example')).toBe(true);
    expect(FICTIONAL_HOST.test('mail.corp.test')).toBe(true);
    expect(FICTIONAL_HOST.test('kitano-seiki.co.jp')).toBe(false);
    expect(FICTIONAL_HOST.test('example.com.evil.net')).toBe(false);
    expect('03-1234-5678'.match(PHONE)?.[0]).toBe('03-1234-5678');
    expect(FICTIONAL_PHONE.test('03-1234-5678')).toBe(false);
    expect(FICTIONAL_PHONE.test('03-0000-5678')).toBe(true);
    expect(FICTIONAL_PHONE.test('+1 555-0123')).toBe(true);
    expect(FICTIONAL_PHONE.test('+1 415-555-2671')).toBe(false);
    expect('4800000 and 2026-10-02'.match(PHONE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The numbers on the card are the records' counts
// ---------------------------------------------------------------------------------------------

/** What `demo.data` says about each record file: the pattern that reads its count, by language. */
const COUNTED: Readonly<Record<string, readonly [file: string, ja: RegExp, en: RegExp][]>> = {
  'crm-sales': [
    ['company', /会社(\d+)社/u, /(\d+) fictional companies/u],
    ['contact', /担当者(\d+)名/u, /(\d+) contacts/u],
    ['deal', /商談(\d+)件/u, /(\d+) deals/u],
  ],
  'team-chat': [
    ['channel', /チャンネル(\d+)つ/u, /(\d+) channels/u],
    ['message', /メッセージ(\d+)件/u, /(\d+) messages/u],
  ],
  wiki: [
    ['space', /スペース(\d+)つ/u, /(\d+) spaces/u],
    ['page', /ページ(\d+)枚/u, /(\d+) pages/u],
  ],
  'service-desk': [
    ['ticket', /チケット(\d+)件/u, /(\d+) tickets/u],
    ['kb_article', /ナレッジ記事(\d+)本/u, /(\d+) knowledge articles/u],
  ],
  quotation: [
    ['parts', /部品(\d+)点/u, /(\d+) parts/u],
    ['orders', /過去受注(\d+)件/u, /(\d+) past orders/u],
    ['rates', /材料レート(\d+)種/u, /(\d+) material rates/u],
  ],
};

/** The count `demo.data` of `entry` states in `lang` with the pattern, or undefined if none. */
function statedCount(entry: LiveEntry, lang: 'ja' | 'en', patterns: { ja: RegExp; en: RegExp }) {
  return patterns[lang].exec(entry.demo.data[lang])?.[1];
}

describe('what an entry with sample records says about its data', () => {
  it('names every one of its record files, and no entry that has none', () => {
    expect(Object.keys(COUNTED).sort()).toEqual(withRecords.map((entry) => entry.slug).sort());
    for (const entry of withRecords) {
      const files = readdirSync(recordsFolder(entry, 'ja')).map((file) =>
        path.basename(file, '.json'),
      );
      expect((COUNTED[entry.slug] ?? []).map(([file]) => file).sort()).toEqual(files.sort());
    }
  });

  it.each(bySlugRows(withRecords))(
    '%s: the counts in demo.data are the counts of the records, in both languages',
    (slug, entry) => {
      for (const lang of LANGS) {
        for (const [file, ja, en] of COUNTED[slug] ?? []) {
          const records = readJson(path.join(recordsFolder(entry, lang), `${file}.json`));
          const count = Array.isArray(records)
            ? records.length
            : Object.keys(records as object).length;
          const said = statedCount(entry, lang, { ja, en });
          expect(said, `${slug} ${file} (${lang}): demo.data says no count`).toBeDefined();
          expect(Number(said), `${slug} ${file} (${lang})`).toBe(count);
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------
// The counts of an entry whose data is sample files
// ---------------------------------------------------------------------------------------------

const seededFiles = (entry: LiveEntry, collection?: string): string[] =>
  entry.demo.seed
    .filter((folder) => collection === undefined || folder.collection === collection)
    .flatMap((folder) => filesUnder(path.join(sourceOf(entry), folder.from)));
/** A document that ships as `.md` and `.pdf` is one document. */
const documents = (files: string[]): number =>
  new Set(files.map((file) => file.replace(/\.(?:md|pdf)$/u, ''))).size;

/** The Excel files of a branch folder that are monthly sales reports, not the shared template. */
const branchSalesReports = (entry: LiveEntry): number =>
  seededFiles(entry).filter(
    (file) =>
      !file.includes(`${path.sep}共通${path.sep}`) &&
      file.endsWith('.xlsx') &&
      /売上|月次/u.test(path.basename(file)),
  ).length;

/** What `demo.data` counts for an entry whose seed is files, and how to count it from the files. */
const COUNTED_FILES: Readonly<
  Record<string, readonly [ja: RegExp, en: RegExp, count: (entry: LiveEntry) => number][]>
> = {
  'cad-drafting': [[/図面(\d+)枚/u, /(\d+) past drawings/u, (e) => seededFiles(e).length]],
  // The customer records (data/crm) are read through a connector the copy does not carry, so
  // the card does not count them as the demo's sample data.
  'customer-inquiry': [[/FAQ(\d+)本/u, /(\d+) FAQ articles/u, (e) => seededFiles(e).length]],
  'manual-search': [[/マニュアル(\d+)冊/u, /(\d+) manuals/u, (e) => documents(seededFiles(e))]],
  maintenance: [
    [/マニュアル(\d+)冊/u, /(\d+) equipment manuals/u, (e) => seededFiles(e, 'manuals').length],
    [/記録(\d+)件/u, /(\d+) trouble records/u, (e) => seededFiles(e, 'trouble-log').length],
    [/メモ(\d+)本/u, /(\d+) veteran notes/u, (e) => seededFiles(e, 'expert-notes').length],
  ],
  // The defect reports (data/defects) are read through the qms connector, whose reads the copy
  // does not carry, so the card does not count them as the demo's sample data.
  'quality-defect': [
    [/FMEAシート(\d+)冊/u, /(\d+) FMEA workbook/u, (e) => seededFiles(e, 'fmea').length],
  ],
  'ringi-review': [
    [/規程(\d+)本/u, /(\d+) rule documents/u, (e) => seededFiles(e, 'rules').length],
    [/稟議(\d+)ファイル/u, /(\d+) files of past ringi/u, (e) => seededFiles(e, 'ringi').length],
  ],
  'excel-consolidation': [
    // One folder per branch, the shared template folder apart.
    [/(\d+)拠点の/u, /from (\d+) branches/u, (e) => e.demo.seed.length - 1],
    [/Excel (\d+)ファイル/u, /(\d+) monthly sales-report/u, branchSalesReports],
  ],
  'meeting-minutes': [
    [/文字起こし(\d+)本/u, /(\d+) meeting transcripts/u, (e) => seededFiles(e).length],
  ],
  nda: [
    [
      /サンプル(\d+)通/u,
      /(\d+) sample incoming NDAs/u,
      (e) => seededFiles(e).filter((file) => file.includes(`${path.sep}inbox${path.sep}`)).length,
    ],
  ],
};

/**
 * The live entries whose sample files the card describes without a count: contract-review's and
 * policy-qa's data are documents named by kind, not a number the card states.
 */
const UNCOUNTED = new Set(['contract-review', 'policy-qa']);

describe('what an entry with sample files says about its data', () => {
  const counted = live.filter((entry) => COUNTED_FILES[entry.slug] !== undefined);

  it('covers every live entry that has sample files and no records, bar the ones with no count', () => {
    const seeded = live.filter((entry) => entry.demo.seed.length > 0).map((e) => e.slug);
    expect(Object.keys(COUNTED_FILES).sort()).toEqual(
      seeded.filter((slug) => !UNCOUNTED.has(slug)).sort(),
    );
  });

  it.each(bySlugRows(counted))(
    '%s: the counts in demo.data are the counts of the files, in both languages',
    (slug, entry) => {
      for (const lang of LANGS) {
        for (const [ja, en, count] of COUNTED_FILES[slug] ?? []) {
          const said = statedCount(entry, lang, { ja, en });
          expect(said, `${slug} (${lang}): demo.data says no count`).toBeDefined();
          expect(Number(said), `${slug} (${lang}): ${entry.demo.data[lang]}`).toBe(count(entry));
        }
      }
    },
  );
});
