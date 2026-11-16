/**
 * Use case 3, the quotation agent: the definition and its ERP tool pass the contract,
 * the cost model reproduces hand-computed prices, and the sales backend asks a person to approve a
 * booking only when its numbers are the cost model's. See `../README.md` for the tiers and what each proves.
 *
 * The ERP is an `openapiTool()`: in a real run the platform's tool gateway, not a server of ours,
 * turns each admitted operation into an MCP tool (`packages/gateway/src/tools/openapi.ts`). Here a
 * small gateway double (`../harness/openapi-gateway.ts`, which lists what it assumes) plays that part
 * against a loopback fake ERP. What it assumes,
 * read from the gateway and `apps/web/server/openapi/normalise.ts`: one tool per admitted
 * operation, named by its `operationId`; arguments are the operation's parameters by name; the
 * result is the upstream body as text, an error when the status is not 2xx; the credential is the
 * connector's, sent as `Authorization: Bearer`. A Claude run names the tools `mcp__erp__getRate`
 * (`toolServerKey('erp')`); the scripted workspace names them the same way, and the
 * backend matches by the `__<operation>` suffix.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolServerKey } from '@indx-workspace/contracts/tool-connectors';
import { afterAll, beforeAll } from 'vitest';
import { z } from 'zod';

import { GALLERY_WORKSPACE_ID, headersAs } from '../harness/identity.ts';
import { openapiGateway, operationsOf, type OpenApiDocument } from '../harness/openapi-gateway.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type BuiltinTools,
  type Script,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import {
  type BookedQuote,
  type QuoteAwaitingApproval,
  type QuoteOutcome,
  type QuoteRequest,
  type QuoteSpec,
} from './backend/quote.ts';
import { startFakeErp, type FakeErp } from './erp/fake-erp.mjs';
import { estimate, type RateTable } from './skills/cost-model/scripts/estimate.mjs';
import { erp as erpTool } from './tools/erp.ts';
import agentDefinition from './agents/quotation.ts';
import surfaceDefinition from './surfaces/quote-desk.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONNECTOR_ID = '6b1c1f0e-0000-4000-8000-000000000003';
const ERP_TOKEN = 'erp-test-token';
const IDENTITY_KEY = 'gallery-erp-secret-0123456789';
// Who is asking: both are in `data/erp/access.json`; the second sees 北陸フードシステム only.
const SALES_LEAD = '山田 浩';
const FOOD_REP = '佐野 敦';
const ESTIMATE_SCRIPT = path.join(DIR, 'skills', 'cost-model', 'scripts', 'estimate.mjs');

/** The last fenced json block in `text`, parsed: the spec in the prompt, the block the skill prints. */
function lastJsonBlock(text: string): unknown {
  const body = [...text.matchAll(/```json[^\S\n]*\n([\s\S]*?)\n```/gu)].at(-1)?.[1];
  return body === undefined ? undefined : (JSON.parse(body) as unknown);
}

const readJson = <T>(...segments: string[]): T =>
  JSON.parse(readFileSync(path.join(DIR, ...segments), 'utf8')) as T;
const SPECS = {
  bracket: readJson<QuoteSpec>('data', 'specs', 'bracket-ss400.json'),
  cover: readJson<QuoteSpec>('data', 'specs', 'cover-sus304.json'),
  plate: readJson<QuoteSpec>('data', 'specs', 'plate-a5052.json'),
};
const DRAWING_ID = 'a0000000-0000-4000-8000-000000000031';
/** What sales sends: the drawing as an uploaded file, and the customer and quantity it does not carry. */
const requestFor = (spec: QuoteSpec): QuoteRequest => ({
  drawing: { fileId: DRAWING_ID },
  customer: spec.customer,
  quantity: spec.quantity,
});
const RATES = readJson<Record<string, RateTable>>('data', 'erp', 'rates.json');

const document = readJson<OpenApiDocument>('apis', 'erp.openapi.json');
const operations = operationsOf(document);
const erpGateway = (
  baseUrl: string,
  token: string | null,
  approvedToolCalls: readonly string[] = [],
) =>
  openapiGateway({
    document,
    allow: erpTool.allow,
    baseUrl,
    token,
    serverKey: toolServerKey('erp'),
    approvedToolCalls,
  });

interface PartHit {
  readonly partNo: string;
  readonly material: string;
  readonly orderNos: readonly string[];
}
interface Order {
  readonly orderNo: string;
  readonly partName: string;
  readonly material: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly orderedOn: string;
}

const KINDS = ['ブラケット', 'カバー', 'プレート'];

