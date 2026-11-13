import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RUNTIME_DRIVERS } from '../../contracts/runtimes';

import { RUNTIME_OPTIONS, SWITCH_COMPARISON } from './model';
import { runtimesStrings, type RuntimesStrings } from './runtimes-messages';
import { RuntimesScreen, type RuntimeScreenEntry } from './runtimes-screen';

// UX-15 in #2086: the Runtimes screen in the reader's language.

const en = runtimesStrings('en');
const ja = runtimesStrings('ja');

/** The screen's own words (not the per-driver rows or the comparison), functions sampled. */
function screenWords(strings: RuntimesStrings): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(strings)) {
    if (key === 'option' || key === 'switchComparison') continue;
    out.set(
      key,
      typeof value === 'function' ? (value as (name: string) => string)('X') : String(value),
    );
  }
  return out;
}

/** Labels that are product names, the same in both languages. */
const PRODUCT_NAMES = new Set([
  'docker',
  'kubernetes',
  'aws-agentcore',
  'aws-ecs',
  'gke-agent-sandbox',
  'vercel-sandbox',
  'cloudflare-sandbox',
]);

describe('runtimesStrings', () => {
  it('words every driver in the contract, in both languages', () => {
    expect(Object.keys(en.option).sort()).toEqual([...RUNTIME_DRIVERS].sort());
    expect(Object.keys(ja.option).sort()).toEqual([...RUNTIME_DRIVERS].sort());
    for (const driver of RUNTIME_DRIVERS) {
      if (PRODUCT_NAMES.has(driver)) expect(ja.option[driver].label).toBe(en.option[driver].label);
      else expect(ja.option[driver].label, driver).not.toBe(en.option[driver].label);
    }
  });

  it("has a Japanese word for every one of the screen's own", () => {
    const english = screenWords(en);
    const japanese = screenWords(ja);
    expect([...japanese.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, word] of english) {
      expect(japanese.get(key), key).not.toBe('');
      expect(japanese.get(key), key).not.toBe(word);
    }
  });
});

const DOCKER: RuntimeScreenEntry = {
  id: 'docker',
  label: 'Docker',
  connectionExists: true,
  imageReachable: true,
  testPassed: false,
  state: 'enabled',
  reason: null,
  networkPolicies: null,
};

/** Every English word this screen prints itself; a Japanese screen shows none as a text node. */
const ENGLISH = [
  ...screenWords(en).values(),
  ...RUNTIME_OPTIONS.filter((option) => !PRODUCT_NAMES.has(option.id)).map(
    (option) => option.label,
  ),
  ...RUNTIME_OPTIONS.flatMap((option) => [
    option.description,
    option.side ?? '',
    option.defaultReason ?? '',
  ]),
  SWITCH_COMPARISON.heading,
  ...SWITCH_COMPARISON.warnings,
  ...SWITCH_COMPARISON.blockers,
].filter((word) => word !== '');

describe('the Runtimes screen', () => {
  it('a Japanese reader sees every row, badge and note in Japanese', () => {
    const html = renderToStaticMarkup(
      createElement(RuntimesScreen, {
        entries: [DOCKER, { ...DOCKER, id: 'cloudflare-sandbox', refusal: 'Refused by server.' }],
        locale: 'ja',
      }),
    );
    expect(html).toContain('lang="ja"');
    for (const text of [
      '>ランタイム</h1>',
      'このマシン',
      'セルフホストにおすすめ',
      '>未検証<',
      '>分離なし<',
      '>おすすめ<',
      '>すべての実行を拒否<',
      'マネージドサンドボックス',
      // A driver the registry does not list is shown disabled with its translated reason.
      'このアカウントの ECR にイメージが公開されていません',
      '>ランタイムをテスト</button>',
      '<b>理由とともに無効</b>',
      '>ランタイム変更の比較</h2>',
      '✕ このエージェントはローカルコマンドのコネクタ',
      // The server's own refusal is shown as it came.
      'Refused by server.',
    ])
      expect(html, text).toContain(text);
    for (const english of ENGLISH) expect(html, english).not.toContain(`>${english}<`);
  });

  it('an English reader sees the spec and mockup words exactly', () => {
    const html = renderToStaticMarkup(createElement(RuntimesScreen, { entries: [DOCKER] }));
    expect(html).toContain('lang="en"');
    for (const option of RUNTIME_OPTIONS) expect(html).toContain(option.label);
    for (const line of [...SWITCH_COMPARISON.warnings, ...SWITCH_COMPARISON.blockers])
      expect(html).toContain(line.replaceAll('"', '&quot;'));
    expect(html).toContain('<b>disabled with the reason</b>, never hidden.');
    expect(html).toMatch(/<button[^>]*>Test Runtime<\/button>/u);
  });
});
