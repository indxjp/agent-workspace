/**
 * The sales system's backend call: ask the quotation agent to draft a quote and book it in the ERP,
 * and let a person approve the booking only when its numbers are the cost model's.
 *
 * Sales attaches the customer's drawing (a PDF or an image) and types only what a drawing does not
 * carry: the customer and the quantity. The agent reads the part's spec from the drawing, runs
 * `skills/cost-model/scripts/estimate.mjs` and calls the ERP's `createQuote`. That call is a write,
 * so the run pauses on it (ADR-0145) and nothing reaches the ERP until a person decides. A model can
 * still misread a dimension or edit a number on the way (a "friendly" discount, a typo, a rate it
 * remembered rather than read), so `draftQuote` checks the paused call before anyone is asked: the
 * spec and the cited orders come from the cost-model script call in this run, the rate is the one
 * the ERP returned in this run, and the backend runs the same script itself and refuses the call
 * when its customer, quantity, unit price or total differ. The approver sees the spec that was read
 * beside the price. The similar orders the agent cites count only when `getOrder` returned them in
 * this run, and the confidence is decided here by fixed rules, not by the model's own word.
 *
 * `decideQuote` carries the decision: `runs.approve` starts a continuation that books the approved
 * call for the same salesperson (the platform keeps the paused run's `subject`, ADR-0157) and
 * answers the ERP's quote number; `runs.reject` with a comment sends it back to the agent, and a
 * revised call pauses again.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { z } from 'zod';

import {
  pendingCall,
  readRun,
  runAndRead,
  RunAwaitingApproval,
  type AwaitingApproval,
  type ToolCall,
} from '../../shared/run-answer.ts';
import {
  estimate,
  EstimateError,
  readSpec,
  type Estimate,
  type PartSpec,
} from '../skills/cost-model/scripts/estimate.mjs';

/** What sales sends: the drawing as an uploaded file, and what the drawing does not say. */
export interface QuoteRequest {
  readonly drawing: { readonly fileId: string };
  readonly customer: string;
  readonly quantity: number;
}

/** The part as the agent read it from the drawing, plus the request's customer and quantity. */
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

/** The call the ERP books, as `createQuote` takes it (`apis/erp.openapi.json`, `NewQuote`). */
const NewQuoteSchema = z
  .object({
    customer: z.string(),
    drawingNo: z.string(),
    partName: z.string(),
    material: z.string(),
    quantity: z.number(),
    unitPrice: z.number(),
    total: z.number(),
  })
  .strict();
export type NewQuote = z.infer<typeof NewQuoteSchema>;

/** What a person is asked to approve: the call to book, with the checks the backend made. */
export interface ProposedQuote {
  /** The `createQuote` body the run paused on, validated here; nothing is booked until it is approved. */
  readonly quote: NewQuote;
  readonly spec: QuoteSpec;
  /** The cost model's breakdown, computed here; the call's amounts matched it. */
  readonly breakdown: Estimate;
  /** Cited orders `getOrder` returned in this run, of the spec's material. */
  readonly similarOrders: readonly PastOrder[];
  /** Cited order numbers that do not count: not read in this run, or another material. */
  readonly droppedOrders: readonly string[];
  readonly confidence: Confidence;
  readonly confidenceReasons: readonly string[];
}

/** The run paused on `createQuote`; decide it with {@link decideQuote}. */
export type QuoteAwaitingApproval = AwaitingApproval & { readonly proposed: ProposedQuote };

export interface BookedQuote {
  readonly status: 'booked';
  /** The ERP's number for the quote, read from the approved call's result. */
  readonly quoteNo: string;
  readonly quote: NewQuote;
  readonly answer: string;
  readonly runId: string;
  readonly sessionId: string;
}

export type RefusalCode =
  | 'invalid_spec'
  | 'rate_not_read'
  | 'not_priceable'
  | 'numbers_differ'
  | 'not_proposed'
  | 'not_booked';

export interface RefusedQuote {
  readonly status: 'refused';
  readonly code: RefusalCode;
  /** Why, for the person who reviews refusals; it names fields and numbers, never secrets. */
  readonly detail: string;
  readonly answer: string;
  readonly runId: string | null;
  readonly sessionId: string | null;
}

