import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_CHOICES,
  connectionDetail,
  providerLabel,
  readModelConnections,
  type ModelConnectionView,
} from './model';
import { modelsStrings, type ModelsStrings } from './models-messages';
import { ModelsList, ModelsScreen } from './models-screen';
import { ProviderDetailPanel } from './provider-detail';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

const { AddProviderScreen } = await import('./add-provider-screen');

// UX-15 in #2086: the Models screens in the reader's language.

/** Every word a `ModelsStrings` holds, keyed by its path; functions are called with samples. */
function flatten(strings: ModelsStrings): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(strings)) {
    if (typeof value === 'string') out.set(key, value);
    else if (typeof value === 'function')
      out.set(key, (value as (...args: unknown[]) => string)(3, 'X'));
    else
      for (const [inner, word] of Object.entries(value as Record<string, string>))
        out.set(`${key}.${inner}`, word);
  }
  return out;
}

const en = modelsStrings('en');
const ja = modelsStrings('ja');

/** Brand names a Japanese screen keeps as they are. */
const SAME_IN_BOTH = new Set([
  'providerLabel.anthropic',
  'providerLabel.azure-openai',
  'providerLabel.openai',
]);

describe('modelsStrings', () => {
  it('has a Japanese word for every English one', () => {
    const english = flatten(en);
    const japanese = flatten(ja);
    expect([...japanese.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, word] of english) {
      expect(japanese.get(key), key).not.toBe('');
      if (!SAME_IN_BOTH.has(key)) expect(japanese.get(key), key).not.toBe(word);
    }
  });

  it("keeps English exactly as the screens printed it, including the provider list's words", () => {
    for (const choice of PROVIDER_CHOICES) {
      expect(en.providerLabel[choice.id]).toBe(choice.label);
      expect(en.providerDescription[choice.id]).toBe(choice.description);
      expect(en.providerLabel[choice.id]).toBe(providerLabel(choice.id));
    }
    expect(en.usedBy(1, 'A')).toBe(
      'This connection is used by 1 agent: A. Removing it falls those agents back to the workspace default model.',
    );
    expect(en.usedBy(2, 'A, B')).toContain('used by 2 agents: A, B.');
    expect(en.testReturned('502')).toBe('Connection test returned 502.');
  });

  it('keeps the values it is given', () => {
    expect(ja.usedBy(2, 'A, B')).toContain('2 個のエージェントが使っています: A, B');
    expect(ja.testing('Prod')).toBe('Prod をテスト中…');
    expect(ja.rotatedTestFailed('HTTP 404')).toContain('HTTP 404');
  });
});

function connection(overrides: Readonly<Record<string, unknown>> = {}): ModelConnectionView {
  const [parsed] = readModelConnections({
    models: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Prod Claude',
        provider: 'azure-openai',
        config: {
          baseUrl: 'https://company.openai.azure.com',
          deployment: 'gpt-41',
          apiVersion: 'v1',
        },
        hasCredential: true,
        ready: false,
        ...overrides,
      },
    ],
  });
  if (parsed === undefined) throw new Error('fixture connection failed to parse');
  return parsed;
}

/** Every English word these screens print, as a text node, which a Japanese screen must not show. */
const ENGLISH = [...flatten(en)]
  .filter(([key]) => !SAME_IN_BOTH.has(key))
  .map(([, word]) => word.trim())
  .filter((word) => word !== '');

function expectJapanese(html: string, ...expected: string[]): void {
  expect(html).toContain('lang="ja"');
  for (const text of expected) expect(html).toContain(text);
  for (const english of ENGLISH) expect(html, english).not.toContain(`>${english}<`);
}

const NOOP = (): void => {};

describe('the Models screens for a Japanese reader', () => {
  it('the list: heading, tabs, loading', () => {
    expectJapanese(
      renderToStaticMarkup(createElement(ModelsScreen, { locale: 'ja' })),
      '>モデル</h1>',
      '+ プロバイダーを追加',
      '>互換性<',
      'モデルの接続を読み込み中…',
    );
  });

  it('a row: status, detail line, credential note and buttons', () => {
    const html = renderToStaticMarkup(
      createElement(ModelsList, { models: [connection()], onChange: NOOP, locale: 'ja' }),
    );
    expectJapanese(
      html,
      '設定が不完全です',
      '認証情報は安全に保存済み',
      '>テスト</button>',
      '>管理</button>',
    );
    expect(html).toContain(
      'Microsoft Azure OpenAI · https://company.openai.azure.com · デプロイ gpt-41 · API バージョン v1',
    );
    expectJapanese(
      renderToStaticMarkup(createElement(ModelsList, { models: [], onChange: NOOP, locale: 'ja' })),
      'プロバイダーはまだ設定されていません',
    );
  });

  it('the Add Provider form, for an API-key provider and for Vertex', () => {
    expectJapanese(
      renderToStaticMarkup(createElement(AddProviderScreen, { locale: 'ja' })),
      '>プロバイダーを追加</h1>',
      'おすすめ',
      'Anthropic 互換エンドポイント',
      'API キー',
      'placeholder="エージェントの編集画面で選ぶときの名前"',
      '>保存</button>',
    );
    expectJapanese(
      renderToStaticMarkup(
        createElement(AddProviderScreen, { locale: 'ja', initialProvider: 'vertex' }),
      ),
      'Google Cloud プロジェクト（任意）',
      'グローバル（おすすめ）',
    );
    expectJapanese(
      renderToStaticMarkup(
        createElement(AddProviderScreen, { locale: 'ja', initialProvider: 'azure-openai' }),
      ),
      'エンドポイント',
      'デプロイ',
      '互換性はエンドポイントによって異なります',
    );
  });

  it('the detail panel, for an API-key connection and a keyless one', () => {
    expectJapanese(
      renderToStaticMarkup(
        createElement(ProviderDetailPanel, {
          connection: connection(),
          onUpdated: NOOP,
          onRemoved: NOOP,
          onClose: NOOP,
          locale: 'ja',
        }),
      ),
      '>接続の設定</h3>',
      '認証情報を更新',
      '新しい API キー',
      '接続を削除…',
      '>閉じる</button>',
    );
    expectJapanese(
      renderToStaticMarkup(
        createElement(ProviderDetailPanel, {
          connection: connection({
            provider: 'vertex',
            config: {},
            hasCredential: false,
            ready: true,
          }),
          onUpdated: NOOP,
          onRemoved: NOOP,
          onClose: NOOP,
          locale: 'ja',
        }),
      ),
      'サインイン',
      '使用可能',
      'Google Cloud の ID を使います',
    );
  });

  it('English readers see what they saw before', () => {
    const html = renderToStaticMarkup(
      createElement(ModelsList, { models: [connection()], onChange: NOOP }),
    );
    expect(html).toContain('lang="en"');
    expect(html).toContain('Configuration incomplete');
    expect(connectionDetail(connection())).toBe(
      'Microsoft Azure OpenAI · https://company.openai.azure.com · deployment gpt-41 · API version v1',
    );
  });
});
