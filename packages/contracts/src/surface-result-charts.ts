import { z } from 'zod';

/**
 * A surface's result charts (ADR-0168): a small chart a run's result card draws from the run's
 * typed output (`RunResource.output.structured`, ADR-0143), declared on the surface so no use case
 * writes chart code. The spec names a top-level array field of the output and, in each row, the
 * key of its label and the key of its number; every word a reader sees is given in Japanese and
 * English. Re-exported from `./surfaces.js`, the module whose schema holds it.
 *
 * Like the rest of the surface contract, every schema here is plain structure: no default and no
 * transform, so the parsed value is the value written.
 */

/** The chart forms a result card draws (ADR-0168 D2). */
export const RESULT_CHART_KINDS = ['bar', 'line'] as const;
export type ResultChartKind = (typeof RESULT_CHART_KINDS)[number];
/** {@link RESULT_CHART_KINDS} as a schema (ADR-0168 D2). */
export const ResultChartKindSchema = z.enum(RESULT_CHART_KINDS);

/** The most charts one surface may declare (ADR-0168 D2). */
export const RESULT_CHARTS_MAX = 4;

/** The most rows one chart draws; a longer array is refused, never cut (ADR-0168 D3). */
export const RESULT_CHART_POINTS_MAX = 60;

/**
 * The largest magnitude a charted value may have. Beyond it the axis span of two extreme values
 * can overflow to `Infinity` and the scale to `NaN`, so such a row is refused (ADR-0168 D3).
 */
export const RESULT_CHART_VALUE_MAX = 1e15;

/** The longest chart title or axis label, in characters (ADR-0168 D2). */
export const RESULT_CHART_LABEL_MAX_LENGTH = 80;

/**
 * A key of the typed output, or of one of its rows: a JSON property name as a JSON Schema
 * `properties` key usually is — a letter or `_`, then letters, digits or `_`, at most 64.
 */
export const RESULT_CHART_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

const ResultChartKeySchema = z
  .string()
  .regex(
    RESULT_CHART_KEY_PATTERN,
    'must be a property name: a letter or _, then A-Z, a-z, 0-9 or _, 1-64 characters',
  );

/**
 * One line of text a reader sees: no control, format or separator character, and a visible first
 * and last character, so what the person reads is what the version holds.
 */
const ResultChartTextSchema = z
  .string()
  .min(1, { abort: true })
  .max(RESULT_CHART_LABEL_MAX_LENGTH, { abort: true })
  .regex(/^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u, {
    abort: true,
    error: 'must be one line with no control or invisible characters',
  })
  .regex(/^\S(?:.*\S)?$/u, 'must not start or end with whitespace');

/** A label in both languages the platform speaks, Japanese first (ADR-0168 D2). */
export const ResultChartTextPairSchema = z
  .object({ ja: ResultChartTextSchema, en: ResultChartTextSchema })
  .strict()
  .readonly();
export type ResultChartTextPair = z.infer<typeof ResultChartTextPairSchema>;

/**
 * One declared chart (ADR-0168 D2): `field` is the top-level property of the typed output that
 * holds the rows, `label` the key of each row's category and `value` the key of its number. The
 * title and both axis labels are bilingual; the axis labels also head the data table a screen
 * reader reads.
 */
export const ResultChartSchema = z
  .object({
    kind: ResultChartKindSchema,
    field: ResultChartKeySchema,
    label: ResultChartKeySchema,
    value: ResultChartKeySchema,
    title: ResultChartTextPairSchema,
    axes: z
      .object({ label: ResultChartTextPairSchema, value: ResultChartTextPairSchema })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
export type ResultChart = z.infer<typeof ResultChartSchema>;

/** A surface's `resultCharts`: 1–{@link RESULT_CHARTS_MAX} charts (ADR-0168 D2). */
export const ResultChartsSchema = z
  .array(ResultChartSchema)
  .min(1)
  .max(RESULT_CHARTS_MAX)
  .readonly();

/** One row a chart draws: its category as text and its finite number (ADR-0168 D3). */
export interface ResultChartPoint {
  readonly label: string;
  readonly value: number;
}

/**
 * What a chart reads from a run's typed output (ADR-0168 D3): the points, or why the output does
 * not fit the spec. A mismatch is reported, not drawn around, so a spec that names the wrong field
 * shows as such on the card instead of as an empty chart.
 */
export type ResultChartData =
  | { readonly kind: 'points'; readonly points: readonly ResultChartPoint[] }
  | {
      readonly kind: 'mismatch';
      readonly reason: 'no_field' | 'empty' | 'too_many_rows' | 'bad_row';
    };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One row as a point, or `null` when its label is not text or a number or its value not finite. */
function pointOf(row: unknown, chart: ResultChart): ResultChartPoint | null {
  if (!isRecord(row) || !Object.hasOwn(row, chart.label) || !Object.hasOwn(row, chart.value)) {
    return null;
  }
  const label = row[chart.label];
  const value = row[chart.value];
  if (typeof value !== 'number' || !(Math.abs(value) <= RESULT_CHART_VALUE_MAX)) return null;
  if (typeof label === 'string' && label.length > 0) return { label, value };
  if (typeof label === 'number' && Number.isFinite(label)) return { label: String(label), value };
  return null;
}

/**
 * Read `chart`'s rows from a run's typed output (ADR-0168 D3). Pure, so the control plane, a
 * customer's page and a test read a chart the same way.
 */
export function resultChartData(chart: ResultChart, structured: unknown): ResultChartData {
  if (!isRecord(structured) || !Object.hasOwn(structured, chart.field)) {
    return { kind: 'mismatch', reason: 'no_field' };
  }
  const rows = structured[chart.field];
  if (!Array.isArray(rows)) return { kind: 'mismatch', reason: 'no_field' };
  if (rows.length === 0) return { kind: 'mismatch', reason: 'empty' };
  if (rows.length > RESULT_CHART_POINTS_MAX) return { kind: 'mismatch', reason: 'too_many_rows' };
  const points: ResultChartPoint[] = [];
  for (const row of rows) {
    const point = pointOf(row, chart);
    if (point === null) return { kind: 'mismatch', reason: 'bad_row' };
    points.push(point);
  }
  return { kind: 'points', points };
}
