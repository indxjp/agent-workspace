/**
 * One chart a surface declares in `resultCharts` (ADR-0168), drawn from a run's typed output: the
 * control plane's run detail panel and a store page that shows a run's answer draw the same one.
 * It is inline SVG with no chart library. Its colours follow the page's `--accent`, `--muted`,
 * `--border` and `--surface` custom properties (the surface chat's and the console's palettes
 * both set them), and fall back to the text colour, so it needs no stylesheet. The picture is
 * hidden from assistive technology; the same rows are a visually hidden data table, headed by the
 * declared axis labels (ADR-0168 D4). Every value is a text node, so an output cannot inject markup.
 */
import {
  resultChartData,
  type ResultChart,
  type ResultChartData,
  type ResultChartPoint,
  type SurfaceLocale,
} from '@indx-workspace/contracts/surfaces';
import type { CSSProperties } from 'react';

type Mismatch = Extract<ResultChartData, { kind: 'mismatch' }>['reason'];

const MISMATCH: Readonly<Record<SurfaceLocale, Readonly<Record<Mismatch, string>>>> = {
  en: {
    no_field: 'The result has no list for this chart.',
    empty: 'The result’s list for this chart is empty.',
    too_many_rows: 'The result’s list is too long to chart.',
    bad_row: 'A row of the result has no label or number this chart can draw.',
  },
  ja: {
    no_field: '結果に、このグラフの一覧がありません。',
    empty: '結果の、このグラフの一覧が空です。',
    too_many_rows: '結果の一覧が長すぎて、グラフにできません。',
    bad_row: '結果のある行に、このグラフで描けるラベルか数値がありません。',
  },
};

/** The axis legend under the picture: the value axis, then the category axis. */
const AXES: Readonly<Record<SurfaceLocale, (value: string, label: string) => string>> = {
  en: (value, label) => `Vertical: ${value} · Horizontal: ${label}`,
  ja: (value, label) => `縦軸: ${value} ・ 横軸: ${label}`,
};

/** The drawing area, in SVG user units; the SVG scales to its container's width. */
const WIDTH = 560;
const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 64 } as const;
const PLOT_WIDTH = WIDTH - PAD.left - PAD.right;
const PLOT_HEIGHT = HEIGHT - PAD.top - PAD.bottom;

/** The most characters a category label shows on the picture; the table carries the whole text. */
export const RESULT_CHART_TICK_MAX_CHARACTERS = 14;

const MARK = 'var(--accent, currentColor)';
const MUTED = 'var(--muted, currentColor)';
const RULE = 'var(--border, currentColor)';
const SURFACE = 'var(--surface, transparent)';

/** Hidden on screen, read by a screen reader: the usual visually-hidden recipe. */
const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** Where each point lands: its band's centre, and the vertical position of a value. */
export interface ResultChartGeometry {
  readonly band: number;
  readonly low: number;
  readonly high: number;
  readonly x: (index: number) => number;
  readonly y: (value: number) => number;
}

/**
 * The scale of a chart: the value axis always spans 0, so a bar's length is its value; an output
 * whose values are all 0 gets the span 0–1 rather than a division by zero.
 */
export function resultChartGeometry(points: readonly ResultChartPoint[]): ResultChartGeometry {
  const values = points.map((point) => point.value);
  const low = Math.min(0, ...values);
  const spanHigh = Math.max(0, ...values);
  const high = spanHigh === low ? low + 1 : spanHigh;
  const band = PLOT_WIDTH / points.length;
  return {
    band,
    low,
    high,
    x: (index) => PAD.left + band * (index + 0.5),
    y: (value) => PAD.top + ((high - value) / (high - low)) * PLOT_HEIGHT,
  };
}

/** `text` cut to {@link RESULT_CHART_TICK_MAX_CHARACTERS} characters, an ellipsis marking a cut. */
function tick(text: string): string {
  const characters = Array.from(text);
  return characters.length <= RESULT_CHART_TICK_MAX_CHARACTERS
    ? text
    : `${characters.slice(0, RESULT_CHART_TICK_MAX_CHARACTERS - 1).join('')}…`;
}

interface MarksProps {
  readonly kind: ResultChart['kind'];
  readonly points: readonly ResultChartPoint[];
  readonly geometry: ResultChartGeometry;
  readonly format: (value: number) => string;
}

