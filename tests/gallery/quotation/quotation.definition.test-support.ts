import { canonicalCall } from '@indx-workspace/contracts/agents';
import {
  selectAllowedOperations,
  toolApprovalRules,
  toolServerKey,
  TOOL_OPERATION_NAME_PATTERN,
} from '@indx-workspace/contracts/tool-connectors';
import { toolDefinitionsOf } from '@indx-workspace/sdk/define';
import { expect, it } from 'vitest';

import { isToolMethod } from '../harness/openapi-gateway.ts';
import { draftQuote } from './backend/quote.ts';
import { erp as erpTool } from './tools/erp.ts';
import {
  asPerson,
  awaitingOf,
  erp,
  erpGateway,
  ERP_TOKEN,
  FOOD_REP,
  operations,
  project,
  quotationModel,
  requestFor,
  SALES_LEAD,
  SPECS,
  workspaceFor,
  type Order,
  type PartHit,
} from './quotation.fixture.test-support.ts';

export function defineDefinitionCases(): void {
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
    const elsewhere = await asPerson(SALES_LEAD, {
      connectorId: '6b1c1f0e-0000-4000-8000-0000000000ff',
    });
    expect((await gateway.call('getRate', { material: 'SS400' }, elsewhere)).text).toContain(
      'identity_audience_mismatch',
    );
  });
}
