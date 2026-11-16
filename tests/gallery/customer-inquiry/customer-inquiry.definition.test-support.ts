import { SurfaceSessionRequestSchema } from '@indx-workspace/contracts/surfaces';
import {
  selectAllowedOperations,
  toolServerKey,
  TOOL_OPERATION_NAME_PATTERN,
} from '@indx-workspace/contracts/tool-connectors';
import { openapiTool, toolDefinitionsOf } from '@indx-workspace/sdk/define';
import { expect, it } from 'vitest';

import { findPii, maskPii } from './lib/pii.mjs';
import { crm as crmTool } from './tools/crm.ts';
import {
  approvalRulesOf,
  HANDOFF_PHRASE,
  operations,
  project,
} from './customer-inquiry.fixture.test-support.ts';

export function defineDefinitionCases(): void {
  it('the project and its embedded support widget pass the contract aw check applies', () => {
    const [agent] = project.agents;
    expect(project.agents).toHaveLength(1);
    const definition = agent?.body.definition;
    expect(definition?.agent.name).toBe('customer-inquiry');
    // readFiles is what offers `search_files`; the one granted folder is the FAQ.
    expect(definition?.agent.permissions).toStrictEqual({
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    });
    expect(definition?.resources).toMatchObject({
      connectors: ['crm'],
      skills: ['keigo-reply'],
      files: [{ path: 'faq', access: 'read' }],
    });
    expect(definition?.policy).toMatchObject({
      tools: {
        permissionMode: 'default',
        autoApprove: ['mcp__agent-workspace__search_files'],
      },
    });
    // The agent hands a customer to a person with the platform's tool, not with a phrase.
    expect(definition?.policy).toMatchObject({ handoff: true });
    const instructions = definition?.agent.instructions ?? '';
    expect(instructions).toContain('searchInteractions');
    expect(instructions).toContain('handoff_to_person');
    expect(instructions).toContain('search_files');
    // The hand-off is the first rule, with the eval's exact text.
    expect(instructions).toContain('担当者におつなぎします。少々お待ちください。');
    expect(instructions.indexOf('handoff_to_person')).toBeLessThan(instructions.indexOf('手順:'));
    expect(instructions).toContain('ログインの有無、FAQの記載、履歴の有無に関わらず');
    // Only the customer's own registered information is handed off; another customer's is refused.
    expect(instructions).toContain('ご自身のご登録情報');
    expect(instructions).toContain(
      '他のお客様の情報を求められたときはこの規則を使わず、開示できないことを丁寧にお断りする',
    );
    // No token and no customer id passes through the model.
    expect(instructions).not.toContain('token');
    expect(instructions).not.toContain('【顧客セッション】');
    expect(project.skills.map((skill) => skill.name)).toStrictEqual(['keigo-reply']);

    const [surface] = agent?.body.surfaces ?? [];
    expect(surface).toMatchObject({
      name: 'support',
      layout: 'dock',
      allowedOrigins: ['https://www.example.co.jp'],
      parts: { toolTrace: 'hidden', history: true, feedback: true },
    });
    expect(surface?.parts?.suggestedPrompts).toHaveLength(4);
    expect(project.project.policy).toMatchObject({
      permissions: { readFiles: true, writeFiles: false, runCommands: false },
      tools: ['crm'],
    });
  });

  it('the hosted widget cannot tell the agent who the visitor is', () => {
    // A widget session is opened by the browser with `POST /p/s/<name>/sessions`. The request is a
    // strict object with no field for a signed-in customer, so the host page cannot pass one.
    expect(SurfaceSessionRequestSchema.safeParse({}).success).toBe(true);
    for (const field of ['customerId', 'context', 'identity', 'metadata', 'user']) {
      expect(SurfaceSessionRequestSchema.safeParse({ [field]: 'C-1001' }).success).toBe(false);
    }
  });

  it('the eval file and the promotion bar are valid', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(7);
    // A handoff case is graded on the platform tool the backend routes on, not the phrase alone.
    const handoffs = cases.filter((entry) => entry.expect.contains?.includes(HANDOFF_PHRASE));
    expect(handoffs).toHaveLength(3);
    expect(
      cases.filter((entry) => entry.expect.tool === 'mcp__agent-workspace__handoff_to_person'),
    ).toStrictEqual(handoffs);
    expect(cases.some((entry) => entry.expect.notContains?.includes('返金いたします'))).toBe(true);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('the CRM tool admits exactly the two read operations; a write rule is selectable only as an approval-gated write', () => {
    const [agent] = project.agents;
    if (agent === undefined) throw new Error('the project has an agent');
    const [definition] = toolDefinitionsOf(agent.definition);
    expect(definition).toStrictEqual({
      kind: 'openapi',
      name: 'crm',
      spec: 'apis/crm.openapi.json',
      allow: ['GET /interactions/*'],
      auth: 'bearer',
      credential: { secret: 'CRM_TOKEN' },
      identity: { secret: 'CRM_IDENTITY_SECRET' },
    });

    // `*` is one segment: /interactions/search and /interactions/{id}. PUT /customers/me/address
    // is in the document but no rule admits it.
    const selected = selectAllowedOperations(crmTool.allow, operations);
    expect(selected.refusals).toStrictEqual([]);
    expect(selected.admitted.map((operation) => operation.operationId)).toStrictEqual([
      'searchInteractions',
      'getInteraction',
    ]);
    for (const operation of selected.admitted) {
      expect(operation.operationId).toMatch(TOOL_OPERATION_NAME_PATTERN);
      // No operation takes a customer id: whose history it reads is the signed identity.
      expect(operation.parameters.map((parameter) => parameter.name)).not.toContain('customerId');
    }
    expect(`mcp__${toolServerKey('crm')}__searchInteractions`).toBe('mcp__crm__searchInteractions');

    // openapiTool accepts a write rule, so the address stays unchangeable only because this tool's
    // own rules do not admit it.
    expect(crmTool.allow).toStrictEqual(['GET /interactions/*']);
    expect(selectAllowedOperations(['operationId:changeAddress'], operations)).toMatchObject({
      refusals: [],
      admitted: [{ operationId: 'changeAddress', method: 'PUT' }],
    });
    expect(
      openapiTool({
        name: 'crm',
        spec: 'apis/crm.openapi.json',
        allow: ['PUT /customers/me/address'],
      }).allow,
    ).toStrictEqual(['PUT /customers/me/address']);
    // #1536 lifted the connector's refusal of writes (ADR-0145): a rule naming one is selected, and
    // every selected write is gated by an approval rule, which no read gets.
    const withWrite = selectAllowedOperations(['operationId:changeAddress'], operations);
    expect(withWrite.refusals).toStrictEqual([]);
    expect(withWrite.admitted.map((operation) => operation.operationId)).toStrictEqual([
      'changeAddress',
    ]);
    expect(approvalRulesOf(withWrite.admitted)).toStrictEqual(['mcp__crm__changeAddress']);
    expect(approvalRulesOf(selected.admitted)).toStrictEqual([]);
  });

  it('the masker hides phone numbers, e-mail and addresses in any form and keeps the company number', () => {
    const text =
      '折り返し先 ０９０−４８２１−３３６７、自宅 03-5428-1190。新住所は神奈川県川崎市中原区小杉町3-264-2、' +
      '旧住所 〒530-0001 大阪府大阪市北区梅田1-8-17 梅田レジデンス1203号室、連絡は ken@example.ne.jp。' +
      '中原区小杉町3-264-2 宛。窓口は 0120-555-310。注文番号 MS-58213、追跡番号 4410-2231-8890、2026-03-02。';
    const masked = maskPii(text, { allow: ['0120-555-310'] });
    expect(masked).toBe(
      '折り返し先 ［電話番号］、自宅 ［電話番号］。新住所は［住所］、' +
        '旧住所 ［郵便番号］ ［住所］、連絡は ［メール］。' +
        '［住所］ 宛。窓口は 0120-555-310。注文番号 MS-58213、追跡番号 4410-2231-8890、2026-03-02。',
    );
    expect(findPii(masked, { allow: ['0120-555-310'] })).toStrictEqual([]);
    expect(maskPii('佐藤様 0904821336７', { known: ['佐藤'] })).toBe('［個人情報］様 ［電話番号］');
  });
}
