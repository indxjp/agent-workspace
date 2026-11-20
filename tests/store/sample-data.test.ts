/**
 * What every live Agent Store entry shows a visitor: the prompts it suggests and the moment those
 * prompts must show (`demo.check`). The sample records behind them are checked in
 * `sample-data-records.test.ts`, and the numbers the card shows and the files' contents in
 * `sample-data-claims.test.ts`.
 *
 * Every tool a check names is one the demo agent can call, and every file a prompt names is one
 * the demo seeds.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LiveEntry } from '../../examples/store/catalog/define.ts';
import {
  bySlugRows,
  callableTools,
  entryOf,
  LANGS,
  live,
  sourceOf,
} from './sample-data.test-support.ts';

/** A seeded file a prompt names as `<collection>/<file>`, at the start or after a space or bracket. */
const SEEDED_FILE_MENTION = /(?:^|[\s（(])((?:contracts|transcripts)\/[^\s、。）)]+)/gu;

/** The seeded files the suggested prompts of `entry` name that the demo does not have. */
function missingPromptFiles(entry: LiveEntry): string[] {
  const problems: string[] = [];
  for (const [at, prompt] of entry.demo.prompts.entries()) {
    for (const lang of LANGS) {
      for (const match of prompt[lang].matchAll(SEEDED_FILE_MENTION)) {
        const named = (match[1] ?? '').replace(/\.+$/u, '');
        const [collection, ...rest] = named.split('/');
        const seed = entry.demo.seed.find((folder) => folder.collection === collection);
        const file = seed === undefined ? null : path.join(sourceOf(entry), seed.from, ...rest);
        if (file === null || !existsSync(file)) {
          problems.push(`${entry.slug}: prompt ${String(at)} (${lang}) names ${named}`);
        }
      }
    }
  }
  return problems;
}

describe('the moment each live entry shows', () => {
  it('is stated for every live entry, as the tools one suggested prompt must call', () => {
    const missing = live.filter((entry) => entry.demo.check === undefined).map((e) => e.slug);
    expect(missing).toEqual([]);
  });

  it.each(bySlugRows(live))(
    '%s: names only tools its demo agent can call, and the approval tool apart from the others',
    (_slug, entry) => {
      const check = entry.demo.check;
      if (check === undefined) throw new Error(`${entry.slug} has no demo.check`);
      const callable = callableTools(entry);
      const named = check.approval === null ? check.tools : [...check.tools, check.approval];
      expect(named.filter((name) => !callable.has(name))).toEqual([]);
      if (check.approval !== null) expect(check.tools).not.toContain(check.approval);
      expect(new Set(check.tools).size).toBe(check.tools.length);
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
  });

  it('is exercised by suggested prompts in both languages, each naming only files the demo has', () => {
    for (const entry of live) {
      expect(entry.demo.prompts.length).toBeGreaterThanOrEqual(2);
    }
    expect(live.flatMap(missingPromptFiles)).toEqual([]);
  });
});
