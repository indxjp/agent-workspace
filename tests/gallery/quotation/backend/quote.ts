/**
 * The sales system's backend call: ask the quotation agent for a draft quote, and accept it only
 * when its numbers are the cost model's.
 *
 * The agent is told to run `skills/cost-model/scripts/estimate.mjs` and paste its output, but a
 * model can still edit a number on the way (a "friendly" discount, a typo, a rate it remembered
 * rather than read). So the backend takes the spec it sent and the rate the ERP returned during
 * this run, runs the same script itself, and refuses the draft when any amount differs. The
 * similar orders the agent cites count only when `getOrder` returned them in this run, and the
 * confidence is decided here by fixed rules, not by the model's own word.
 *
 * A draft that passes is `pending` approval: a run cannot pause for a person (probe
 * `run-approval`), and the agent cannot write to the ERP (probe `openapi-write`), so the approval
 * queue and the booking after it are this backend's.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import { runAndRead, type ToolCall } from '../../shared/run-answer.ts';
import {
  estimate,
  EstimateError,
  readSpec,
  type Estimate,
  type PartSpec,
} from '../skills/cost-model/scripts/estimate.mjs';

/** What sales enters from the customer's drawing. */
export interface QuoteSpec extends PartSpec {
  readonly customer: string;
  readonly drawingNo: string;
  readonly partName: string;
}

