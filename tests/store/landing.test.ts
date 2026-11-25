/**
 * The detail page's landing copy (use-cases plan §6.1): one Markdown file per entry,
 * `examples/store/catalog/landing/<slug>.md`, Japanese first, read here and written to
 * `examples/store/catalog/landing.generated.ts`, which `defineLanding` validates with zod when the
 * store loads it. The copy is prose, so the apps benchmark does not count it as handwritten code.
 * `APPS_WRITE=1 pnpm vitest run --project tests-store tests/store` rewrites the generated file;
 * without it a stale file fails.
 *
 * A file has `# ja` and `# en`, each with the same `##` fields: `headline`, `audience` and `problem`
 * (one paragraph), `steps` (five numbered lines, each starting with the safety features it uses in
 * brackets, the same in both languages), `outputs` and `limits` (bullets) and `faq` (a `###`
 * question per answer paragraph).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CATALOG } from '../../examples/store/catalog/index.ts';
import { LANDING } from '../../examples/store/catalog/landing.generated.ts';
import { defineLanding, type Landing } from '../../examples/store/catalog/define.ts';
import { REPOSITORY_ROOT } from '../apps/registry.ts';

const WRITE = process.env['APPS_WRITE'] === '1';
/** receive → look up → decide → a person confirms → write (use-cases plan §6.1). */
const STEP_COUNT = 5;
const CATALOG_DIR = path.join(REPOSITORY_ROOT, 'examples/store/catalog');
const LANDING_DIR = path.join(CATALOG_DIR, 'landing');
const GENERATED = path.join(CATALOG_DIR, 'landing.generated.ts');

type Pair = { ja: string; en: string };
type Step = { text: Pair; safety: string[] };
/** A landing page as the Markdown says it, before zod checks it. */
interface ParsedLanding {
  headline: Pair;
  audience: Pair;
  problem: Pair;
  steps: Step[];
  outputs: Pair[];
  faq: { q: Pair; a: Pair }[];
  limits: Pair[];
}

/** The text under each heading that starts with `marker` (`# `, `## `, `### `), in order. */
export function underHeadings(text: string, marker: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith(marker)) {
      const name = line.slice(marker.length).trim();
      if (found.has(name)) throw new Error(`the heading "${marker}${name}" appears twice`);
      current = [];
      found.set(name, current);
    } else if (line.trim() !== '') {
      if (current === undefined)
        throw new Error(`text before the first "${marker.trim()}" heading`);
      current.push(line.trim());
    }
  }
  return found;
}

function field(fields: Map<string, string[]>, name: string): string[] {
  const lines = fields.get(name);
  if (lines === undefined || lines.length === 0) throw new Error(`no "## ${name}"`);
  return lines;
}

/** One language's fields: paragraphs joined, bullets and steps one per line. */
function parseLanguage(body: string[], lang: 'ja' | 'en') {
  const fields = underHeadings(body.join('\n'), '## ');
  const paragraph = (lines: readonly string[]) => lines.join(lang === 'ja' ? '' : ' ');
  const bullets = (name: string) =>
    field(fields, name).map((line) => {
      if (!line.startsWith('- ')) throw new Error(`"## ${name}" holds a line that is not a bullet`);
      return line.slice(2).trim();
    });
  const lines = field(fields, 'steps');
  if (lines.length !== STEP_COUNT) {
    throw new Error(
      `${lang} has ${String(lines.length)} steps; the flow has ${String(STEP_COUNT)}`,
    );
  }
  const steps = lines.map((line, index) => {
    const match = /^(\d+)\. \[([a-z, ]*)\] (.+)$/u.exec(line);
    if (match === null) throw new Error(`a step is not "N. [features] text": ${line}`);
    if (Number(match[1]) !== index + 1) {
      throw new Error(`step ${String(index + 1)} is numbered ${String(match[1])}`);
    }
    const features = (match[2] ?? '').split(',').map((feature) => feature.trim());
    return { safety: features.filter(Boolean), text: match[3] ?? '' };
  });
  const faq = [...underHeadings(field(fields, 'faq').join('\n'), '### ')].map(([q, a]) => ({
    q,
    a: paragraph(a),
  }));
  return {
    headline: paragraph(field(fields, 'headline')),
    audience: paragraph(field(fields, 'audience')),
    problem: paragraph(field(fields, 'problem')),
    steps,
    outputs: bullets('outputs'),
    faq,
    limits: bullets('limits'),
  };
}

function pairs(ja: readonly string[], en: readonly string[], what: string): Pair[] {
  if (ja.length !== en.length)
    throw new Error(`${what}: ja has ${String(ja.length)}, en ${String(en.length)}`);
  return ja.map((text, index) => ({ ja: text, en: en[index] ?? '' }));
}

