import { describe, expect, it } from 'vitest';

import {
  pageUnits,
  siteTranslationProblems,
  translatePage,
  unitKey,
  withAlternates,
} from '../../scripts/sites/i18n.mjs';

const keys = (html: string) => pageUnits(html).map((unit) => unit.key);

describe('the Japanese site: translation units', () => {
  it('keeps a paragraph with its inline markup as one unit, whitespace collapsed', () => {
    expect(
      keys('<p>\n  Run <code>aw push</code> to save\n  a <a href="x.html">version</a>.\n</p>'),
    ).toEqual(['Run <code>aw push</code> to save a <a href="x.html">version</a>.']);
  });

  it('splits a run of elements with no text between them into one unit per element', () => {
    expect(
      keys('<div><a class="docs" href="d">Docs</a>\n<a class="btn" href="c">Book a demo</a></div>'),
    ).toEqual(['Docs', 'Book a demo']);
    expect(keys('<li><a href="p.html">Product <span>platform overview</span></a></li>')).toEqual([
      'Product <span>platform overview</span>',
    ]);
  });

  it('leaves code, preformatted blocks, scripts, icons and translate="no" untouched', () => {
    expect(
      keys(
        [
          '<pre>npm run dev</pre>',
          '<script>var a = "Hello";</script>',
          '<td><code>maxTurns</code></td>',
          '<button><svg><title>Icon</title></svg>Agents</button>',
          '<p translate="no">Agent Workspace</p>',
          '<p>12 · 34</p>',
          '<!doctype html><title>Home</title>',
        ].join(''),
      ),
    ).toEqual(['Agents', 'Home']);
  });

  it('keys a unit without the value of a slot the build fills', () => {
    expect(unitKey('<!-- data:store-live -->44<!-- /data:store-live --> agents')).toBe(
      '<!-- data:store-live --><!-- /data:store-live --> agents',
    );
    expect(unitKey('benchmark <!-- benchmark:score x -->95<!-- benchmark:end -->/100')).toBe(
      'benchmark <!-- benchmark:score x --><!-- benchmark:end -->/100',
    );
    expect(
      keys('<div><!-- data:store-shelf --><p>Generated text</p><!-- /data:store-shelf --></div>'),
    ).toEqual([]);
  });
});

describe('the Japanese site: a translated page', () => {
  const page = [
    '<html lang="en"><head><link rel="canonical" href="https://lp.agentworkspace.indx.jp/compare.html">',
    '<link rel="stylesheet" href="assets/site.css"><meta name="description" content="Compare them."></head>',
    '<body><a class="lang-switch" href="ja/compare.html" hreflang="ja" lang="ja">日本語</a>',
    '<h1>Score <!-- benchmark:score x -->95<!-- benchmark:end -->/100</h1>',
    '<img src="assets/a.png" alt="A chart"><p>Untranslated</p></body></html>',
  ].join('');
  const strings: Record<string, string> = {
    'Score <!-- benchmark:score x --><!-- benchmark:end -->/100':
      'スコア <!-- benchmark:score x --><!-- benchmark:end -->/100',
    'Compare them.': '比べる。',
    'A chart': 'グラフ',
  };
  const result = translatePage('compare.html', page, (key) => strings[key]);

  it('puts each string in place and the slot value back from the English page', () => {
    expect(result.html).toContain(
      '<h1>スコア <!-- benchmark:score x -->95<!-- benchmark:end -->/100</h1>',
    );
    expect(result.html).toContain('content="比べる。"');
    expect(result.html).toContain('alt="グラフ"');
  });

  it('keeps each slot by its name when the translation puts the slots in another order', () => {
    const english =
      '<p><!-- data:store-total -->1<!-- /data:store-total --> agents in <!-- data:store-areas -->2<!-- /data:store-areas --> areas</p>';
    const reordered = translatePage('index.html', english, () =>
      [
        '<!-- data:store-areas --><!-- /data:store-areas --> の分野に',
        '<!-- data:store-total --><!-- /data:store-total --> 件',
      ].join(''),
    );
    expect(reordered.html).toContain(
      '<p><!-- data:store-areas -->2<!-- /data:store-areas --> の分野に<!-- data:store-total -->1<!-- /data:store-total --> 件</p>',
    );
  });

  it('reports each string it has no Japanese for and keeps the English there', () => {
    expect(result.missing).toEqual(['Untranslated']);
    expect(result.html).toContain('<p>Untranslated</p>');
  });

  it('moves the page one folder down and switches back to English', () => {
    expect(result.html).toContain('<html lang="ja">');
    expect(result.html).toContain('href="https://lp.agentworkspace.indx.jp/ja/compare.html"');
    expect(result.html).toContain('href="../assets/site.css"');
    expect(result.html).toContain('src="../assets/a.png"');
    expect(result.html).toContain('href="../compare.html" hreflang="en" lang="en">English</a>');
  });

  it('names both languages of a page beside its canonical link', () => {
    const html = withAlternates('<link rel="canonical" href="x">', 'index.html');
    expect(html).toContain('hreflang="en" href="https://lp.agentworkspace.indx.jp/"');
    expect(html).toContain('hreflang="ja" href="https://lp.agentworkspace.indx.jp/ja/"');
  });
});

describe('this checkout', () => {
  it('has a Japanese string for every English one, and none left over', () => {
    expect(siteTranslationProblems()).toEqual([]);
  });
});
