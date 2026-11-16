import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeploymentDriverBanner } from './driver-banner';
import { roleLabel } from './identity';
import { crumbsFor, NAVIGATION } from './navigation';
import { groupLabel, navLabel, shellStrings } from './shell-messages';
import { Sidebar } from './sidebar';
import { SkipLink } from './skip-link';
import { RuntimeIndicator, Topbar } from './topbar';

vi.mock('next/navigation', () => ({ usePathname: () => '/admin/api-keys' }));

afterEach(() => {
  vi.unstubAllEnvs();
});

const ITEMS = NAVIGATION.flatMap((group) => group.items);

describe('the shell in the reader’s language (UX-15)', () => {
  it('keeps §44’s English labels for an English reader, word for word', () => {
    expect(ITEMS.map((item) => navLabel(item, 'en'))).toEqual(ITEMS.map((item) => item.label));
    expect(NAVIGATION.map((group) => groupLabel(group, 'en'))).toEqual([null, 'Administration']);
  });

  it('names every entry in Japanese for a ja reader, with the Features card’s terms', () => {
    expect(ITEMS.map((item) => navLabel(item, 'ja'))).toEqual([
      '新しいチャット',
      'プロジェクト',
      'エージェント',
      'ファイル',
      'スキル',
      'コネクタ',
      '実行',
      'モデル',
      'ストレージ',
      'ユーザー',
      'API キー',
      'ランタイム',
      '共有リンク',
      '設定',
    ]);
    expect(NAVIGATION.map((group) => groupLabel(group, 'ja'))).toEqual([null, '管理']);
    expect(groupLabel({ label: 'Elsewhere' }, 'ja')).toBe('Elsewhere');
  });

  it('builds the breadcrumb trail in the reader’s language', () => {
    expect(crumbsFor('/admin/api-keys')).toEqual(['Administration', 'API Keys']);
    expect(crumbsFor('/admin/api-keys', 'ja')).toEqual(['管理', 'API キー']);
    expect(crumbsFor('/', 'ja')).toEqual(['新しいチャット']);
  });

  it('names the role under the user in the reader’s language', () => {
    expect(roleLabel('builder')).toBe('Builder');
    expect(roleLabel('builder', 'ja')).toBe('ビルダー');
    expect(roleLabel('owner', 'ja')).toBe('オーナー');
    expect(roleLabel('admin', 'ja')).toBe('管理者');
    expect(roleLabel('viewer', 'ja')).toBe('閲覧者');
    expect(roleLabel('auditor', 'ja')).toBe('Auditor');
    expect(roleLabel('toString', 'ja')).toBe('ToString');
    expect(roleLabel('', 'ja')).toBe('不明なロール');
    expect(roleLabel(undefined)).toBe('Unknown role');
  });

  it('renders the sidebar, its Menu button and the skip link in Japanese for a ja reader', () => {
    const render = (locale: 'en' | 'ja') =>
      renderToStaticMarkup(
        <Sidebar
          workspace={{ name: 'Acme', detail: 'Self-hosted', slug: null }}
          user={null}
          managers
          locale={locale}
        />,
      );
    const ja = render('ja');
    expect(ja).toContain('新しいチャット');
    expect(ja).toContain('管理');
    expect(ja).toContain('メニュー');
    expect(ja).not.toContain('New chat');
    const en = render('en');
    expect(en).toContain('New chat');
    expect(en).toContain('Administration');
    expect(en).toContain('Menu');
    expect(en).not.toContain('新しいチャット');
    expect(renderToStaticMarkup(<SkipLink label={shellStrings('ja').skipToContent} />)).toContain(
      '本文へ移動',
    );
    expect(renderToStaticMarkup(<SkipLink />)).toContain('Skip to content');
  });

  it('says the runtime chip and the driver band in the reader’s language', () => {
    const chip = { label: '未設定', warn: true, href: null } as const;
    const ja = renderToStaticMarkup(<RuntimeIndicator runtime={chip} locale="ja" />);
    expect(ja).toContain('ランタイム: 未設定');
    expect(ja).toContain('このワークスペースで使われているランタイムドライバー');
    expect(
      renderToStaticMarkup(
        <RuntimeIndicator runtime={{ label: 'local', warn: false, href: null }} />,
      ),
    ).toContain('Runtime: local');

    vi.stubEnv('RUNTIME_DRIVER', 'local');
    const band = renderToStaticMarkup(<DeploymentDriverBanner locale="ja" />);
    expect(band).toContain('使用中のランタイムドライバー:');
    expect(band).toContain('テナントの分離なし');
    expect(band).toContain('aria-label="閉じる"');
    vi.stubEnv('RUNTIME_DRIVER', '');
    expect(renderToStaticMarkup(<DeploymentDriverBanner locale="ja" />)).toContain(
      'ランタイム画面でランタイムを選んでテストしてください',
    );
    expect(renderToStaticMarkup(<DeploymentDriverBanner />)).toContain(
      'Runtime driver in force: <b>not configured</b>',
    );
  });
  it('marks each translated part with its own lang, since <html> stays en for the English screens', () => {
    const shell = (locale: 'en' | 'ja') =>
      renderToStaticMarkup(
        <>
          <SkipLink label={shellStrings(locale).skipToContent} lang={locale} />
          <Sidebar
            workspace={{ name: 'Acme', detail: 'Self-hosted', slug: null }}
            user={null}
            managers
            locale={locale}
          />
          <Topbar runtime={{ label: 'local', warn: true, href: null }} locale={locale} />
        </>,
      );
    const ja = shell('ja');
    expect(ja).toMatch(/<a lang="ja"[^>]*href="#main"/u);
    expect(ja).toMatch(/<aside lang="ja"/u);
    expect(ja).toMatch(/<header lang="ja"/u);
    const en = shell('en');
    expect(en).toMatch(/<aside lang="en"/u);
    expect(en).toMatch(/<header lang="en"/u);
    expect(en).not.toContain('lang="ja"');
  });
});
