import { describe, expect, it } from 'vitest';

import {
  RESULT_CHART_KINDS,
  RESULT_CHART_LABEL_MAX_LENGTH,
  RESULT_CHART_POINTS_MAX,
  RESULT_CHART_VALUE_MAX,
  RESULT_CHARTS_MAX,
  ResultChartSchema,
  SurfaceDefinitionSchema,
  resultChartData,
  type ResultChart,
} from './surfaces.js';

const chart: ResultChart = {
  kind: 'bar',
  field: 'sites',
  label: 'site',
  value: 'sales',
  title: { ja: '拠点別売上', en: 'Sales by site' },
  axes: {
    label: { ja: '拠点', en: 'Site' },
    value: { ja: '売上（千円）', en: 'Sales (thousand yen)' },
  },
};

describe('ResultChartSchema (ADR-0168)', () => {
  it('accepts each kind, and a surface that declares charts', () => {
    expect(RESULT_CHART_KINDS).toEqual(['bar', 'line']);
    for (const kind of RESULT_CHART_KINDS) {
      expect(ResultChartSchema.parse({ ...chart, kind })).toEqual({ ...chart, kind });
    }
    const surface = { name: 'main', agent: 'analyst', resultCharts: [chart] };
    expect(SurfaceDefinitionSchema.parse(surface)).toEqual(surface);
  });

  it('refuses an unknown kind, an unknown key and a missing language', () => {
    expect(ResultChartSchema.safeParse({ ...chart, kind: 'pie' }).success).toBe(false);
    expect(ResultChartSchema.safeParse({ ...chart, colour: '#ff0000' }).success).toBe(false);
    expect(ResultChartSchema.safeParse({ ...chart, title: { ja: '売上' } }).success).toBe(false);
    expect(
      ResultChartSchema.safeParse({ ...chart, axes: { label: chart.axes.label } }).success,
    ).toBe(false);
  });

  it('refuses a key that is not a property name', () => {
    for (const field of ['', '1st', 'a.b', 'a-b', 'x'.repeat(65)]) {
      expect(ResultChartSchema.safeParse({ ...chart, field }).success, field).toBe(false);
    }
    expect(ResultChartSchema.safeParse({ ...chart, field: `_${'x'.repeat(63)}` }).success).toBe(
      true,
    );
  });

  it('refuses a label that is empty, too long, padded or carries an invisible character', () => {
    const titles = [
      '',
      'x'.repeat(RESULT_CHART_LABEL_MAX_LENGTH + 1),
      ' 売上',
      '売上 ',
      '売​上',
      '売\n上',
    ];
    for (const ja of titles) {
      expect(ResultChartSchema.safeParse({ ...chart, title: { ...chart.title, ja } }).success).toBe(
        false,
      );
    }
    const longest = 'x'.repeat(RESULT_CHART_LABEL_MAX_LENGTH);
    expect(
      ResultChartSchema.safeParse({ ...chart, title: { ja: '売', en: longest } }).success,
    ).toBe(true);
  });

  it('holds 1 to RESULT_CHARTS_MAX charts on a surface', () => {
    const surface = (resultCharts: readonly ResultChart[]) => ({
      name: 'main',
      agent: 'analyst',
      resultCharts,
    });
    expect(SurfaceDefinitionSchema.safeParse(surface([])).success).toBe(false);
    expect(
      SurfaceDefinitionSchema.safeParse(
        surface(Array.from({ length: RESULT_CHARTS_MAX }, () => chart)),
      ).success,
    ).toBe(true);
    expect(
      SurfaceDefinitionSchema.safeParse(
        surface(Array.from({ length: RESULT_CHARTS_MAX + 1 }, () => chart)),
      ).success,
    ).toBe(false);
  });
});

describe('resultChartData (ADR-0168 D3)', () => {
  it('reads each row as a point, a numeric label as text', () => {
    const output = {
      summary: '東京が最大',
      sites: [
        { site: '東京', sales: 1200, note: 'x' },
        { site: 2026, sales: -3.5 },
      ],
    };
    expect(resultChartData(chart, output)).toEqual({
      kind: 'points',
      points: [
        { label: '東京', value: 1200 },
        { label: '2026', value: -3.5 },
      ],
    });
  });

  it('reports an output without the field as no_field', () => {
    for (const output of [null, 'text', [], {}, { sites: 'many' }, { sites: { site: 'a' } }]) {
      expect(resultChartData(chart, output), JSON.stringify(output)).toEqual({
        kind: 'mismatch',
        reason: 'no_field',
      });
    }
  });

  it('reports an empty array and one over RESULT_CHART_POINTS_MAX rows', () => {
    expect(resultChartData(chart, { sites: [] })).toEqual({ kind: 'mismatch', reason: 'empty' });
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ site: `S${String(index)}`, sales: index }));
    expect(resultChartData(chart, { sites: rows(RESULT_CHART_POINTS_MAX) }).kind).toBe('points');
    expect(resultChartData(chart, { sites: rows(RESULT_CHART_POINTS_MAX + 1) })).toEqual({
      kind: 'mismatch',
      reason: 'too_many_rows',
    });
  });

  it('reports a row it cannot draw as bad_row', () => {
    const bad = [
      'row',
      ['東京', 1],
      { sales: 1 },
      { site: '東京' },
      { site: '東京', sales: '1200' },
      { site: '東京', sales: Number.NaN },
      { site: '東京', sales: Number.POSITIVE_INFINITY },
      { site: '東京', sales: RESULT_CHART_VALUE_MAX * 10 },
      { site: '東京', sales: -RESULT_CHART_VALUE_MAX * 10 },
      { site: '', sales: 1 },
      { site: Number.NaN, sales: 1 },
      { site: true, sales: 1 },
      { site: null, sales: 1 },
    ];
    for (const row of bad) {
      expect(resultChartData(chart, { sites: [{ site: 'a', sales: 1 }, row] })).toEqual({
        kind: 'mismatch',
        reason: 'bad_row',
      });
    }
  });

  it('draws a value at either end of the allowed magnitude', () => {
    const rows = [
      { site: 'a', sales: RESULT_CHART_VALUE_MAX },
      { site: 'b', sales: -RESULT_CHART_VALUE_MAX },
    ];
    expect(resultChartData(chart, { sites: rows }).kind).toBe('points');
  });

  it('reads only own properties', () => {
    const inherited = Object.create({ sites: [{ site: 'a', sales: 1 }] }) as object;
    expect(resultChartData(chart, inherited)).toEqual({ kind: 'mismatch', reason: 'no_field' });
    const row = Object.create({ site: 'a', sales: 1 }) as object;
    expect(resultChartData(chart, { sites: [row] })).toEqual({
      kind: 'mismatch',
      reason: 'bad_row',
    });
  });
});