/** A landing file's copy, both languages paired. Throws on a file that is not in the format. */
export function parseLanding(text: string): ParsedLanding {
  const languages = underHeadings(text, '# ');
  if ([...languages.keys()].join() !== 'ja,en')
    throw new Error('the file is not "# ja" then "# en"');
  const ja = parseLanguage(languages.get('ja') ?? [], 'ja');
  const en = parseLanguage(languages.get('en') ?? [], 'en');
  const steps = pairs(
    ja.steps.map((step) => step.text),
    en.steps.map((step) => step.text),
    'steps',
  ).map((text, index) => {
    const safety = ja.steps[index]?.safety ?? [];
    if (en.steps[index]?.safety.join() !== safety.join()) {
      throw new Error(`step ${String(index + 1)}: ja and en name different safety features`);
    }
    return { text, safety };
  });
  if (ja.faq.length !== en.faq.length) {
    throw new Error(`faq: ja has ${String(ja.faq.length)}, en ${String(en.faq.length)}`);
  }
  return {
    headline: { ja: ja.headline, en: en.headline },
    audience: { ja: ja.audience, en: en.audience },
    problem: { ja: ja.problem, en: en.problem },
    steps,
    outputs: pairs(ja.outputs, en.outputs, 'outputs'),
    faq: ja.faq.map((item, index) => ({
      q: { ja: item.q, en: en.faq[index]?.q ?? '' },
      a: { ja: item.a, en: en.faq[index]?.a ?? '' },
    })),
    limits: pairs(ja.limits, en.limits, 'limits'),
  };
}

const HEADER = `// Generated from examples/store/catalog/landing/<slug>.md by \`APPS_WRITE=1 pnpm vitest run --project tests-store tests/store\`.
// Do not edit by hand: tests/store/landing.test.ts fails when it differs from the Markdown.
`;

function render(pages: Readonly<Record<string, ParsedLanding>>): string {
  return `${HEADER}
import { defineLanding } from './define.ts';

/** Each entry's landing-page copy, keyed by slug; the detail page shows a section per field. */
export const LANDING = defineLanding(${JSON.stringify(pages, null, 2)});
`;
}

const files = readdirSync(LANDING_DIR).sort();

