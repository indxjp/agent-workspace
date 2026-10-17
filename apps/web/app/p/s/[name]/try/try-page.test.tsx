import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { keyCommands, TryPage, widgetSnippet, type TryPageProps } from './try-page';

const base: Pick<TryPageProps, 'origin' | 'surfaceName' | 'agentName' | 'definition'> = {
  origin: 'http://127.0.0.1:4310',
  surfaceName: 'main',
  agentName: 'support',
  definition: {
    name: 'main',
    agent: 'support',
    title: 'Help centre',
    parts: { greeting: 'Hi, ask me anything.', suggestedPrompts: ['Reset my password'] },
  },
};

describe('the try page with a key (GET /p/s/<name>/try; S1-18, #456)', () => {
  it('is the surface chat with its greeting and prompt chips, and no floating widget loader', () => {
    const html = renderToStaticMarkup(
      <TryPage {...base} title="Help centre" locale="en" promoted modelRefusal={null} />,
    );
    expect(html).toContain('data-layout="dock"');
    expect(html).toContain('Hi, ask me anything.');
    expect(html).toMatch(/<button[^>]*class="aw-prompt"[^>]*>Reset my password<\/button>/u);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('data-surface-not-promoted');
    expect(html).toContain('lang="en"');
  });

  it('keeps the one tag collapsed under Embed, with a copy button', () => {
    const html = renderToStaticMarkup(
      <TryPage {...base} title="Help centre" locale="en" promoted modelRefusal={null} />,
    );
    expect(widgetSnippet('http://127.0.0.1:4310', 'main')).toBe(
      '<script src="http://127.0.0.1:4310/p/s/main/widget.js" async></script>',
    );
    expect(html).toMatch(/<details[^>]*data-surface-embed=""(?![^>]*\bopen\b)[^>]*>/u);
    expect(html).toContain('>Embed</summary>');
    expect(html).toContain(
      '&lt;script src=&quot;http://127.0.0.1:4310/p/s/main/widget.js&quot; async&gt;&lt;/script&gt;',
    );
    expect(html).toContain('>Copy</span>');
  });

  it('is localised', () => {
    const html = renderToStaticMarkup(
      <TryPage {...base} title="ヘルプ" locale="ja" promoted modelRefusal={null} />,
    );
    expect(html).toContain('lang="ja"');
    expect(html).toContain('>埋め込み</summary>');
    expect(html).toContain('ページに追加するタグ');
  });

  it('notes that the agent is not promoted yet only while it has no production pointer (#612)', () => {
    const html = renderToStaticMarkup(
      <TryPage {...base} title="Help centre" locale="en" promoted={false} modelRefusal={null} />,
    );
    expect(html).toContain('data-surface-not-promoted');
    expect(html).toContain('Not promoted yet');
    expect(html).not.toContain('data-surface-model-refusal');
  });
});

// Issue #661: a developer with no key, a wrong one or an unreachable provider learns the exact fix
// from the first screen, before sending a message. UX-E (#760): one actionable card, per OS.
describe('the try page without a key (issue #661, #760)', () => {
  const render = (
    locale: 'en' | 'ja',
    code: NonNullable<TryPageProps['modelRefusal']>['code'],
    modelSecrets?: readonly string[],
    platform?: string,
  ): string =>
    renderToStaticMarkup(
      <TryPage
        {...base}
        title="Help centre"
        locale={locale}
        promoted
        modelRefusal={{ code, message: 'The server sentence.' }}
        modelSecrets={modelSecrets}
        platform={platform}
      />,
    );

  it('is one card: key link, the POSIX command, a copy button and the paste line', () => {
    const html = render('en', 'model_connection_unresolved', undefined, 'linux');
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-surface-model-refusal="model_connection_unresolved"');
    // BH061-052: the raw code and server sentence are folded away, not the card's first line.
    expect(html).toMatch(
      /<details[^>]*><summary[^>]*>model_connection_unresolved<\/summary>The server sentence\.<\/details>/u,
    );
    expect(html).toContain('href="https://console.anthropic.com/settings/keys"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('>Get an API key</a>');
    expect(html).toContain('export ANTHROPIC_API_KEY=&quot;&lt;your-key&gt;&quot;');
    expect(html).not.toContain('PowerShell');
    expect(html).toContain('>Copy</span>');
    expect(html).toContain('or restart aw dev and paste it when it asks for a key.');
    expect(html).toContain('>macOS / Linux<');
    // The page is unauthenticated: it never takes a key.
    expect(html).not.toMatch(/<(input|textarea)\b/u);
    expect(html).not.toContain('<script');
  });

  it('gives PowerShell and cmd commands on Windows', () => {
    const html = render('en', 'model_credential_rejected', ['MAIN_MODEL_KEY'], 'win32');
    // Another provider's secret: the Anthropic console link would mislead.
    expect(html).not.toContain('Get an API key');
    expect(html).toContain('$env:MAIN_MODEL_KEY=&quot;&lt;your-key&gt;&quot;');
    expect(html).toContain('set MAIN_MODEL_KEY=&lt;your-key&gt;');
    expect(html).not.toContain('ANTHROPIC_API_KEY');
    // A rejected key is already set, so aw dev will not ask for one: no paste line.
    expect(html).not.toContain('paste it when it asks');
    expect(keyCommands('K', 'darwin').map((c) => c.command)).toEqual(['export K="<your-key>"']);
  });

  it('gives a command for every model secret', () => {
    const html = render('en', 'model_connection_unresolved', ['A_KEY', 'B_KEY'], 'linux');
    expect(html).toContain('export A_KEY=');
    expect(html).toContain('export B_KEY=');
    expect(html).not.toContain('Get an API key');
    expect(render('en', 'model_connection_unresolved', ['ANTHROPIC_API_KEY', 'B_KEY'])).toContain(
      'Get an API key',
    );
  });

  it('does not call another refusal a connection problem or a missing key', () => {
    const html = render('en', 'model_unavailable');
    expect(html).toContain('>Try Help centre</h2>');
    expect(html).not.toContain('cannot be reached');
    expect(html).not.toContain('Get an API key');
    expect(html).toContain('The server sentence.');
  });

  it('is localised', () => {
    const html = render('ja', 'model_connection_unresolved');
    expect(html).toContain('>API キーを取得する</a>');
    expect(html).toContain('または、aw dev を再起動し、キーを求められたら貼り付けてください。');
  });

  it('gives a provider that cannot be connected to the reachability hint, not the key card', () => {
    const en = render('en', 'model_connection_failed');
    expect(en).toContain('(network, proxy, DNS)');
    expect(en).not.toContain('ANTHROPIC_API_KEY');
    expect(en).not.toContain('Get an API key');
    const ja = render('ja', 'model_connection_failed');
    expect(ja).toContain('ネットワーク、プロキシ、DNS');
    expect(ja).not.toContain('ANTHROPIC_API_KEY');
  });
});