/** The `createQuote` body the cost model gives for `spec`: what a faithful agent asks the ERP to book. */
const bookingOf = (spec: QuoteSpec): Record<string, unknown> => {
  const priced = estimate(spec, RATES[spec.material]);
  return {
    customer: spec.customer,
    drawingNo: spec.drawingNo,
    partName: spec.partName,
    material: spec.material,
    quantity: spec.quantity,
    unitPrice: priced.unitPrice,
    total: priced.total,
  };
};

/** `run_skill_script` as the platform runs it: the skill's script with the given arguments, no shell. */
const builtins: BuiltinTools = {
  run_skill_script: (args) => {
    const run = spawnSync(
      process.execPath,
      [ESTIMATE_SCRIPT, ...z.array(z.string()).parse(args['args'])],
      { encoding: 'utf8' },
    );
    return Promise.resolve({
      text: run.status === 0 ? run.stdout : run.stderr,
      isError: run.status !== 0,
    });
  },
};

/** What a test may change in what the agent read and is about to book, as a careless model would. */
interface Draft {
  spec: Record<string, unknown>;
  quote: Record<string, unknown>;
  cited: string[];
}

/** The typed answer the agent closes with, and the `createQuote` body it asked to book. */
interface Proposal {
  booking: Record<string, unknown>;
  readonly closing: { readonly text: string; readonly structured: unknown };
}

/** The past orders of parts like `spec` (by kind and material), at most three, of its material. */
async function readSimilarOrders(context: ScriptContext, spec: QuoteSpec): Promise<Order[]> {
  const q = KINDS.find((kind) => spec.partName.includes(kind)) ?? spec.partName;
  const hits = JSON.parse(
    (await context.tool('erp', 'searchParts', { q, material: spec.material })).text,
  ) as PartHit[];
  const orders: Order[] = [];
  for (const orderNo of hits.flatMap((hit) => hit.orderNos).slice(0, 3)) {
    const read = await context.tool('erp', 'getOrder', { orderNo });
    if (!read.isError) orders.push(JSON.parse(read.text) as Order);
  }
  return orders.filter((order) => order.material === spec.material);
}

/** What the agent read from the drawing and is about to book, before a test's `edit`. */
const draftOf = (drawn: QuoteSpec, spec: QuoteSpec, similar: readonly Order[]): Draft => ({
  spec: {
    drawingNo: drawn.drawingNo,
    partName: drawn.partName,
    material: drawn.material,
    lengthMm: drawn.lengthMm,
    widthMm: drawn.widthMm,
    thicknessMm: drawn.thicknessMm,
    holeCount: drawn.holeCount,
    holeDiameterMm: drawn.holeDiameterMm ?? 0,
    bendCount: drawn.bendCount,
  },
  quote: bookingOf(spec),
  cited: similar.map((order) => order.orderNo),
});

/** Read the rate and run the cost model through `run_skill_script` on the draft's spec. */
async function runCostModel(context: ScriptContext, draft: Draft, quantity: number): Promise<void> {
  const rate = await context.tool('erp', 'getRate', { material: String(draft.spec['material']) });
  await context.builtin('run_skill_script', {
    skill: 'cost-model',
    script: 'estimate.mjs',
    args: [
      'quote',
      '--spec',
      JSON.stringify({ ...draft.spec, quantity }),
      '--rate',
      rate.text,
      ...(draft.cited.length === 0 ? [] : ['--orders', draft.cited.join(',')]),
    ],
  });
}

/** The answer the agent closes with: the price, the orders it read, and the typed breakdown. */
function closingOf(spec: QuoteSpec, draft: Draft, similar: readonly Order[]): Proposal['closing'] {
  const references =
    similar.length === 0
      ? '類似実績なし'
      : similar
          .map(
            (o) =>
              `- ${o.orderNo} ${o.partName} ${String(o.quantity)}個 単価${String(o.unitPrice)}円（${o.orderedOn}）`,
          )
          .join('\n');
  const priced = estimate(spec, RATES[spec.material]);
  return {
    text: [
      `見積単価 ${priced.unitPrice.toLocaleString('ja-JP')}円（税抜）`,
      '',
      '参考にした類似実績:',
      references,
    ].join('\n'),
    structured: { spec: draft.spec, breakdown: priced, similarOrders: draft.cited },
  };
}

/**
 * The first run: read, price and book. `keep` gets the proposal before `createQuote`, which pauses
 * the run.
 */