/** Every landing file parsed, keyed by slug; an error names the file it is in. */
function parseFiles(): Record<string, ParsedLanding> {
  return Object.fromEntries(
    files.map((file) => {
      try {
        return [
          file.replace(/\.md$/u, ''),
          parseLanding(readFileSync(path.join(LANDING_DIR, file), 'utf8')),
        ];
      } catch (error) {
        throw new Error(
          `catalog/landing/${file}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }),
  );
}

/**
 * Phrases that say an entry is not live yet, in both languages. The detail page already says so for
 * a coming-soon entry (its badge and launch-notice section), so the copy need not; a live entry's
 * copy must not, or the page contradicts itself once the entry flips: a coming-soon entry whose copy
 * says so (privacy's "when can I use it?" FAQ item did until it went live) loses that text in the PR
 * that flips it.
 * The Japanese phrases are anchored on まだ or a status word, not a bare 公開前, which a true
 * sentence such as 「原稿を公開前に確認する」 could hold.
 */
const NOT_LIVE = [
  'まだ公開',
  '公開前です',
  '近日公開',
  '公開のお知らせ',
  '準備中',
  'いつ使える',
  'まだ使え',
  'まだ試せ',
  'not live yet',
  'not yet live',
  "isn't live",
  'not launched',
  'coming soon',
  'launch notice',
  'notified when',
  'when can i use it',
  'cannot try it',
  'not available yet',
  'not yet available',
] as const;

/** Every string a landing page shows, in both languages. */
function landingText(landing: Landing): string[] {
  const texts: readonly Pair[] = [
    landing.headline,
    landing.audience,
    landing.problem,
    ...landing.steps.map((step) => step.text),
    ...landing.outputs,
    ...landing.faq.flatMap(({ q, a }) => [q, a]),
    ...landing.limits,
  ];
  return texts.flatMap(({ ja, en }) => [ja, en]);
}

/** The not-live phrases a text holds, case-insensitively. */
function notLiveClaims(texts: readonly string[]): string[] {
  return NOT_LIVE.filter((phrase) => texts.some((text) => text.toLowerCase().includes(phrase)));
}

const MINIMAL = `# ja
## headline
見出し
## audience
担当者
## problem
いまの仕事。
## steps
1. [person] 受け取る
2. [] 調べる
3. [] 判断する
4. [approval] 確認する
5. [] 書き込む
## outputs
- 表
## faq
### 質問？
答え。
## limits
- しないこと
# en
## headline
Headline
## audience
Staff
## problem
The work
today.
## steps
1. [person] Receive
2. [] Look up
3. [] Decide
4. [approval] Confirm
5. [] Write
## outputs
- A table
## faq
### Question?
Answer.
## limits
- What it does not do
`;

describe('the landing copy', () => {
  it('examples/store/catalog/landing.generated.ts matches the Markdown files', async () => {
    const parsed = parseFiles();
    if (WRITE) await writeFile(GENERATED, render(parsed));
    expect(
      LANDING,
      'examples/store/catalog/landing.generated.ts is stale; run with APPS_WRITE=1',
    ).toEqual(defineLanding(parsed));
  });

  it('holds only .md files named after a catalog entry', () => {
    const slugs = new Set(CATALOG.map((entry) => entry.slug));
    for (const file of files) {
      expect(file, file).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u);
      expect(slugs.has(file.replace(/\.md$/u, '')), file).toBe(true);
    }
  });

  it('has copy for one live and one coming-soon entry at least', () => {
    const statuses = new Set(
      Object.keys(LANDING).map((slug) => CATALOG.find((entry) => entry.slug === slug)?.status),
    );
    expect([...statuses].sort()).toEqual(['live', 'soon']);
  });

  it("never says on a live entry's page that the entry is not live yet", () => {
    for (const [slug, landing] of Object.entries(LANDING)) {
      if (CATALOG.find((entry) => entry.slug === slug)?.status !== 'live') continue;
      expect(notLiveClaims(landingText(landing)), slug).toEqual([]);
    }
  });

  it('finds a not-live claim in either language', () => {
    expect(notLiveClaims(['まだ公開前です。'])).toEqual(['まだ公開', '公開前です']);
    expect(notLiveClaims(['いつ使えるようになりますか？', '準備中です。'])).toEqual([
      '準備中',
      'いつ使える',
    ]);
    expect(notLiveClaims(['原稿を公開前に確認する。'])).toEqual([]);
    expect(notLiveClaims(["It isn't live; get notified when it is."])).toEqual([
      "isn't live",
      'notified when',
    ]);
    expect(notLiveClaims(['It is Not Live Yet.', 'Sign up for a launch notice.'])).toEqual([
      'not live yet',
      'launch notice',
    ]);
    expect(notLiveClaims(['Try it with the sample data.'])).toEqual([]);
  });

  it('names on a step only the safety features the entry is shown to use', () => {
    for (const [slug, landing] of Object.entries(LANDING)) {
      const entry = CATALOG.find((candidate) => candidate.slug === slug);
      const shown: readonly string[] = entry?.status === 'live' ? entry.safety : [];
      for (const step of landing.steps) {
        for (const feature of step.safety) expect(shown, `${slug}: ${feature}`).toContain(feature);
      }
      if (
        entry?.status === 'live' &&
        landing.steps.some((step) => step.safety.includes('approval'))
      ) {
        expect(
          entry.demo.check?.approval,
          `${slug}: an approval step needs the moment's approval`,
        ).toBeTruthy();
      }
    }
  });

  it('reads the format, pairing the two languages', () => {
    const landing = parseLanding(MINIMAL);
    expect(landing.problem).toEqual({ ja: 'いまの仕事。', en: 'The work today.' });
    expect(landing.steps[3]).toEqual({
      text: { ja: '確認する', en: 'Confirm' },
      safety: ['approval'],
    });
    expect(landing.faq).toEqual([
      { q: { ja: '質問？', en: 'Question?' }, a: { ja: '答え。', en: 'Answer.' } },
    ]);
  });

  it('refuses a file out of format', () => {
    expect(() => parseLanding(MINIMAL.replace('# en', '# fr'))).toThrow(/# ja/u);
    expect(() => parseLanding(MINIMAL.replace('## audience\n担当者\n', ''))).toThrow(/audience/u);
    expect(() => parseLanding(MINIMAL.replace('- 表', '表'))).toThrow(/bullet/u);
    expect(() => parseLanding(MINIMAL.replace('1. [person] Receive', '1. Receive'))).toThrow(
      /step/u,
    );
    expect(() => parseLanding(MINIMAL.replace('1. [person] Receive', '1. [] Receive'))).toThrow(
      /different safety/u,
    );
    expect(() => parseLanding(MINIMAL.replace('- What it does not do', '- One\n- Two'))).toThrow(
      /limits/u,
    );
    expect(() => parseLanding(MINIMAL.replace('5. [] Write\n', ''))).toThrow(
      /en has 4 steps; the flow has 5/u,
    );
    expect(() => parseLanding(MINIMAL.replace('2. [] Look up', '3. [] Look up'))).toThrow(
      /step 2 is numbered 3/u,
    );
    expect(() => parseLanding(`Intro\n${MINIMAL}`)).toThrow(/text before the first "#"/u);
    expect(() => parseLanding(MINIMAL.replace('# en\n', '# en\nStray\n'))).toThrow(
      /text before the first "##"/u,
    );
    expect(() => parseLanding(MINIMAL.replace('### Question?\nAnswer.', 'Answer.'))).toThrow(
      /text before the first "###"/u,
    );
    expect(() => parseLanding(MINIMAL.replace('## outputs\n- 表', '## headline\n- 表'))).toThrow(
      /twice/u,
    );
  });
});