export type QuoteOutcome = QuoteAwaitingApproval | RefusedQuote;

/** The thresholds behind {@link confidenceOf}, as the cost-model skill states them. */
export const CONFIDENCE_RULES = { highOrders: 2, highDeviation: 0.15, mediumDeviation: 0.3 };

const toolIs = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The agent's closing answer, once the booking ran; the run asks for it, and the platform types it. */
export const QuoteAnswerSchema = z.object({
  spec: z
    .object({
      drawingNo: z.string().describe('図番（図面の表題欄）'),
      partName: z.string().describe('品名（図面の表題欄）'),
      material: z.string().describe('材質（SS400・SUS304・A5052）'),
      lengthMm: z.number().describe('外形の長さ（mm）'),
      widthMm: z.number().describe('外形の幅（mm）'),
      thicknessMm: z.number().describe('板厚（mm）'),
      holeCount: z.number().describe('穴の数。穴がなければ 0'),
      holeDiameterMm: z.number().describe('穴径（mm）。穴がなければ 0'),
      bendCount: z.number().describe('曲げの数。曲げがなければ 0'),
    })
    .describe('図面から読み取った部品仕様。読み取れない値を推測で埋めない'),
  breakdown: z
    .object({
      material: z.string().describe('材質（仕様の material）'),
      quantity: z.number().describe('数量'),
      perPiece: z.object({
        material: z.number().describe('1個あたりの材料費（円）'),
        cutting: z.number().describe('1個あたりの切断費（円）'),
        bending: z.number().describe('1個あたりの曲げ費（円）'),
        setup: z.number().describe('1個あたりの段取費（円）'),
        cost: z.number().describe('1個あたりの原価（円）'),
      }),
      unitPrice: z.number().describe('見積単価（円、税抜）'),
      total: z.number().describe('合計金額（円、税抜）'),
    })
    .describe('原価計算スクリプトの出力そのまま。数値を書き換えない'),
  similarOrders: z
    .array(z.string())
    .describe('参考にした類似実績の受注番号。getOrder で読んだものだけ'),
});

/** The results of the successful calls to `tool`: the ERP's JSON, which the backend reads as evidence. */
function succeeded(calls: readonly ToolCall[], tool: string): unknown[] {
  return calls
    .filter((call) => toolIs(call.name, tool) && !call.isError && call.output !== null)
    .map((call) => {
      try {
        return JSON.parse(call.output ?? '') as unknown;
      } catch {
        return undefined;
      }
    });
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
 * What the run's `run_skill_script` call fed the cost model: the spec and the cited orders. A run
 * with an attachment has no shell, so this call is the only way the script runs. The input is read,
 * not the output: the backend runs the script's function itself, and a refused call still shows
 * what the agent read.
 */
function scriptInputs(calls: readonly ToolCall[]): { spec: unknown; cited: string[] } | null {
  const call = calls.filter((candidate) => toolIs(candidate.name, 'run_skill_script')).at(-1);
  if (call === undefined || !isRecord(call.input)) return null;
  const parsed = z.array(z.string()).safeParse(call.input['args']);
  if (!parsed.success) return null;
  const args = parsed.data;
  const option = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
  };
  try {
    return {
      spec: JSON.parse(option('spec') ?? '') as unknown,
      cited: (option('orders') ?? '')
        .split(',')
        .map((order) => order.trim())
        .filter((order) => order !== ''),
    };
  } catch {
    return null;
  }
}

type Costed = Omit<ProposedQuote, 'quote' | 'spec'> & { readonly part: PartSpec };
interface Problem {
  readonly code: RefusalCode;
  readonly detail: string;
}

/**
 * Price the part the run read, from this run's evidence: the spec the cost-model script was given,
 * and the rate and orders the ERP returned. The backend runs the script's function itself.
 */