async function draftAndBook(
  context: ScriptContext,
  drawn: QuoteSpec,
  edit: (draft: Draft) => void,
  keep: (proposal: Proposal) => void,
): Promise<Proposal['closing']> {
  const quantity = Number(/^数量: (\d+)個$/mu.exec(context.prompt)?.[1]);
  const spec: QuoteSpec = { ...drawn, quantity };
  const similar = await readSimilarOrders(context, spec);
  const draft = draftOf(drawn, spec, similar);
  edit(draft);
  await runCostModel(context, draft, quantity);
  const proposal: Proposal = { booking: draft.quote, closing: closingOf(spec, draft, similar) };
  keep(proposal);
  await context.tool('erp', 'createQuote', { body: proposal.booking });
  return proposal.closing;
}

/** The continuation after `approved`: the same call again, and the answer with the quote number. */
async function bookApproved(context: ScriptContext, proposal: Proposal) {
  const booked = await context.tool('erp', 'createQuote', { body: proposal.booking });
  const { quoteNo } = z.object({ quoteNo: z.string() }).parse(JSON.parse(booked.text));
  return {
    text: `${proposal.closing.text}\n見積番号 ${quoteNo}`,
    structured: proposal.closing.structured,
  };
}

/** The continuation after `rejected: <comment>`: book the revision (which pauses again), or stop. */
async function answerRejection(
  context: ScriptContext,
  proposal: Proposal,
  revise?: (quote: Record<string, unknown>, comment: string) => Record<string, unknown>,
) {
  const comment = /^rejected: (.*)$/su.exec(context.prompt)?.[1];
  if (revise !== undefined && comment !== undefined) {
    proposal.booking = revise(proposal.booking, comment);
    await context.tool('erp', 'createQuote', { body: proposal.booking });
  }
  return { text: '登録しませんでした。', structured: proposal.closing.structured };
}

/**
 * What a model following `agents/quotation.md` does with the attached drawing, whose content is
 * `drawn`: read its spec, search past parts by kind and material, read their orders, read the
 * rate, run the cost model through `run_skill_script`, then call `createQuote`, which pauses the
 * run. `edit` lets a test play a model that misreads the drawing or changes a number before it
 * books. On `approved` it makes the same call again and closes with its typed answer; on
 * `rejected: <comment>` it books `revise(quote, comment)` (which pauses again), or stops without
 * `revise`.
 */
function quotationModel(
  drawn: QuoteSpec,
  edit: (draft: Draft) => void = () => undefined,
  revise?: (quote: Record<string, unknown>, comment: string) => Record<string, unknown>,
): Script {
  let proposal: Proposal | null = null;
  return async (context) => {
    const current = proposal;
    if (current === null) {
      return draftAndBook(context, drawn, edit, (made) => {
        proposal = made;
      });
    }
    if (context.prompt === 'approved') return bookApproved(context, current);
    return answerRejection(context, current, revise);
  };
}

let erp: FakeErp;
let project: GalleryProject;

beforeAll(async () => {
  erp = await startFakeErp({
    token: ERP_TOKEN,
    identity: { key: IDENTITY_KEY, audience: CONNECTOR_ID, workspace: GALLERY_WORKSPACE_ID },
  });
  project = await loadGalleryProject(DIR, {
    'agents/quotation.ts': agentDefinition,
    'surfaces/quote-desk.ts': surfaceDefinition,
  });
});
afterAll(async () => {
  await erp.close();
});

/** The headers the platform sends the ERP for a run started with `subject`. */
const asPerson = headersAs({ key: IDENTITY_KEY, connectorId: CONNECTOR_ID });

const workspaceFor = (model: Script) =>
  scriptedWorkspace(
    model,
    {
      erp: { id: CONNECTOR_ID, session: erpGateway(erp.url, ERP_TOKEN), identityKey: IDENTITY_KEY },
    },
    builtins,
  );

/** The run paused on `createQuote`, or a failure that says why it did not. */
function awaitingOf(outcome: BookedQuote | QuoteOutcome): QuoteAwaitingApproval {
  if (outcome.status !== 'awaiting_approval') {
    throw new Error(`not paused: ${outcome.status}`);
  }
  return outcome;
}

export {
  ERP_TOKEN,
  SALES_LEAD,
  FOOD_REP,
  ESTIMATE_SCRIPT,
  lastJsonBlock,
  SPECS,
  DRAWING_ID,
  requestFor,
  RATES,
  operations,
  erpGateway,
  type PartHit,
  type Order,
  bookingOf,
  quotationModel,
  erp,
  project,
  asPerson,
  workspaceFor,
  awaitingOf,
};