/** A past order as the ERP's `getOrder` returns it, read back from this run's tool results. */
export interface PastOrder {
  readonly orderNo: string;
  readonly partName: string;
  readonly material: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly orderedOn: string;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface DraftQuote {
  readonly status: 'draft';
  /** Always `pending`: a person approves before the quote is sent or booked. */
  readonly approval: 'pending';
  readonly spec: QuoteSpec;
  /** The cost model's breakdown, computed here; the agent's block matched it. */
  readonly breakdown: Estimate;
  /** Cited orders `getOrder` returned in this run, of the spec's material. */
  readonly similarOrders: readonly PastOrder[];
  /** Cited order numbers that do not count: not read in this run, or another material. */
  readonly droppedOrders: readonly string[];
  readonly confidence: Confidence;
  readonly confidenceReasons: readonly string[];
  readonly answer: string;
  readonly runId: string;
  readonly sessionId: string;
}

export type RefusalCode =
  'invalid_spec' | 'no_breakdown' | 'rate_not_read' | 'not_priceable' | 'numbers_differ';

export interface RefusedQuote {
  readonly status: 'refused';
  readonly code: RefusalCode;
  /** Why, for the person who reviews refusals; it names fields and numbers, never secrets. */
  readonly detail: string;
  readonly answer: string;
  readonly runId: string | null;
  readonly sessionId: string | null;
}

export type QuoteOutcome = DraftQuote | RefusedQuote;

/** The thresholds behind {@link confidenceOf}, as the cost-model skill states them. */
export const CONFIDENCE_RULES = { highOrders: 2, highDeviation: 0.15, mediumDeviation: 0.3 };

/** The amounts compared between the agent's block and the backend's own estimate. */
const COMPARED = [
  ['material'],
  ['quantity'],
  ['perPiece', 'material'],
  ['perPiece', 'cutting'],
  ['perPiece', 'bending'],
  ['perPiece', 'setup'],
  ['perPiece', 'cost'],
  ['unitPrice'],
  ['total'],
] as const;

const toolIs = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The prompt the backend sends: an instruction and the spec as a fenced JSON block. */
export function quotePrompt(spec: QuoteSpec): string {
  return `以下の部品仕様で見積の下書きを作ってください。\n\`\`\`json\n${JSON.stringify(spec)}\n\`\`\``;
}

/** The last fenced ```json block in `text`, parsed, or `undefined` when there is none. */
export function lastJsonBlock(text: string): unknown {
  const blocks = [...text.matchAll(/```json[^\S\n]*\n([\s\S]*?)\n```/gu)];
  const last = blocks.at(-1)?.[1];
  return last === undefined ? undefined : parseJson(last);
}

function succeeded(calls: readonly ToolCall[], tool: string): unknown[] {
  return calls
    .filter((call) => toolIs(call.name, tool) && !call.isError && call.output !== null)
    .map((call) => parseJson(call.output ?? ''));
}

function readOrder(value: unknown): PastOrder | null {
  if (!isRecord(value)) return null;
  const { orderNo, partName, material, quantity, unitPrice, orderedOn } = value;
  if (
    typeof orderNo !== 'string' ||
    typeof material !== 'string' ||
    typeof quantity !== 'number' ||
    typeof unitPrice !== 'number' ||
    !(unitPrice > 0)
  ) {
    return null;
  }
  return {
    orderNo,
    partName: typeof partName === 'string' ? partName : '',
    material,
    quantity,
    unitPrice,
    orderedOn: typeof orderedOn === 'string' ? orderedOn : '',
  };
}

function valueAt(record: unknown, keys: readonly string[]): unknown {
  let current = record;
  for (const key of keys) current = isRecord(current) ? current[key] : undefined;
  return current;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * The confidence rules: high with at least two similar orders and a unit price within 15% of
 * their median; medium with at least one and within 30%; low otherwise, and always low with none.
 */
export function confidenceOf(
  unitPrice: number,
  similar: readonly PastOrder[],
): { confidence: Confidence; reasons: string[] } {
  if (similar.length === 0) {
    return { confidence: 'low', reasons: ['類似実績なし: 実績単価と照合できない'] };
  }
  const reference = median(similar.map((order) => order.unitPrice));
  const deviation = Math.abs(unitPrice - reference) / reference;
  const percent = `${(deviation * 100).toFixed(1)}%`;
  const reasons = [
    `類似実績 ${String(similar.length)}件、実績単価の中央値 ${String(reference)}円との差 ${percent}`,
  ];
  if (
    similar.length >= CONFIDENCE_RULES.highOrders &&
    deviation <= CONFIDENCE_RULES.highDeviation
  ) {
    return { confidence: 'high', reasons };
  }
  if (deviation <= CONFIDENCE_RULES.mediumDeviation) {
    if (similar.length < CONFIDENCE_RULES.highOrders) reasons.push('類似実績が1件のみ');
    return { confidence: 'medium', reasons };
  }
  return { confidence: 'low', reasons: [...reasons, '実績単価との差が30%を超える'] };
}

/**
 * Ask `agentId` for a draft quote of `spec` and check it against the cost model.
 *
 * Never throws for what the agent wrote: a draft whose numbers cannot be confirmed comes back
 * `refused` with a code, so the sales system can show why and ask again. It throws only when the
 * run itself fails (`RunDidNotComplete`) or the API does.
 */
export async function draftQuote(
  aw: AgentWorkspaceClient,
  agentId: string,
  spec: QuoteSpec,
  sessionId?: string,
): Promise<QuoteOutcome> {
  try {
    readSpec(spec);
  } catch (error) {
    if (!(error instanceof EstimateError)) throw error;
    return {
      status: 'refused',
      code: 'invalid_spec',
      detail: error.message,
      answer: '',
      runId: null,
      sessionId: sessionId ?? null,
    };
  }

  const reading = await runAndRead(aw, agentId, {
    prompt: quotePrompt(spec),
    sessionId: sessionId ?? null,
  });
  const runId = reading.run.id;
  const refuse = (code: RefusalCode, detail: string): RefusedQuote => ({
    status: 'refused',
    code,
    detail,
    answer: reading.answer,
    runId,
    sessionId: reading.run.sessionId,
  });

  const block = lastJsonBlock(reading.answer);
  const claimed = isRecord(block) ? block['breakdown'] : undefined;
  const listed: unknown = isRecord(block) ? block['similarOrders'] : undefined;
  const cited = Array.isArray(listed)
    ? listed.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (!isRecord(claimed) || !Array.isArray(listed) || cited.length !== listed.length) {
    return refuse(
      'no_breakdown',
      'the answer has no ```json block with breakdown and similarOrders',
    );
  }

  // The rate is the one the ERP returned in this run, never one the model wrote down.
  const rate = succeeded(reading.toolCalls, 'getRate')
    .filter((value) => isRecord(value) && value['material'] === spec.material)
    .at(-1);
  if (rate === undefined) {
    return refuse('rate_not_read', `getRate returned no ${spec.material} rate in this run`);
  }

  let breakdown: Estimate;
  try {
    breakdown = estimate(spec, rate);
  } catch (error) {
    if (!(error instanceof EstimateError)) throw error;
    return refuse('not_priceable', error.message);
  }

  const differences = COMPARED.flatMap((keys) => {
    const expected = valueAt(breakdown, keys);
    const actual = valueAt(claimed, keys);
    return actual === expected
      ? []
      : [`${keys.join('.')}: ${JSON.stringify(actual) ?? 'missing'} ≠ ${JSON.stringify(expected)}`];
  });
  if (differences.length > 0) {
    return refuse(
      'numbers_differ',
      `the cost model gives other numbers: ${differences.join('; ')}`,
    );
  }

  const read = new Map(
    succeeded(reading.toolCalls, 'getOrder')
      .map(readOrder)
      .filter((order): order is PastOrder => order !== null)
      .map((order) => [order.orderNo, order]),
  );
  const similarOrders: PastOrder[] = [];
  const droppedOrders: string[] = [];
  for (const orderNo of new Set(cited)) {
    const order = read.get(orderNo);
    if (order?.material === spec.material) similarOrders.push(order);
    else droppedOrders.push(orderNo);
  }
  const { confidence, reasons } = confidenceOf(breakdown.unitPrice, similarOrders);
  if (droppedOrders.length > 0) {
    reasons.push(`根拠にならない受注番号を除外: ${droppedOrders.join(', ')}`);
  }

  return {
    status: 'draft',
    approval: 'pending',
    spec,
    breakdown,
    similarOrders,
    droppedOrders,
    confidence,
    confidenceReasons: reasons,
    answer: reading.answer,
    runId,
    sessionId: reading.run.sessionId,
  };
}