function Marks({ kind, points, geometry, format }: MarksProps) {
  const { band, x, y } = geometry;
  if (kind === 'bar') {
    const width = Math.max(2, band * 0.7);
    return points.map((point, index) => {
      const top = y(Math.max(point.value, 0));
      return (
        <rect
          key={index}
          data-mark="bar"
          x={x(index) - width / 2}
          y={top}
          width={width}
          height={Math.max(1, y(Math.min(point.value, 0)) - top)}
          rx={Math.min(4, width / 2)}
          style={{ fill: MARK }}
        >
          <title>{`${point.label}: ${format(point.value)}`}</title>
        </rect>
      );
    });
  }
  const path = points.map((point, index) => `${String(x(index))},${String(y(point.value))}`);
  return (
    <>
      <polyline
        points={path.join(' ')}
        fill="none"
        strokeWidth={2}
        strokeLinejoin="round"
        style={{ stroke: MARK }}
      />
      {points.map((point, index) => (
        <circle
          key={index}
          data-mark="point"
          cx={x(index)}
          cy={y(point.value)}
          r={4}
          strokeWidth={2}
          style={{ fill: MARK, stroke: SURFACE }}
        >
          <title>{`${point.label}: ${format(point.value)}`}</title>
        </circle>
      ))}
    </>
  );
}

/** A category label under the plot, cut to fit, its whole text in a tooltip. */
function Tick({
  label,
  x,
  anchor,
}: {
  label: string;
  x: number;
  anchor: 'start' | 'middle' | 'end';
}) {
  return (
    <text x={x} y={HEIGHT - PAD.bottom + 18} textAnchor={anchor}>
      <title>{label}</title>
      {tick(label)}
    </text>
  );
}

/** The first label starts at its band, the last ends at its band, and a lone one is centred. */
function tickAnchor(index: number, last: number): 'start' | 'middle' | 'end' {
  if (last === 0) return 'middle';
  return index === 0 ? 'start' : 'end';
}

/** The value axis's two ends and the first and last category, in muted text. */
function Axes({ points, geometry, format }: Omit<MarksProps, 'kind'>) {
  const { low, high, x, y } = geometry;
  const last = points.length - 1;
  return (
    <g style={{ fill: MUTED, fontSize: 11 }}>
      <line
        x1={PAD.left}
        x2={WIDTH - PAD.right}
        y1={y(0)}
        y2={y(0)}
        strokeWidth={1}
        style={{ stroke: RULE }}
      />
      <text x={PAD.left - 6} y={y(high)} textAnchor="end" dominantBaseline="middle">
        {format(high)}
      </text>
      <text x={PAD.left - 6} y={y(low)} textAnchor="end" dominantBaseline="middle">
        {format(low)}
      </text>
      {points.map((point, index) =>
        index === 0 || index === last ? (
          <Tick key={index} label={point.label} x={x(index)} anchor={tickAnchor(index, last)} />
        ) : null,
      )}
    </g>
  );
}

export interface ResultChartProps {
  /** One entry of the surface's `resultCharts`. */
  readonly chart: ResultChart;
  /** The run's `output.structured` (ADR-0143). */
  readonly structured: unknown;
  readonly locale: SurfaceLocale;
}

/** One declared chart over one run's typed output, or the reason the output does not fit it. */
export function ResultChart({ chart, structured, locale }: ResultChartProps) {
  const data = resultChartData(chart, structured);
  const title = chart.title[locale];
  const caption = <figcaption style={{ marginBottom: 8, fontWeight: 600 }}>{title}</figcaption>;
  if (data.kind === 'mismatch') {
    return (
      <figure className="aw-result-chart" style={{ margin: 0 }}>
        {caption}
        <p style={{ margin: 0, color: MUTED }}>{MISMATCH[locale][data.reason]}</p>
      </figure>
    );
  }
  const { points } = data;
  const number = new Intl.NumberFormat(locale);
  const format = (value: number) => number.format(value);
  const geometry = resultChartGeometry(points);
  return (
    <figure className="aw-result-chart" style={{ position: 'relative', margin: 0 }}>
      {caption}
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        aria-hidden="true"
        style={{ display: 'block', width: '100%', maxWidth: WIDTH, height: 'auto' }}
      >
        <Axes points={points} geometry={geometry} format={format} />
        <Marks kind={chart.kind} points={points} geometry={geometry} format={format} />
      </svg>
      <table style={VISUALLY_HIDDEN}>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{chart.axes.label[locale]}</th>
            <th scope="col">{chart.axes.value[locale]}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => (
            <tr key={index}>
              <th scope="row">{point.label}</th>
              <td>{format(point.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p aria-hidden="true" style={{ margin: '4px 0 0', fontSize: 12, color: MUTED }}>
        {AXES[locale](chart.axes.value[locale], chart.axes.label[locale])}
      </p>
    </figure>
  );
}
