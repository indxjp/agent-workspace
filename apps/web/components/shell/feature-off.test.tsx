import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FeatureSwitchedOff } from './feature-off';

function render(isOwner: boolean, locale: 'en' | 'ja' = 'en'): string {
  return renderToStaticMarkup(
    <FeatureSwitchedOff
      feature="files"
      cause={{ installed: true, isOwner, workspaceName: 'Acme Corp' }}
      locale={locale}
    />,
  );
}

function h1Count(html: string): number {
  return html.match(/<h1[\s>]/gu)?.length ?? 0;
}

describe('FeatureSwitchedOff', () => {
  it('tells an Owner the feature is off, nothing was deleted, and where to switch it on', () => {
    const html = render(true);
    expect(html).toContain('Files is switched off for this workspace.');
    expect(html).toContain('Nothing was deleted.');
    expect(html).toContain('A workspace Owner can switch it on in');
    expect(html).toContain('href="/admin/settings#features"');
    expect(html).toContain('Settings → Features');
    expect(html).not.toContain('Ask an Owner');
    expect(h1Count(html)).toBe(1);
  });

  it('tells anyone else to ask an Owner of the workspace, by name', () => {
    const html = render(false);
    expect(html).toContain('Files is switched off for this workspace.');
    expect(html).toContain('Ask an Owner of Acme Corp.');
    expect(h1Count(html)).toBe(1);
  });

  it('speaks Japanese for a Japanese request, Owner and non-Owner alike', () => {
    const owner = render(true, 'ja');
    expect(owner).toContain('このワークスペースでは ファイル がオフになっています。');
    expect(owner).toContain('データは何も削除されていません。');
    expect(owner).toContain('設定 → 機能');
    expect(owner).not.toContain('のオーナーに依頼してください');
    expect(h1Count(owner)).toBe(1);

    const member = render(false, 'ja');
    expect(member).toContain('Acme Corp のオーナーに依頼してください。');
    expect(h1Count(member)).toBe(1);
  });

  it('escapes a workspace name rather than rendering it as markup', () => {
    const html = renderToStaticMarkup(
      <FeatureSwitchedOff
        feature="runs"
        cause={{ installed: true, isOwner: false, workspaceName: '<b>x</b>' }}
        locale="en"
      />,
    );
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('Runs is switched off for this workspace.');
  });

  it('names the operator, not the Owner or Settings, for a feature the deployment does not install', () => {
    for (const locale of ['en', 'ja'] as const) {
      const html = renderToStaticMarkup(
        <FeatureSwitchedOff feature="skills" cause={{ installed: false }} locale={locale} />,
      );
      expect(html).not.toContain('href="/admin/settings#features"');
      expect(html).toContain('agent-workspace.yaml');
      expect(h1Count(html)).toBe(1);
    }
    const en = renderToStaticMarkup(
      <FeatureSwitchedOff feature="skills" cause={{ installed: false }} locale="en" />,
    );
    expect(en).toContain('Skills is not installed in this deployment.');
    expect(en).not.toContain('switched off for this workspace');
    expect(en).not.toContain('A workspace Owner can switch it on');
    expect(en).not.toContain('Ask an Owner');
    const ja = renderToStaticMarkup(
      <FeatureSwitchedOff feature="skills" cause={{ installed: false }} locale="ja" />,
    );
    expect(ja).toContain('このデプロイには スキル がインストールされていません。');
    expect(ja).not.toContain('設定 → 機能');
  });
});
