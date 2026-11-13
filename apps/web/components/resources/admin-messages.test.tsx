import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WorkspaceModelDefaultCard } from '../models/workspace-default-card';
import { SharedLinksScreen, shareMeta, shareState } from '../shares/shared-links-screen';
import { adminStrings } from './admin-messages';
import { ApiKeyRoleSelect, ApiKeyRow, ApiKeysScreen, SettingsScreen } from './resource-screens';

// UX-15 in #2086: Settings, API keys and Shared links in the reader's language.
describe('adminStrings', () => {
  const en = adminStrings('en');
  const ja = adminStrings('ja');

  it('has a Japanese word for every English one', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const sample = (value: (typeof en)[typeof key]): string =>
        typeof value === 'function'
          ? (value as (...args: never[]) => string)(...([3, '1', '5'] as never[]))
          : value;
      expect(sample(ja[key]), key).not.toBe('');
      expect(sample(ja[key]), key).not.toBe(sample(en[key]));
    }
  });

  it('keeps the numbers and amounts it is given', () => {
    expect(en.views(3)).toBe('3 views');
    expect(ja.views(3)).toBe('閲覧 3 回');
    expect(en.spentOf('1.20', '5.00')).toBe('$1.20 of $5.00');
    expect(ja.spentOf('1.20', '5.00')).toBe('$5.00 のうち $1.20');
  });
});

/** Text a Japanese screen must no longer show: every English word these screens printed. */
const ENGLISH = Object.values(adminStrings('en')).filter(
  (value): value is string => typeof value === 'string',
);

function expectJapanese(html: string, ...expected: string[]): void {
  expect(html).toContain('lang="ja"');
  for (const text of expected) expect(html).toContain(text);
  for (const english of ENGLISH) expect(html, english).not.toContain(`>${english}<`);
}

describe('the admin screens for a Japanese reader', () => {
  it('API keys: heading, form, roles and a key row', () => {
    expectJapanese(
      renderToStaticMarkup(createElement(ApiKeysScreen, { locale: 'ja' })),
      'API キー',
      'aria-label="キーの名前"',
      'placeholder="キーの名前"',
      '>キーを作成</button>',
    );
    const roles = renderToStaticMarkup(
      createElement(ApiKeyRoleSelect, { callerRole: 'owner', locale: 'ja' }),
    );
    for (const role of ['閲覧者', 'ビルダー', '管理者', 'オーナー']) expect(roles).toContain(role);
    expect(roles).toContain('value="owner"');
    expect(roles).toContain('aria-label="ロール"');
    const row = (revoked: boolean) =>
      renderToStaticMarkup(
        createElement(ApiKeyRow, {
          name: 'k',
          prefix: 'ak_live_x',
          revoked,
          onRevoke: () => {},
          strings: adminStrings('ja'),
        }),
      );
    expect(row(false)).toContain('>無効にする</button>');
    expect(row(true)).toContain('>無効<');
  });

  it('Settings: heading and the default-model card, with the literal value kept', () => {
    expectJapanese(
      renderToStaticMarkup(createElement(SettingsScreen, { managers: false, locale: 'ja' })),
      '>設定<',
      'このワークスペースの機能です。',
    );
    const card = renderToStaticMarkup(createElement(WorkspaceModelDefaultCard, { locale: 'ja' }));
    expectJapanese(card, 'ワークスペースの既定モデル', '<code>not set</code>');
  });

  it('Shared links: heading, switch and the loading line', () => {
    expectJapanese(
      renderToStaticMarkup(createElement(SharedLinksScreen, { locale: 'ja' })),
      '共有リンク',
      '公開共有',
      '読み込み中…',
    );
  });

  it('Shared links: states and the link line in the reader words, kind and mode as the server sent them', () => {
    const live = {
      subjectType: 'agent',
      mode: 'runnable',
      visibility: 'public',
      viewCount: 4,
      spentUsd: '1.20',
      budgetCapUsd: '5.00',
      revokedAt: null,
      suspendedAt: null,
      stopped: false,
    } as const;
    const ja = adminStrings('ja');
    const en = adminStrings('en');
    expect(shareMeta(live, en)).toBe('agent · runnable · 4 views · $1.20 of $5.00');
    expect(shareMeta(live, ja)).toBe('agent · runnable · 閲覧 4 回 · $5.00 のうち $1.20');
    expect(shareMeta({ ...live, mode: null, budgetCapUsd: null }, en)).toBe(
      'agent · public · 4 views',
    );
    expect(shareState(live, ja)).toBe('有効');
    expect(shareState({ ...live, stopped: true }, ja)).toBe('停止');
    expect(shareState({ ...live, stopped: true, suspendedAt: '2026-11-12T00:00:00Z' }, ja)).toBe(
      '一時停止中',
    );
    expect(
      shareState(
        {
          ...live,
          stopped: true,
          suspendedAt: '2026-11-12T00:00:00Z',
          revokedAt: '2026-11-12T00:00:00Z',
        },
        ja,
      ),
    ).toBe('無効');
    expect(shareState(live, en)).toBe('Active');
  });

  it('keeps the English for an English reader', () => {
    const keys = renderToStaticMarkup(createElement(ApiKeysScreen));
    expect(keys).toContain('API Keys');
    expect(keys).toContain('>Create key</button>');
    expect(renderToStaticMarkup(createElement(SharedLinksScreen))).toContain('Public sharing');
    expect(
      renderToStaticMarkup(createElement(ApiKeyRoleSelect, { callerRole: 'owner' })),
    ).toContain('>Owner</option>');
  });
});
