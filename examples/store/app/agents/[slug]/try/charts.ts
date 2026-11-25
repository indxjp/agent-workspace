/**
 * The result charts the Try it section draws under an answer (ADR-0168, unit G2b of the use-case
 * plan): those the entry's demo agent's surfaces declare, which `catalog/charts.generated.ts` holds
 * as data and which are parsed here with the contracts' schema before any is drawn. Pure, so
 * `tests/store/result-charts.test.ts` runs it.
 */
import {
  resultChartData,
  ResultChartsSchema,
  type ResultChart,
} from '@indx-workspace/contracts/surfaces';
import { z } from 'zod';

import { RESULT_CHARTS } from '../../../../catalog/charts.generated.ts';

const CHARTS = z.record(z.string(), ResultChartsSchema).parse(RESULT_CHARTS);

/**
 * The charts to draw for `slug`'s answer: those its typed output fits. A chart the output does not
 * fit is left out rather than drawn as the mismatch sentence, which speaks to the agent's developer
 * (the console's result card keeps it), not to a visitor.
 */
export function chartsFor(slug: string, structured: unknown): readonly ResultChart[] {
  return (CHARTS[slug] ?? []).filter(
    (chart) => resultChartData(chart, structured).kind === 'points',
  );
}
