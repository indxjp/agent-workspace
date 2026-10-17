/**
 * Use case 3, the quotation agent: the definition and its read-only ERP tool pass the contract,
 * the cost model reproduces hand-computed prices, and the sales backend accepts a draft only when
 * its numbers are the cost model's. See `../README.md` for the tiers and what each proves.
 *
 * The ERP is an `openapiTool()`: in a real run the platform's tool gateway, not a server of ours,
 * turns each admitted operation into an MCP tool (`packages/gateway/src/tools/openapi.ts`). Here a
 * small gateway double (`erpGateway`) plays that part against a loopback fake ERP. What it assumes,
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

import {
  selectAllowedOperations,
  toolServerKey,
  TOOL_OPERATION_NAME_PATTERN,
} from '@indx-workspace/contracts/tool-connectors';
import {
  DefinitionError,
  openapiTool,
  secret,
  toolDefinitionsOf,
} from '@indx-workspace/sdk/define';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { McpSession, McpToolResult } from '../harness/mcp-client.ts';
import { PROBES } from '../harness/probes.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import { scriptedWorkspace, type ScriptContext } from '../harness/scripted-workspace.ts';
import { draftQuote, lastJsonBlock, type QuoteOutcome, type QuoteSpec } from './backend/quote.ts';
import { startFakeErp, type FakeErp } from './erp/fake-erp.mjs';
import { answerBlock, estimate, type RateTable } from './skills/cost-model/scripts/estimate.mjs';
import { erp as erpTool } from './tools/erp.ts';
import agentDefinition from './agents/quotation.ts';
import surfaceDefinition from './surfaces/quote-desk.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONNECTOR_ID = '6b1c1f0e-0000-4000-8000-000000000003';
const ERP_TOKEN = 'erp-test-token';
const ESTIMATE_SCRIPT = path.join(DIR, 'skills', 'cost-model', 'scripts', 'estimate.mjs');

const readJson = <T>(...segments: string[]): T =>
  JSON.parse(readFileSync(path.join(DIR, ...segments), 'utf8')) as T;
const SPECS = {
  bracket: readJson<QuoteSpec>('data', 'specs', 'bracket-ss400.json'),
  cover: readJson<QuoteSpec>('data', 'specs', 'cover-sus304.json'),
  plate: readJson<QuoteSpec>('data', 'specs', 'plate-a5052.json'),
};
const RATES = readJson<Record<string, RateTable>>('data', 'erp', 'rates.json');

interface Operation {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly parameters: readonly { readonly name: string; readonly in: string }[];
}
interface OpenApiDocument {
  readonly paths: Record<
    string,
    Record<string, { operationId: string; parameters?: Operation['parameters'] }>
  >;
}

const document = readJson<OpenApiDocument>('apis', 'erp.openapi.json');
const operations: Operation[] = Object.entries(document.paths).flatMap(([template, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({
    method: method.toUpperCase(),
    path: template,
    operationId: operation.operationId,
    parameters: operation.parameters ?? [],
  })),
);

/**
 * The tool gateway's part, as a session the scripted workspace can call: the operations the
 * `allow` rules admit, each called on `baseUrl` with the connector's credential.
 */
function erpGateway(baseUrl: string, token: string | null): McpSession {
  const admitted = selectAllowedOperations(erpTool.allow, operations).admitted;
  async function call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const operation = admitted.find((candidate) => candidate.operationId === name);
    if (operation === undefined)
      return { text: `unknown tool ${JSON.stringify(name)}`, isError: true };
    let route = operation.path;
    const query = new URLSearchParams();
    for (const parameter of operation.parameters) {
      const value = args[parameter.name];
      if (value === undefined) continue;
      if (typeof value !== 'string') {
        return { text: `invalid arguments: ${parameter.name} must be a string`, isError: true };
      }
      if (parameter.in === 'path')
        route = route.replace(`{${parameter.name}}`, encodeURIComponent(value));
      else query.set(parameter.name, value);
    }
    const search = query.size === 0 ? '' : `?${query.toString()}`;
    const response = await fetch(`${baseUrl}${route}${search}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    return { text: await response.text(), isError: !response.ok };
  }
  return {
    tools: () => Promise.resolve(admitted.map((operation) => operation.operationId)),
    call,
    callJson: async <T = unknown>(name: string, args: Record<string, unknown>): Promise<T> => {
      const result = await call(name, args);
      if (result.isError) throw new Error(`${name} refused: ${result.text}`);
      return JSON.parse(result.text) as T;
    },
    close: () => undefined,
  };
}

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

/**
 * What a model following `agents/quotation.md` does: search past parts by kind and material, read
 * their orders, read the rate, run the cost model and answer with the skill's JSON block. `edit`
 * lets a test play a model that changes the script's output before pasting it.
 */
function quotationModel(
  edit: (block: { breakdown: Record<string, unknown>; similarOrders: string[] }) => void = () =>
    undefined,
) {
  return async (context: ScriptContext): Promise<string> => {
    const spec = lastJsonBlock(context.prompt) as QuoteSpec;
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
    const rate: unknown = JSON.parse(
      (await context.tool('erp', 'getRate', { material: spec.material })).text,
    );
    // The Bash call that runs the skill script is not an MCP tool, so the scripted stream does
    // not show it; the model's "run" is the same function the script's command line calls.
    const breakdown = estimate(spec, rate) as unknown as Record<string, unknown>;
    const block = {
      breakdown: structuredClone(breakdown),
      similarOrders: similar.map((o) => o.orderNo),
    };
    edit(block);
    const references =
      similar.length === 0
        ? '類似実績なし'
        : similar
            .map(
              (o) =>
                `- ${o.orderNo} ${o.partName} ${String(o.quantity)}個 単価${String(o.unitPrice)}円（${o.orderedOn}）`,
            )
            .join('\n');
    const unitPrice = Number(block.breakdown['unitPrice']);
    return [
      `見積単価 ${unitPrice.toLocaleString('ja-JP')}円（税抜）`,
      '',
      '参考にした類似実績:',
      references,
      '',
      '```json',
      JSON.stringify(block, null, 2),
      '```',
    ].join('\n');
  };
}

