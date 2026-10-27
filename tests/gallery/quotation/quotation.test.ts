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
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalCall } from '@indx-workspace/contracts/agents';
import {
  selectAllowedOperations,
  toolApprovalRules,
  toolServerKey,
  TOOL_OPERATION_NAME_PATTERN,
} from '@indx-workspace/contracts/tool-connectors';
import { toolDefinitionsOf } from '@indx-workspace/sdk/define';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { GALLERY_WORKSPACE_ID, signedHeaders } from '../harness/identity.ts';
import {
  isToolMethod,
  openapiGateway,
  operationsOf,
  type OpenApiDocument,
} from '../harness/openapi-gateway.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type BuiltinTools,
  type Script,
} from '../harness/scripted-workspace.ts';
import { RunDidNotComplete } from '../shared/run-answer.ts';
import {
  type BookedQuote,
  decideQuote,
  draftQuote,
  type QuoteAwaitingApproval,
  type QuoteOutcome,
  type QuoteRequest,
  type QuoteSpec,
} from './backend/quote.ts';
import { startFakeErp, type FakeErp } from './erp/fake-erp.mjs';
import { answerBlock, estimate, type RateTable } from './skills/cost-model/scripts/estimate.mjs';
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
  let booking: Record<string, unknown> | null = null;
  let closing: { text: string; structured: unknown } | null = null;
  return async (context) => {
    if (booking !== null && closing !== null) {
      if (context.prompt === 'approved') {
        const booked = await context.tool('erp', 'createQuote', { body: booking });
        const { quoteNo } = z.object({ quoteNo: z.string() }).parse(JSON.parse(booked.text));
        return { text: `${closing.text}\n見積番号 ${quoteNo}`, structured: closing.structured };
      }
      const comment = /^rejected: (.*)$/su.exec(context.prompt)?.[1];
      if (revise !== undefined && comment !== undefined) {
        booking = revise(booking, comment);
        await context.tool('erp', 'createQuote', { body: booking });
      }
      return { text: '登録しませんでした。', structured: closing.structured };
    }

    const quantity = Number(/^数量: (\d+)個$/mu.exec(context.prompt)?.[1]);
    const spec: QuoteSpec = { ...drawn, quantity };
    const q = KINDS.find((kind) => spec.partName.includes(kind)) ?? spec.partName;
    const hits = JSON.parse(
      (await context.tool('erp', 'searchParts', { q, material: spec.material })).text,
    ) as PartHit[];
    const orders: Order[] = [];
    for (const orderNo of hits.flatMap((hit) => hit.orderNos).slice(0, 3)) {
      const read = await context.tool('erp', 'getOrder', { orderNo });
      if (!read.isError) orders.push(JSON.parse(read.text) as Order);
    }
    const similar = orders.filter((order) => order.material === spec.material);
    const draft: Draft = {
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
    };
    edit(draft);
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
    closing = {
      text: [
        `見積単価 ${priced.unitPrice.toLocaleString('ja-JP')}円（税抜）`,
        '',
        '参考にした類似実績:',
        references,
      ].join('\n'),
      structured: { spec: draft.spec, breakdown: priced, similarOrders: draft.cited },
    };
    booking = draft.quote;
    await context.tool('erp', 'createQuote', { body: booking });
    return closing;
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
const asPerson = async (subject: string) => ({
  headers: await signedHeaders({ key: IDENTITY_KEY, connectorId: CONNECTOR_ID, subject }),
});

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

describe('quotation agent', () => {
  it('the project passes the contract aw check applies', () => {
    const [agent] = project.agents;
    expect(project.agents).toHaveLength(1);
    const definition = agent?.body.definition;
    expect(definition?.agent.permissions).toStrictEqual({
      readFiles: true,
      writeFiles: false,
      runCommands: true,
      unrestrictedNetwork: false,
    });
    expect(definition?.resources).toMatchObject({ connectors: ['erp'], skills: ['cost-model'] });
    expect(definition?.agent.instructions).toContain('getRate');
    // The cost-model script runs through run_skill_script (or Bash) and nobody can answer an
    // approval prompt in a run (issue #1021: the answer was the refusal), so the agent declares
    // both approved and the policy is stored by `aw push`; the mode stays 'default'.
    expect(definition?.policy).toMatchObject({
      tools: {
        permissionMode: 'default',
        autoApprove: ['Bash', 'mcp__agent-workspace__run_skill_script'],
      },
    });
    // The answer's numbers come from the script's own output, pasted unchanged, also when the
    // user asks for a discount.
    expect(definition?.agent.instructions).toContain('estimate.mjs quote');
    expect(definition?.agent.instructions).toContain('ブロックも省かずに貼り');
    expect(definition?.policySource).toBe('stored');
    expect(agent?.body.surfaces?.map((surface) => surface.name)).toStrictEqual(['quote-desk']);
    expect(agent?.body.surfaces).toMatchObject([{ parts: { attachments: true } }]);
    expect(project.skills.map((skill) => skill.name)).toStrictEqual(['cost-model']);
    expect(project.project.policy).toMatchObject({
      permissions: { writeFiles: false, runCommands: true },
      tools: ['erp'],
      promotion: { minEvalScore: 0.9 },
    });
    expect(project.project.connectors ?? {}).toStrictEqual({});
  });

  it('the eval file and the promotion bar are valid', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(4);
    expect(cases.some((entry) => entry.expect.notContains?.includes('"unitPrice": 400'))).toBe(
      true,
    );
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('the ERP tool admits the three read operations and the one write, createQuote', () => {
    const [definition] = toolDefinitionsOf(project.agents[0]!.definition);
    expect(definition).toStrictEqual({
      kind: 'openapi',
      name: 'erp',
      spec: 'apis/erp.openapi.json',
      allow: ['GET /parts/*', 'GET /orders/*', 'GET /rates/*', 'operationId:createQuote'],
      auth: 'bearer',
      credential: { secret: 'ERP_TOKEN' },
      identity: { secret: 'ERP_IDENTITY_SECRET' },
    });

    // `*` is one segment: /parts/search, /orders/{orderNo}, /rates/{material}. POST /quotes is
    // named by its operation id, so no glob can admit a second write by accident.
    const selected = selectAllowedOperations(erpTool.allow, operations);
    expect(selected.refusals).toStrictEqual([]);
    expect(selected.admitted.map((operation) => operation.operationId)).toStrictEqual([
      'searchParts',
      'getOrder',
      'getRate',
      'createQuote',
    ]);
    for (const operation of selected.admitted) {
      expect(operation.operationId).toMatch(TOOL_OPERATION_NAME_PATTERN);
    }
    expect(`mcp__${toolServerKey('erp')}__getRate`).toBe('mcp__erp__getRate');
    // Compose adds exactly this rule to `requireApproval`: the write, and no read.
    expect(
      toolApprovalRules(
        toolServerKey('erp'),
        selected.admitted.flatMap((operation) =>
          isToolMethod(operation.method)
            ? [{ name: operation.operationId, method: operation.method }]
            : [],
        ),
      ),
    ).toStrictEqual(['mcp__erp__createQuote']);
  });

  it('the agent books the quote in the ERP only after the call is approved', async () => {
    const body = {
      customer: '東和機工株式会社',
      drawingNo: 'TWK-M-2231 rev.B',
      partName: 'L形ブラケット',
      material: 'SS400',
      quantity: 50,
      unitPrice: 440,
      total: 22000,
    };
    const as = await asPerson(SALES_LEAD);
    const before = erp.requests.length;

    // Not approved: the gateway refuses and the ERP is never dialled.
    expect(await erpGateway(erp.url, ERP_TOKEN).call('createQuote', { body }, as)).toStrictEqual({
      text: 'approval_required',
      isError: true,
    });
    expect(erp.requests).toHaveLength(before);

    // Approved: the canonical call books exactly one quote, carrying the body.
    const approved = erpGateway(erp.url, ERP_TOKEN, [
      canonicalCall('mcp__erp__createQuote', { body }),
    ]);
    expect(
      (await approved.callJson<{ quoteNo: string }>('createQuote', { body }, as)).quoteNo,
    ).toBe('QT-0001');
    expect(erp.requests.slice(before)).toStrictEqual([
      { method: 'POST', path: '/api/v1/quotes', body, by: SALES_LEAD },
    ]);

    // An approval is for those arguments only: another price is another call.
    const changed = await approved.call('createQuote', { body: { ...body, unitPrice: 400 } }, as);
    expect(changed).toStrictEqual({ text: 'approval_required', isError: true });
    expect(erp.requests).toHaveLength(before + 1);
  });

  it('the fake ERP serves Japanese past orders and refuses a call without the credential', async () => {
    const gateway = erpGateway(erp.url, ERP_TOKEN);
    const as = await asPerson(SALES_LEAD);
    expect(await gateway.tools()).toStrictEqual([
      'searchParts',
      'getOrder',
      'getRate',
      'createQuote',
    ]);

    const brackets = await gateway.callJson<PartHit[]>(
      'searchParts',
      {
        q: 'ブラケット',
        material: 'SS400',
      },
      as,
    );
    expect(brackets.map((hit) => hit.partNo)).toStrictEqual(['P-10231', 'P-10388']);
    expect(
      await gateway.callJson<PartHit[]>('searchParts', { q: 'プレート', material: 'A5052' }, as),
    ).toStrictEqual([]);

    const order = await gateway.callJson<Order>('getOrder', { orderNo: 'SO-2024-0412' }, as);
    expect(order).toMatchObject({
      partName: 'モーター取付L形ブラケット',
      quantity: 50,
      unitPrice: 430,
    });
    expect((await gateway.call('getOrder', { orderNo: 'SO-1999-0001' }, as)).isError).toBe(true);
    expect((await gateway.call('getRate', { material: 'SPCC' }, as)).isError).toBe(true);
    expect((await gateway.call('deleteQuote', {}, as)).text).toContain('unknown tool');

    const anonymous = await erpGateway(erp.url, null).call('getRate', { material: 'SS400' });
    expect(anonymous).toStrictEqual({ text: '{"error":"unauthorized"}', isError: true });
  });

  it('refuses past orders of another customer by the asserted subject, not by prompt text', async () => {
    const gateway = erpGateway(erp.url, ERP_TOKEN);
    const lead = await asPerson(SALES_LEAD);
    const rep = await asPerson(FOOD_REP);
    // The brackets are 東和機工's and 中央精工's: the lead finds them, the food rep finds none.
    const search = { q: 'ブラケット', material: 'SS400' };
    expect(await gateway.callJson<PartHit[]>('searchParts', search, lead)).toHaveLength(2);
    expect(await gateway.callJson<PartHit[]>('searchParts', search, rep)).toStrictEqual([]);

    // Another customer's order gets the words of an order that does not exist.
    const foreign = await gateway.call('getOrder', { orderNo: 'SO-2024-0412' }, rep);
    const missing = await gateway.call('getOrder', { orderNo: 'SO-1999-0001' }, rep);
    expect(foreign.isError && missing.isError).toBe(true);
    expect(foreign.text).toBe(missing.text);
    expect((await gateway.call('getOrder', { orderNo: 'SO-2025-0533' }, rep)).isError).toBe(false);
    // The rates are the same for everyone.
    expect((await gateway.call('getRate', { material: 'SS400' }, rep)).isError).toBe(false);

    // The spec names 東和機工, the run's subject is the food rep, and the subject decides.
    const workspace = workspaceFor(quotationModel(SPECS.bracket));
    const { proposed } = awaitingOf(
      await draftQuote(workspace.aw, workspace.agentId, requestFor(SPECS.bracket), FOOD_REP),
    );
    expect(workspace.runs[0]?.subject).toBe(FOOD_REP);
    expect(proposed.similarOrders).toStrictEqual([]);
    expect(proposed.confidence).toBe('low');

    // No assertion, a wrong audience or a stranger: nothing is listed.
    const anonymous = await gateway.call('getRate', { material: 'SS400' });
    expect(anonymous.isError).toBe(true);
    expect(anonymous.text).toContain('identity_assertion_invalid');
    const stranger = await asPerson('someone else');
    expect((await gateway.call('getRate', { material: 'SS400' }, stranger)).text).toContain(
      'no access',
    );
    const elsewhere = {
      headers: await signedHeaders({
        key: IDENTITY_KEY,
        connectorId: '6b1c1f0e-0000-4000-8000-0000000000ff',
        subject: SALES_LEAD,
      }),
    };
    expect((await gateway.call('getRate', { material: 'SS400' }, elsewhere)).text).toContain(
      'identity_audience_mismatch',
    );
  });

  it('the cost model reproduces the hand-computed prices', () => {
    // SS400 200×100×3.2, 4×φ10, 2 bends, 50 pcs:
    //   64 cm³ × 7.85 = 0.5024 kg × ¥150 ÷ 0.8 = 94.2 → ¥94
    //   (600 + 4π·10 = 725.66 mm) 0.72566 m × ¥80 = 58.05 → ¥58;  2 × ¥40 = ¥80;  ¥6000 ÷ 50 = ¥120
    //   cost ¥352 × 1.25 = ¥440 → unit ¥440, total ¥22,000
    expect(estimate(SPECS.bracket, RATES['SS400'])).toMatchObject({
      perPiece: { material: 94, cutting: 58, bending: 80, setup: 120, cost: 352 },
      unitPrice: 440,
      total: 22000,
      basis: { massKg: 0.502, cuttingLengthM: 0.726, cuttingYenPerMeter: 80 },
    });
    // SUS304 300×150×2, 6×φ6, 4 bends, 30 pcs:
    //   90 cm³ × 7.93 = 0.7137 kg × ¥620 ÷ 0.75 = 589.99 → ¥590
    //   (900 + 6π·6 = 1013.10 mm) × ¥110/m = 111.44 → ¥111;  4 × ¥60 = ¥240;  ¥9000 ÷ 30 = ¥300
    //   cost ¥1,241 × 1.25 = 1551.25 → unit ¥1,560 (10円切り上げ), total ¥46,800
    expect(estimate(SPECS.cover, RATES['SUS304'])).toMatchObject({
      perPiece: { material: 590, cutting: 111, bending: 240, setup: 300, cost: 1241 },
      unitPrice: 1560,
      total: 46800,
    });
    // A5052 120×80×5, 4×φ5.5, no bend, 7 pcs (t5 takes the t6 cutting tier):
    //   48 cm³ × 2.68 = 0.12864 kg × ¥900 ÷ 0.8 = 144.72 → ¥145
    //   (400 + 4π·5.5 = 469.12 mm) × ¥100/m = 46.91 → ¥47;  ¥0;  ¥5000 ÷ 7 = 714.29 → ¥715 (切り上げ)
    //   cost ¥907 × 1.3 = 1179.1 → unit ¥1,180, total ¥8,260
    expect(estimate(SPECS.plate, RATES['A5052'])).toMatchObject({
      perPiece: { material: 145, cutting: 47, bending: 0, setup: 715, cost: 907 },
      unitPrice: 1180,
      total: 8260,
    });

    // Half up at exactly .5, despite floating point: 100×50×2.1 mm at 1 g/cm³ and ¥1000/kg is
    // 10.5 g → ¥10.5 → ¥11.
    const unitRate = {
      ...RATES['SS400'],
      densityGPerCm3: 1,
      pricePerKg: 1000,
      yield: 1,
    };
    const half = { ...SPECS.bracket, lengthMm: 100, widthMm: 50, thicknessMm: 2.1 };
    expect(estimate(half, unitRate).perPiece.material).toBe(11);
  });

  it('the cost model refuses what it cannot price, and its command line prints the breakdown', () => {
    expect(() => estimate({ ...SPECS.bracket, thicknessMm: 16 }, RATES['SS400'])).toThrow(
      /no cutting rate for SS400 t16/u,
    );
    expect(() => estimate(SPECS.bracket, RATES['SUS304'])).toThrow(/rate.material is SUS304/u);
    expect(() => estimate({ ...SPECS.bracket, holeDiameterMm: undefined }, RATES['SS400'])).toThrow(
      /holeDiameterMm/u,
    );
    expect(() => estimate({ ...SPECS.bracket, quantity: 0 }, RATES['SS400'])).toThrow(/quantity/u);

    const run = spawnSync(process.execPath, [ESTIMATE_SCRIPT], {
      input: JSON.stringify({ spec: SPECS.cover, rate: RATES['SUS304'] }),
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      unitPrice: 1560,
      total: 46800,
      taxIncluded: false,
    });

    const refused = spawnSync(process.execPath, [ESTIMATE_SCRIPT], {
      input: JSON.stringify({ spec: { ...SPECS.cover, material: 'SPCC' }, rate: RATES['SUS304'] }),
      encoding: 'utf8',
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('estimate refused: spec.material');
  });

  it('the quote command prints the answer block the eval strings are matched against', () => {
    const quote = (spec: unknown, rate: unknown, ...more: string[]): SpawnSyncReturns<string> =>
      spawnSync(
        process.execPath,
        [
          ESTIMATE_SCRIPT,
          'quote',
          '--spec',
          JSON.stringify(spec),
          '--rate',
          JSON.stringify(rate),
          ...more,
        ],
        { encoding: 'utf8' },
      );

    const none = quote(SPECS.plate, RATES['A5052']);
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('類似実績なし');
    expect(none.stdout).toContain('"unitPrice": 1180');
    expect(none.stdout).toBe(`${answerBlock(SPECS.plate, RATES['A5052'])}\n`);
    expect(lastJsonBlock(none.stdout)).toMatchObject({ similarOrders: [] });

    const orders = quote(SPECS.bracket, RATES['SS400'], '--orders', 'SO-2024-0412,SO-2025-0108');
    expect(orders.status).toBe(0);
    expect(orders.stdout).toContain('"unitPrice": 440');
    expect(orders.stdout).not.toContain('類似実績なし');
    expect(lastJsonBlock(orders.stdout)).toMatchObject({
      similarOrders: ['SO-2024-0412', 'SO-2025-0108'],
    });
    // A list written with spaces still names both orders.
    const spaced = quote(SPECS.bracket, RATES['SS400'], '--orders', 'SO-2024-0412, SO-2025-0108');
    expect(lastJsonBlock(spaced.stdout)).toMatchObject({
      similarOrders: ['SO-2024-0412', 'SO-2025-0108'],
    });

    const refused = quote({ ...SPECS.cover, material: 'SPCC' }, RATES['SUS304']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('estimate refused: spec.material');

    expect(
      spawnSync(process.execPath, [ESTIMATE_SCRIPT, 'quote'], { encoding: 'utf8' }).status,
    ).toBe(2);
  });

  it('draftQuote pauses on the checked createQuote and writes nothing; once approved the continuation books it for the asking salesperson', async () => {
    const workspace = workspaceFor(quotationModel(SPECS.bracket));
    const seen = erp.requests.length;
    const awaiting = awaitingOf(
      await draftQuote(workspace.aw, workspace.agentId, requestFor(SPECS.bracket), SALES_LEAD),
    );

    // The person is asked to approve the cost model's numbers beside the spec and the orders read.
    const { proposed } = awaiting;
    expect(proposed.quote).toStrictEqual(bookingOf(SPECS.bracket));
    expect(proposed.breakdown).toMatchObject({ unitPrice: 440, total: 22000 });
    expect(proposed.similarOrders.map((order) => [order.orderNo, order.unitPrice])).toStrictEqual([
      ['SO-2024-0412', 430],
      ['SO-2025-0108', 460],
      ['SO-2025-0377', 380],
    ]);
    expect(proposed.confidence).toBe('high');
    expect(proposed.confidenceReasons[0]).toContain('中央値 430円');
    expect(proposed.spec).toMatchObject({
      drawingNo: 'TWK-M-2231 rev.B',
      customer: '東和機工株式会社',
      quantity: 50,
    });
    // Before the approval the ERP saw reads only: booking waits for the approved createQuote.
    const drafted = erp.requests.slice(seen);
    expect(drafted.every((request) => request.method === 'GET')).toBe(true);
    expect(drafted.map((request) => request.path)).toContain(
      `/api/v1/parts/search?q=${encodeURIComponent('ブラケット')}&material=SS400`,
    );

    // Approve: the continuation, in the same session and for the same salesperson, books it.
    const booked = await decideQuote(workspace.aw, awaiting, { approve: true });
    if (booked.status !== 'booked') throw new Error(`the booking run ${booked.status}`);
    expect(booked.quoteNo).toMatch(/^QT-\d{4}$/u);
    expect(booked.answer).toContain('見積単価 440円');
    expect(booked.sessionId).toBe(awaiting.sessionId);
    expect(booked.runId).not.toBe(awaiting.runId);
    expect(erp.requests.slice(seen).filter((request) => request.method === 'POST')).toStrictEqual([
      { method: 'POST', path: '/api/v1/quotes', body: proposed.quote, by: SALES_LEAD },
    ]);
    expect(workspace.runs.map((run) => run.subject)).toStrictEqual([SALES_LEAD, SALES_LEAD]);

    // The approval is spent: a second decision is a 409, and nothing is booked twice.
    await expect(decideQuote(workspace.aw, awaiting, { approve: true })).rejects.toMatchObject({
      code: 'run_not_awaiting_approval',
    });
    expect(erp.requests.slice(seen).filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('a rejection with a comment sends the agent back and its revised createQuote pauses again, nothing booked', async () => {
    const workspace = workspaceFor(
      quotationModel(SPECS.bracket, undefined, (quote, comment) => ({
        ...quote,
        drawingNo: /図番は (.+?) です/u.exec(comment)?.[1] ?? quote['drawingNo'],
      })),
    );
    const seen = erp.requests.length;
    const first = awaitingOf(
      await draftQuote(workspace.aw, workspace.agentId, requestFor(SPECS.bracket), SALES_LEAD),
    );

    const revised = awaitingOf(
      await decideQuote(workspace.aw, first, {
        approve: false,
        comment: '図番は TWK-M-2231 rev.C です',
      }),
    );
    expect(revised.proposed.quote).toStrictEqual({
      ...first.proposed.quote,
      drawingNo: 'TWK-M-2231 rev.C',
    });
    expect(revised.proposed.breakdown).toStrictEqual(first.proposed.breakdown);
    expect(revised.runId).not.toBe(first.runId);
    expect(revised.sessionId).toBe(first.sessionId);
    expect(erp.requests.slice(seen).some((request) => request.method === 'POST')).toBe(false);

    // The revised call is the one the approval admits.
    const booked = await decideQuote(workspace.aw, revised, { approve: true });
    expect(booked).toMatchObject({ status: 'booked', quote: { drawingNo: 'TWK-M-2231 rev.C' } });
    expect(erp.requests.slice(seen).filter((request) => request.method === 'POST')).toMatchObject([
      { body: { drawingNo: 'TWK-M-2231 rev.C', unitPrice: 440, total: 22000 }, by: SALES_LEAD },
    ]);
  });

  it('a rejection the agent does not revise books nothing, and a revision to other numbers is refused', async () => {
    const seen = erp.requests.length;
    const stops = workspaceFor(quotationModel(SPECS.bracket));
    const stopped = awaitingOf(
      await draftQuote(stops.aw, stops.agentId, requestFor(SPECS.bracket), SALES_LEAD),
    );
    expect(await decideQuote(stops.aw, stopped, { approve: false })).toMatchObject({
      status: 'refused',
      code: 'not_proposed',
    });

    // Sent back for a typo, the agent also takes off 10%: the revision is checked against the cost model.
    const greedy = workspaceFor(
      quotationModel(SPECS.bracket, undefined, (quote) => ({
        ...quote,
        unitPrice: 400,
        total: 20000,
      })),
    );
    const paused = awaitingOf(
      await draftQuote(greedy.aw, greedy.agentId, requestFor(SPECS.bracket), SALES_LEAD),
    );
    const revised = await decideQuote(greedy.aw, paused, {
      approve: false,
      comment: '図番を直して',
    });
    expect(revised).toMatchObject({ status: 'refused', code: 'numbers_differ' });
    expect(revised.status === 'refused' ? revised.detail : '').toContain('unitPrice: 400 ≠ 440');

    expect(erp.requests.slice(seen).some((request) => request.method === 'POST')).toBe(false);
  });

  it('the drawing rides on the quote run as an attachment and the spec reaches the backend as the cost model input', async () => {
    const workspace = workspaceFor(quotationModel(SPECS.bracket));
    const { proposed } = awaitingOf(
      await draftQuote(workspace.aw, workspace.agentId, requestFor(SPECS.bracket), SALES_LEAD),
    );

    const [start] = workspace.calls
      .filter((call) => call.method === 'POST')
      .map((call) => call.json as { prompt: string; attachments?: unknown });
    expect(start?.attachments).toStrictEqual([{ fileId: DRAWING_ID }]);
    // The prompt carries what a drawing does not say, and no spec for the agent to copy.
    expect(start?.prompt).toContain('顧客: 東和機工株式会社');
    expect(start?.prompt).toContain('数量: 50個');
    expect(start?.prompt).not.toContain('```json');
    expect(start?.prompt).not.toContain('TWK-M-2231');
    // The spec in the proposal is the one the agent gave the cost-model script, with the request's
    // customer and quantity.
    expect(proposed.spec).toMatchObject({
      material: 'SS400',
      lengthMm: 200,
      widthMm: 100,
      thicknessMm: 3.2,
      holeCount: 4,
      holeDiameterMm: 10,
      bendCount: 2,
      quantity: 50,
    });
  });

  it('a drawing the agent cannot read into a priceable spec is refused', async () => {
    // The agent read a material the cost model does not price.
    const misread = workspaceFor(
      quotationModel(SPECS.bracket, (draft) => {
        draft.spec['material'] = 'SPCC';
      }),
    );
    const refused = await draftQuote(
      misread.aw,
      misread.agentId,
      requestFor(SPECS.bracket),
      SALES_LEAD,
    );
    expect(refused).toMatchObject({ status: 'refused', code: 'invalid_spec' });
    expect(refused.status === 'refused' ? refused.runId : null).not.toBeNull();
    expect(refused.status === 'refused' ? refused.detail : '').toContain('spec.material');
  });

  it('a request with a bad quantity or a blank customer starts no run', async () => {
    const neverRun = scriptedWorkspace(() => Promise.resolve(''));
    for (const request of [
      { ...requestFor(SPECS.bracket), quantity: 0 },
      { ...requestFor(SPECS.bracket), quantity: 1.5 },
      { ...requestFor(SPECS.bracket), quantity: Number.NaN },
      { ...requestFor(SPECS.bracket), quantity: 100001 },
      { ...requestFor(SPECS.bracket), customer: ' ' },
    ]) {
      expect(await draftQuote(neverRun.aw, neverRun.agentId, request, SALES_LEAD)).toMatchObject({
        status: 'refused',
        code: 'invalid_spec',
        runId: null,
      });
    }
    expect(neverRun.runs).toHaveLength(0);
  });

  it('the backend rates a single past order medium and no past order low', async () => {
    const first = workspaceFor(quotationModel(SPECS.cover));
    const cover = awaitingOf(
      await draftQuote(first.aw, first.agentId, requestFor(SPECS.cover), SALES_LEAD),
    ).proposed;
    expect(cover.breakdown.unitPrice).toBe(1560);
    expect(cover.similarOrders.map((order) => order.orderNo)).toStrictEqual(['SO-2025-0533']);
    expect(cover.confidence).toBe('medium');
    expect(cover.confidenceReasons).toContain('類似実績が1件のみ');

    const workspace = workspaceFor(quotationModel(SPECS.plate));
    const plate = awaitingOf(
      await draftQuote(workspace.aw, workspace.agentId, requestFor(SPECS.plate), SALES_LEAD),
    ).proposed;
    expect(plate.breakdown).toMatchObject({ unitPrice: 1180, total: 8260 });
    expect(plate.similarOrders).toStrictEqual([]);
    expect(plate.confidence).toBe('low');
  });

  it('the booking run asks for a typed answer and the backend refuses a createQuote whose numbers the cost model does not give', async () => {
    const seen = erp.requests.length;
    const workspace = workspaceFor(
      quotationModel(SPECS.bracket, (draft) => {
        // A "friendly" discount for a regular customer, written straight into the booking.
        draft.quote['unitPrice'] = 400;
        draft.quote['total'] = 20000;
      }),
    );
    const outcome = await draftQuote(
      workspace.aw,
      workspace.agentId,
      requestFor(SPECS.bracket),
      SALES_LEAD,
    );
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['spec', 'breakdown', 'similarOrders'],
      properties: { similarOrders: { type: 'array' } },
    });
    expect(outcome).toMatchObject({ status: 'refused', code: 'numbers_differ' });
    expect(outcome.status === 'refused' ? outcome.detail : '').toBe(
      'the call differs from the request and the cost model: unitPrice: 400 ≠ 440; total: 20000 ≠ 22000',
    );
    expect(erp.requests.slice(seen).some((request) => request.method === 'POST')).toBe(false);
  });

  it('the backend refuses numbers without an ERP rate and drops orders the agent never read', async () => {
    const noRate = workspaceFor(async (context) => {
      await context.builtin('run_skill_script', {
        skill: 'cost-model',
        script: 'estimate.mjs',
        args: ['quote', '--spec', JSON.stringify(SPECS.bracket)],
      });
      await context.tool('erp', 'createQuote', { body: bookingOf(SPECS.bracket) });
      return '';
    });
    expect(
      await draftQuote(noRate.aw, noRate.agentId, requestFor(SPECS.bracket), SALES_LEAD),
    ).toMatchObject({
      status: 'refused',
      code: 'rate_not_read',
    });

    const invented = workspaceFor(
      quotationModel(SPECS.cover, (draft) => {
        draft.cited.push('SO-2023-0001', 'SO-2025-0219');
      }),
    );
    const { proposed } = awaitingOf(
      await draftQuote(invented.aw, invented.agentId, requestFor(SPECS.cover), SALES_LEAD),
    );
    expect(proposed.droppedOrders).toStrictEqual(['SO-2023-0001', 'SO-2025-0219']);
    expect(proposed.similarOrders.map((order) => order.orderNo)).toStrictEqual(['SO-2025-0533']);

    // An answer without the typed shape is not a refusal the backend decides: the platform fails the
    // run, and the backend surfaces that.
    const unanswered = scriptedWorkspace(() => Promise.resolve('見積を作成しました。'));
    const failure: unknown = await draftQuote(
      unanswered.aw,
      unanswered.agentId,
      requestFor(SPECS.bracket),
      SALES_LEAD,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunDidNotComplete);
    expect(failure instanceof RunDidNotComplete ? failure.run : null).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/^output_schema_unsatisfied: /u) as unknown,
    });
  });
});