function costed(calls: readonly ToolCall[], quantity: number): Costed | Problem {
  const inputs = scriptInputs(calls);
  if (inputs === null) {
    return { code: 'not_priceable', detail: 'the run called no cost-model script with a spec' };
  }
  let part: PartSpec;
  try {
    part = readSpec({ ...(isRecord(inputs.spec) ? inputs.spec : {}), quantity });
  } catch (error) {
    if (!(error instanceof EstimateError)) throw error;
    return { code: 'invalid_spec', detail: error.message };
  }

  // The rate is the one the ERP returned in this run, never one the model wrote down.
  const rate = succeeded(calls, 'getRate')
    .filter((value) => isRecord(value) && value['material'] === part.material)
    .at(-1);
  if (rate === undefined) {
    return {
      code: 'rate_not_read',
      detail: `getRate returned no ${part.material} rate in this run`,
    };
  }
  let breakdown: Estimate;
  try {
    breakdown = estimate(part, rate);
  } catch (error) {
    if (!(error instanceof EstimateError)) throw error;
    return { code: 'not_priceable', detail: error.message };
  }

  const read = new Map(
    succeeded(calls, 'getOrder')
      .map(readOrder)
      .filter((order): order is PastOrder => order !== null)
      .map((order) => [order.orderNo, order]),
  );
  const similarOrders: PastOrder[] = [];
  const droppedOrders: string[] = [];
  for (const orderNo of new Set(inputs.cited)) {
    const order = read.get(orderNo);
    if (order?.material === part.material) similarOrders.push(order);
    else droppedOrders.push(orderNo);
  }
  const { confidence, reasons } = confidenceOf(breakdown.unitPrice, similarOrders);
  if (droppedOrders.length > 0) {
    reasons.push(`根拠にならない受注番号を除外: ${droppedOrders.join(', ')}`);
  }
  return { part, breakdown, similarOrders, droppedOrders, confidence, confidenceReasons: reasons };
}

/**
 * The paused `createQuote` call as a proposal. The canonical text is the platform's, but what the
 * model put in the body is untrusted until it parses and its customer, quantity and amounts are the
 * request's and the cost model's. A revision (`previous`) is checked against the numbers already
 * established for this quote, since its run read nothing new.
 */
function propose(
  pending: AwaitingApproval,
  request: Pick<QuoteRequest, 'customer' | 'quantity'>,
  previous: ProposedQuote | null,
): QuoteAwaitingApproval | RefusedQuote {
  const refuse = (code: RefusalCode, detail: string): RefusedQuote => ({
    status: 'refused',
    code,
    detail,
    answer: '',
    runId: pending.runId,
    sessionId: pending.sessionId,
  });
  if (!toolIs(pending.call.toolName, 'createQuote')) {
    return refuse('not_proposed', `the run paused on ${pending.call.toolName}, not createQuote`);
  }
  const body = z.object({ body: NewQuoteSchema }).safeParse(pendingCall(pending.call).input);
  if (!body.success) {
    return refuse('not_proposed', body.error.issues.map((issue) => issue.message).join('; '));
  }
  const quote = body.data.body;

  const basis = previous === null ? costed(pending.toolCalls, request.quantity) : previous;
  if ('code' in basis) return refuse(basis.code, basis.detail);
  const { breakdown } = basis;

  const differences = [
    ['customer', quote.customer, request.customer],
    ['material', quote.material, breakdown.material],
    ['quantity', quote.quantity, breakdown.quantity],
    ['unitPrice', quote.unitPrice, breakdown.unitPrice],
    ['total', quote.total, breakdown.total],
  ].flatMap(([field, actual, expected]) =>
    actual === expected
      ? []
      : [`${String(field)}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`],
  );
  if (differences.length > 0) {
    return refuse(
      'numbers_differ',
      `the call differs from the request and the cost model: ${differences.join('; ')}`,
    );
  }

  const part = 'part' in basis ? basis.part : basis.spec;
  return {
    ...pending,
    proposed: {
      quote,
      spec: {
        ...part,
        customer: quote.customer,
        drawingNo: quote.drawingNo,
        partName: quote.partName,
      },
      breakdown,
      similarOrders: basis.similarOrders,
      droppedOrders: basis.droppedOrders,
      confidence: basis.confidence,
      confidenceReasons: basis.confidenceReasons,
    },
  };
}