let erp: FakeErp;
let project: GalleryProject;

beforeAll(async () => {
  erp = await startFakeErp({ token: ERP_TOKEN });
  project = await loadGalleryProject(DIR, {
    'agents/quotation.ts': agentDefinition,
    'surfaces/quote-desk.ts': surfaceDefinition,
  });
});
afterAll(async () => {
  await erp.close();
});

const workspaceFor = (model: ReturnType<typeof quotationModel>) =>
  scriptedWorkspace(model, {
    erp: { id: CONNECTOR_ID, session: erpGateway(erp.url, ERP_TOKEN) },
  });

function draftOf(outcome: QuoteOutcome) {
  if (outcome.status !== 'draft') throw new Error(`refused ${outcome.code}: ${outcome.detail}`);
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

  it('the ERP tool admits exactly the three read operations and refuses a write rule', () => {
    const [definition] = toolDefinitionsOf(project.agents[0]!.definition);
    expect(definition).toStrictEqual({
      kind: 'openapi',
      name: 'erp',
      spec: 'apis/erp.openapi.json',
      allow: ['GET /parts/*', 'GET /orders/*', 'GET /rates/*'],
      auth: 'bearer',
      credential: { secret: 'ERP_TOKEN' },
    });

    // `*` is one segment: /parts/search, /orders/{orderNo}, /rates/{material}. POST /quotes is
    // in the document but no rule admits it.
    const selected = selectAllowedOperations(erpTool.allow, operations);
    expect(selected.refusals).toStrictEqual([]);
    expect(selected.admitted.map((operation) => operation.operationId)).toStrictEqual([
      'searchParts',
      'getOrder',
      'getRate',
    ]);
    for (const operation of selected.admitted) {
      expect(operation.operationId).toMatch(TOOL_OPERATION_NAME_PATTERN);
    }
    expect(`mcp__${toolServerKey('erp')}__getRate`).toBe('mcp__erp__getRate');

    // A write is refused where the tool is defined, by rule or by operation id (probe
    // openapi-write keeps the gallery honest the day this changes).
    expect(() =>
      openapiTool({
        name: 'erp',
        spec: 'apis/erp.openapi.json',
        auth: secret('ERP_TOKEN'),
        allow: ['POST /quotes'],
      }),
    ).toThrow(DefinitionError);
    expect(selectAllowedOperations(['operationId:createQuote'], operations).refusals).toMatchObject(
      [{ code: 'connector_write_unsupported' }],
    );
    expect(PROBES['openapi-write'].present()).toBe(false);
  });

  it('the fake ERP serves Japanese past orders and refuses a call without the credential', async () => {
    const gateway = erpGateway(erp.url, ERP_TOKEN);
    expect(await gateway.tools()).toStrictEqual(['searchParts', 'getOrder', 'getRate']);

    const brackets = await gateway.callJson<PartHit[]>('searchParts', {
      q: 'ブラケット',
      material: 'SS400',
    });
    expect(brackets.map((hit) => hit.partNo)).toStrictEqual(['P-10231', 'P-10388']);
    expect(
      await gateway.callJson<PartHit[]>('searchParts', { q: 'プレート', material: 'A5052' }),
    ).toStrictEqual([]);

    const order = await gateway.callJson<Order>('getOrder', { orderNo: 'SO-2024-0412' });
    expect(order).toMatchObject({
      partName: 'モーター取付L形ブラケット',
      quantity: 50,
      unitPrice: 430,
    });
    expect((await gateway.call('getOrder', { orderNo: 'SO-1999-0001' })).isError).toBe(true);
    expect((await gateway.call('getRate', { material: 'SPCC' })).isError).toBe(true);
    expect((await gateway.call('createQuote', {})).text).toContain('unknown tool');

    const anonymous = await erpGateway(erp.url, null).call('getRate', { material: 'SS400' });
    expect(anonymous).toStrictEqual({ text: '{"error":"unauthorized"}', isError: true });
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

  it('the backend returns a draft with the cost model breakdown, the past orders it read and a high confidence', async () => {
    const workspace = workspaceFor(quotationModel());
    const quote = draftOf(await draftQuote(workspace.aw, workspace.agentId, SPECS.bracket));

    expect(quote.approval).toBe('pending');
    expect(quote.breakdown).toMatchObject({ unitPrice: 440, total: 22000 });
    expect(quote.similarOrders.map((order) => [order.orderNo, order.unitPrice])).toStrictEqual([
      ['SO-2024-0412', 430],
      ['SO-2025-0108', 460],
      ['SO-2025-0377', 380],
    ]);
    expect(quote.confidence).toBe('high');
    expect(quote.confidenceReasons[0]).toContain('中央値 430円');
    expect(quote.answer).toContain('見積単価 440円');
    expect(workspace.runs[0]?.prompt).toContain('"drawingNo":"TWK-M-2231 rev.B"');
    // Every ERP call carried the connector's credential and was a read.
    expect(erp.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(erp.requests.map((request) => request.path)).toContain(
      `/api/v1/parts/search?q=${encodeURIComponent('ブラケット')}&material=SS400`,
    );
  });

  it('the backend rates a single past order medium and no past order low', async () => {
    const first = workspaceFor(quotationModel());
    const cover = draftOf(await draftQuote(first.aw, first.agentId, SPECS.cover));
    expect(cover.breakdown.unitPrice).toBe(1560);
    expect(cover.similarOrders.map((order) => order.orderNo)).toStrictEqual(['SO-2025-0533']);
    expect(cover.confidence).toBe('medium');
    expect(cover.confidenceReasons).toContain('類似実績が1件のみ');

    const workspace = workspaceFor(quotationModel());
    const plate = draftOf(await draftQuote(workspace.aw, workspace.agentId, SPECS.plate));
    expect(plate.breakdown).toMatchObject({ unitPrice: 1180, total: 8260 });
    expect(plate.similarOrders).toStrictEqual([]);
    expect(plate.confidence).toBe('low');
    expect(plate.answer).toContain('類似実績なし');
  });

  it('the backend refuses a draft whose numbers differ from the cost model', async () => {
    const workspace = workspaceFor(
      quotationModel((block) => {
        // A "friendly" discount for a regular customer, written straight into the block.
        block.breakdown['unitPrice'] = 400;
        block.breakdown['total'] = 20000;
      }),
    );
    const outcome = await draftQuote(workspace.aw, workspace.agentId, SPECS.bracket);
    expect(outcome).toMatchObject({ status: 'refused', code: 'numbers_differ' });
    expect(outcome.status === 'refused' ? outcome.detail : '').toBe(
      'the cost model gives other numbers: unitPrice: 400 ≠ 440; total: 20000 ≠ 22000',
    );
  });

  it('the backend refuses numbers without an ERP rate and drops orders the agent never read', async () => {
    const noRate = scriptedWorkspace(
      () =>
        Promise.resolve(
          '単価は 440円 です。\n```json\n' +
            JSON.stringify({
              breakdown: estimate(SPECS.bracket, RATES['SS400']),
              similarOrders: [],
            }) +
            '\n```',
        ),
      { erp: { id: CONNECTOR_ID, session: erpGateway(erp.url, ERP_TOKEN) } },
    );
    expect(await draftQuote(noRate.aw, noRate.agentId, SPECS.bracket)).toMatchObject({
      status: 'refused',
      code: 'rate_not_read',
    });

    const invented = workspaceFor(
      quotationModel((block) => {
        block.similarOrders.push('SO-2023-0001', 'SO-2025-0219');
      }),
    );
    const quote = draftOf(await draftQuote(invented.aw, invented.agentId, SPECS.cover));
    expect(quote.droppedOrders).toStrictEqual(['SO-2023-0001', 'SO-2025-0219']);
    expect(quote.similarOrders.map((order) => order.orderNo)).toStrictEqual(['SO-2025-0533']);

    const unanswered = scriptedWorkspace(() => Promise.resolve('見積を作成しました。'));
    expect(await draftQuote(unanswered.aw, unanswered.agentId, SPECS.bracket)).toMatchObject({
      status: 'refused',
      code: 'no_breakdown',
    });

    const neverRun = scriptedWorkspace(() => Promise.resolve(''));
    expect(
      await draftQuote(neverRun.aw, neverRun.agentId, {
        ...SPECS.bracket,
        material: 'SPCC',
      } as unknown as QuoteSpec),
    ).toMatchObject({ status: 'refused', code: 'invalid_spec', runId: null });
    expect(neverRun.runs).toHaveLength(0);
  });
});
