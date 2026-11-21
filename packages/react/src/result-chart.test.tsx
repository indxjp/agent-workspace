import type { ResultChart as ResultChartSpec } from '@indx-workspace/contracts/surfaces';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  RESULT_CHART_TICK_MAX_CHARACTERS,
  ResultChart,
  resultChartGeometry,
} from './result-chart.js';

const BAR: ResultChartSpec = {
  kind: 'bar',
  field: 'sites',
  label: 'site',
  value: 'sales',
  title: { ja: '拠点別売上', en: 'Sales by site' },
  axes: { label: { ja: '拠点', en: 'Site' }, value: { ja: '売上', en: 'Sales' } },
};
const LINE: ResultChartSpec = { ...BAR, kind: 'line' };
const OUTPUT = {
  sites: [
    { site: '東京', sales: 1200 },
    { site: '大阪', sales: -300 },
    { site: '名古屋', sales: 800 },
  ],
};

function render(chart: ResultChartSpec, structured: unknown, locale: 'en' | 'ja' = 'en'): string {
  return renderToStaticMarkup(
    <ResultChart chart={chart} structured={structured} locale={locale} />,
  );
}

/** The text of every `<tag>` element in `html`, in order (no nesting of the same tag here). */
function texts(html: string, tag: string): readonly string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>(.*?)</${tag}>`, 'gu');
  return [...html.matchAll(pattern)].map((match) => (match[1] ?? '').replace(/<[^>]+>/gu, ''));
}

/** The part of `html` inside the first `<tag>` element. */
function inside(html: string, tag: string): string {
  return new RegExp(`<${tag}\\b[^>]*>(.*?)</${tag}>`, 'u').exec(html)?.[1] ?? '';
}

// ADR-0168: a surface declares the chart; the result card draws it from the typed output.
describe('ResultChart', () => {
  it('draws one bar per row, hides the picture and gives a screen reader the rows as a table', () => {
    const html = render(BAR, OUTPUT);
    expect(texts(html, 'figcaption')).toEqual(['Sales by site']);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/u);
    expect(html.match(/data-mark="bar"/gu)).toHaveLength(3);
    expect(texts(inside(html, 'svg'), 'rect')).toEqual([
      '東京: 1,200',
      '大阪: -300',
      '名古屋: 800',
    ]);
    expect(html).toMatch(/<table style="[^"]*position:absolute[^"]*clip-path:inset\(50%\)/u);
    expect(texts(html, 'caption')).toEqual(['Sales by site']);
    expect(texts(inside(html, 'thead'), 'th')).toEqual(['Site', 'Sales']);
    expect(texts(inside(html, 'tbody'), 'tr')).toEqual(['東京1,200', '大阪-300', '名古屋800']);
    // The value axis's ends, then the first and last category, each with its whole text as title.
    expect(texts(inside(html, 'svg'), 'text')).toEqual([
      '1,200',
      '-300',
      '東京東京',
      '名古屋名古屋',
    ]);
    expect(html).toContain('text-anchor="start"');
    expect(html).toContain('text-anchor="end"');
    expect(html).toContain('Vertical: Sales · Horizontal: Site');
    expect(html).toContain('var(--accent, currentColor)');
  });

  it('draws a line with a marker per row, in Japanese', () => {
    const html = render(LINE, OUTPUT, 'ja');
    expect(texts(html, 'figcaption')).toEqual(['拠点別売上']);
    expect(html).toContain('<polyline');
    expect(html.match(/data-mark="point"/gu)).toHaveLength(3);
    expect(html).not.toContain('data-mark="bar"');
    expect(texts(inside(html, 'thead'), 'th')).toEqual(['拠点', '売上']);
    expect(html).toContain('縦軸: 売上 ・ 横軸: 拠点');
  });

  it('centres the only category label of a single-row chart', () => {
    const html = render(BAR, { sites: [{ site: '東京', sales: 5 }] });
    expect(html).toMatch(/<text[^>]*text-anchor="middle"><title>東京<\/title>東京<\/text>/u);
  });

  it('cuts a long category label on the picture, keeping the whole text in its title and the table', () => {
    const long = 'あ'.repeat(RESULT_CHART_TICK_MAX_CHARACTERS + 5);
    const exact = 'い'.repeat(RESULT_CHART_TICK_MAX_CHARACTERS);
    const html = render(BAR, {
      sites: [
        { site: long, sales: 1 },
        { site: exact, sales: 2 },
      ],
    });
    const cut = `${'あ'.repeat(RESULT_CHART_TICK_MAX_CHARACTERS - 1)}…`;
    expect(html).toContain(`<title>${long}</title>${cut}</text>`);
    expect(html).toContain(`<title>${exact}</title>${exact}</text>`);
    expect(texts(inside(html, 'tbody'), 'th')).toEqual([long, exact]);
  });

  it('says why an output does not fit the chart, in each language, and draws nothing', () => {
    const cases = [
      [{}, 'The result has no list for this chart.', '結果に、このグラフの一覧がありません。'],
      [
        { sites: [] },
        'The result’s list for this chart is empty.',
        '結果の、このグラフの一覧が空です。',
      ],
      [
        { sites: Array.from({ length: 61 }, () => ({ site: 'a', sales: 1 })) },
        'The result’s list is too long to chart.',
        '結果の一覧が長すぎて、グラフにできません。',
      ],
      [
        { sites: [{ site: 'a' }] },
        'A row of the result has no label or number this chart can draw.',
        '結果のある行に、このグラフで描けるラベルか数値がありません。',
      ],
    ] as const;
    for (const [output, en, ja] of cases) {
      const english = render(BAR, output);
      expect(texts(english, 'p')).toEqual([en]);
      expect(english).not.toContain('<svg');
      expect(english).not.toContain('<table');
      expect(texts(render(BAR, output, 'ja'), 'p')).toEqual([ja]);
    }
  });
});

describe('resultChartGeometry', () => {
  it('spans 0 on the value axis, so a bar’s length is its value', () => {
    const geometry = resultChartGeometry([
      { label: 'a', value: 10 },
      { label: 'b', value: 30 },
    ]);
    expect([geometry.low, geometry.high]).toEqual([0, 30]);
    expect(geometry.y(30)).toBeLessThan(geometry.y(10));
    expect(geometry.x(1) - geometry.x(0)).toBe(geometry.band);
    expect(resultChartGeometry([{ label: 'a', value: -4 }])).toMatchObject({ low: -4, high: 0 });
  });

  it('gives an all-zero output the span 0 to 1', () => {
    const geometry = resultChartGeometry([{ label: 'a', value: 0 }]);
    expect([geometry.low, geometry.high]).toEqual([0, 1]);
    expect(Number.isFinite(geometry.y(0))).toBe(true);
  });

  it('stays finite at the largest values the contract admits', () => {
    const geometry = resultChartGeometry([
      { label: 'a', value: 1e15 },
      { label: 'b', value: -1e15 },
    ]);
    expect(Number.isFinite(geometry.y(1e15))).toBe(true);
    expect(Number.isFinite(geometry.y(-1e15))).toBe(true);
  });
});