/**
 * Ask `agentId` to draft and book a quote of the attached drawing. The booking is a write, so the
 * run pauses on it and nothing is written: the answer is the pause with the {@link ProposedQuote}
 * a person approves, to be decided with {@link decideQuote}.
 *
 * Never throws for what the agent wrote: a call whose spec cannot be priced or whose numbers
 * cannot be confirmed comes back `refused` with a code, so the sales system can show why and ask
 * again. It throws only when the run itself fails (`RunDidNotComplete`, which includes a run that
 * cannot satisfy the output schema) or the API does.
 */
export async function draftQuote(
  aw: AgentWorkspaceClient,
  agentId: string,
  request: QuoteRequest,
  /** The signed-in salesperson, from the quote desk's own session; the ERP shows only their customers. */
  subject: string,
  sessionId?: string,
): Promise<QuoteOutcome> {
  // What sales typed is checked before a paid run starts, with the bounds `readSpec` applies.
  const typed =
    !Number.isSafeInteger(request.quantity) || request.quantity < 1 || request.quantity > 100000
      ? 'quantity must be an integer from 1 to 100000'
      : request.customer.trim() === ''
        ? 'customer must not be blank'
        : null;
  if (typed !== null) {
    return {
      status: 'refused',
      code: 'invalid_spec',
      detail: typed,
      answer: '',
      runId: null,
      sessionId: sessionId ?? null,
    };
  }

  try {
    const reading = await runAndRead(
      aw,
      agentId,
      {
        prompt: `顧客: ${request.customer}\n数量: ${String(request.quantity)}個\n添付の図面を読み、見積を作って ERP に登録してください。`,
        subject,
        attachments: [{ fileId: request.drawing.fileId }],
        sessionId: sessionId ?? null,
      },
      QuoteAnswerSchema,
    );
    return {
      status: 'refused',
      code: 'not_proposed',
      detail: 'the run finished without asking to book the quote',
      answer: reading.answer,
      runId: reading.run.id,
      sessionId: reading.run.sessionId,
    };
  } catch (error) {
    if (!(error instanceof RunAwaitingApproval)) throw error;
    return propose(error.pending, request, null);
  }
}

/**
 * A person decided the paused booking. Approving starts the continuation that makes the approved
 * call, and the result is the ERP's quote number read from that call's result, never assumed;
 * rejecting (with a comment saying what to change) starts one that revises the call, so the answer
 * is the next pause, checked again against the numbers already established.
 */
export async function decideQuote(
  aw: AgentWorkspaceClient,
  awaiting: QuoteAwaitingApproval,
  decision: { readonly approve: boolean; readonly comment?: string },
): Promise<BookedQuote | QuoteOutcome> {
  const input = decision.comment === undefined ? {} : { comment: decision.comment };
  const { run } = decision.approve
    ? await aw.runs.approve(awaiting.runId, input)
    : await aw.runs.reject(awaiting.runId, input);
  const { quote } = awaiting.proposed;
  try {
    const reading = await readRun(aw, run.id, QuoteAnswerSchema);
    const refuse = (code: RefusalCode, detail: string): RefusedQuote => ({
      status: 'refused',
      code,
      detail,
      answer: reading.answer,
      runId: reading.run.id,
      sessionId: reading.run.sessionId,
    });
    if (!decision.approve) return refuse('not_proposed', 'the agent proposed no revised booking');
    const quoteNo = succeeded(reading.toolCalls, 'createQuote')
      .map((result) => (isRecord(result) ? result['quoteNo'] : undefined))
      .find((value): value is string => typeof value === 'string');
    if (quoteNo === undefined) return refuse('not_booked', 'createQuote returned no quote number');
    return {
      status: 'booked',
      quoteNo,
      quote,
      answer: reading.answer,
      runId: reading.run.id,
      sessionId: reading.run.sessionId,
    };
  } catch (error) {
    if (!(error instanceof RunAwaitingApproval)) throw error;
    return propose(error.pending, quote, awaiting.proposed);
  }
}
