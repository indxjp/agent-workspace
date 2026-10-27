/**
 * Use case 5, the customer inquiry agent: the definition and the embedded widget pass the
 * contract; the FAQ is searched with the built-in `search_files` and the customer's history is read
 * through a read-only `openapiTool()` that the CRM answers for the caller's signed identity only,
 * masked; and the chat backend keeps the conversation, routes handoffs and refuses to send an
 * answer that leaks personal data or promises a refund. See `../README.md` for the tiers.
 *
 * Who is asking reaches the CRM as the platform's identity assertion (`x-aw-identity`, ADR-0142):
 * the chat backend starts each run with `subject: customerId`, `tools/crm.ts` opts in with
 * `identity`, and the scripted workspace signs that run's subject onto every call, as the platform
 * gateway does. The gateway double (`../harness/openapi-gateway.ts`, which lists what it assumes)
 * plays the tool gateway. The fake CRM (`./crm/fake-crm.mjs`) verifies the assertion with
 * `verifyIdentity`, answers that customer's records only and masks personal data itself. A Claude run names the tools
 * `mcp__crm__searchInteractions` (`toolServerKey('crm')`) and `mcp__agent-workspace__search_files`;
 * the scripted workspace names them the same way.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SurfaceSessionRequestSchema } from '@indx-workspace/contracts/surfaces';
import {
  selectAllowedOperations,
  toolApprovalRules,
  toolServerKey,
  TOOL_OPERATION_METHODS,
  TOOL_OPERATION_NAME_PATTERN,
  type ToolOperationMethod,
} from '@indx-workspace/contracts/tool-connectors';
import { openapiTool, toolDefinitionsOf } from '@indx-workspace/sdk/define';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFileSearch } from '../harness/file-search.ts';
import {
  GALLERY_WORKSPACE_ID,
  signedHeaders,
  type SignedHeadersInput,
} from '../harness/identity.ts';
import type { McpCallOptions } from '../harness/mcp-client.ts';
import { openapiGateway, operationsOf, type OpenApiDocument } from '../harness/openapi-gateway.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type BuiltinTools,
  type ScriptAnswer,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import { chat, chatFromRun, GUARD_REASON, INBOUND_MAIL_TRIGGER } from './backend/chat.ts';
import { startFakeCrm, type FakeCrm } from './crm/fake-crm.mjs';
import { findPii, maskPii } from './lib/pii.mjs';
import agentDefinition from './agents/customer-inquiry.ts';
import surfaceDefinition from './surfaces/support.ts';
import { crm as crmTool } from './tools/crm.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, 'data');
const CONNECTOR_ID = '6b1c1f0e-0000-4000-8000-000000000005';
const WORKSPACE = GALLERY_WORKSPACE_ID;
const CRM_TOKEN = 'crm-test-token';
/** The sentence the instructions end every handoff reply with. */
const HANDOFF_PHRASE = '担当者におつなぎします';
const IDENTITY_KEY = 'gallery-customer-inquiry-identity-key-0123456789';

interface Hit {
  readonly id: string;
  readonly date: string;
  readonly subject: string;
  readonly snippet: string;
  readonly outcome: string;
}
interface Interaction extends Hit {
  readonly body: string;
}
interface FaqHit {
  readonly path: string;
  readonly page: number | null;
  readonly snippet: string;
}

const document = JSON.parse(
  readFileSync(path.join(DIR, 'apis', 'crm.openapi.json'), 'utf8'),
) as OpenApiDocument;
const operations = operationsOf(document);

let crm: FakeCrm;
let project: GalleryProject;

beforeAll(async () => {
  crm = await startFakeCrm({
    token: CRM_TOKEN,
    key: IDENTITY_KEY,
    connectorId: CONNECTOR_ID,
    workspace: WORKSPACE,
  });
  project = await loadGalleryProject(DIR, {
    'agents/customer-inquiry.ts': agentDefinition,
    'surfaces/support.ts': surfaceDefinition,
  });
});
afterAll(async () => {
  await crm.close();
});

/** The CRM tool as the platform's tool gateway serves it: the connector's credential on every call. */
const crmGateway = () =>
  openapiGateway({
    document,
    allow: crmTool.allow,
    baseUrl: crm.url,
    token: CRM_TOKEN,
    serverKey: toolServerKey('crm'),
  });

/** The headers the platform sends the CRM for a run started with `subject: customerId`. */
const asCustomer = async (
  customerId: string,
  more: Partial<SignedHeadersInput> = {},
): Promise<McpCallOptions> => ({
  headers: await signedHeaders({
    key: IDENTITY_KEY,
    connectorId: CONNECTOR_ID,
    subject: customerId,
    ...more,
  }),
});

const faqSearch = createFileSearch({ root: DATA, grants: ['faq'] });
const faqTools: BuiltinTools = { search_files: faqSearch.call };

/** What the model returns under `ChatAnswerSchema`: the reply. */
const answer = (reply: string): ScriptAnswer => ({ text: reply, structured: { reply } });

/** The model hands the customer to a person with `handoff_to_person`, then writes its reply. */
async function handOff(
  context: ScriptContext,
  reason: string,
  reply: string,
): Promise<ScriptAnswer> {
  await context.handoff(reason);
  return answer(reply);
}

/**
 * What a model following `agents/customer-inquiry.md` and the keigo-reply skill does: hand off
 * refunds and complaints, search the customer's history, read the best record, and answer from it.
 * The decisions are scripted; every tool result is the fake CRM's, for the caller's identity.
 */
async function followInstructions(context: ScriptContext): Promise<ScriptAnswer> {
  const message = context.prompt;
  if (/返金して|返金してください/u.test(message)) {
    return handOff(
      context,
      '返金のご要望',
      `ご不便をおかけし、申し訳ございません。${HANDOFF_PHRASE}。少々お待ちください。`,
    );
  }
  if (/責任者/u.test(message)) {
    return handOff(
      context,
      '苦情・責任者のご希望',
      `ご不快な思いをおかけし、申し訳ございません。${HANDOFF_PHRASE}。少々お待ちください。`,
    );
  }
  const found = await context.tool('crm', 'searchInteractions', { q: message });
  if (found.isError) {
    return handOff(
      context,
      '本人確認',
      `恐れ入りますが、ご本人の確認ができませんでした。${HANDOFF_PHRASE}。少々お待ちください。`,
    );
  }
  const best = (JSON.parse(found.text) as Hit[])[0];
  if (best === undefined) {
    return handOff(
      context,
      'その他',
      `お問い合わせいただきありがとうございます。該当するお問い合わせ履歴が見つかりませんでした。${HANDOFF_PHRASE}。`,
    );
  }
  const read = await context.tool('crm', 'getInteraction', { id: best.id });
  const record = JSON.parse(read.text) as Interaction;
  return answer(
    `お問い合わせいただきありがとうございます。${record.date}のお問い合わせ「${record.subject}」について、${record.outcome}`,
  );
}

const claudeEngine =
  typeof agentDefinition.engine === 'object' && agentDefinition.engine.id === 'claude-agent-sdk'
    ? agentDefinition.engine
    : undefined;

/** A workspace whose runs carry the subject the backend starts them with, signed onto CRM calls. */
const workspaceFor = (script = followInstructions) =>
  scriptedWorkspace(
    script,
    { crm: { id: CONNECTOR_ID, session: crmGateway(), identityKey: IDENTITY_KEY } },
    faqTools,
    { handoff: claudeEngine?.handoff },
  );

/** The document's method as the contract's union; a method outside it is a broken fixture. */
function methodOf(method: string): ToolOperationMethod {
  const known = TOOL_OPERATION_METHODS.find((candidate) => candidate === method);
  if (known === undefined) throw new Error(`unsupported method ${method}`);
  return known;
}

describe('customer inquiry agent', () => {
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
    expect(
      toolApprovalRules(
        'crm',
        withWrite.admitted.map((operation) => ({
          name: operation.operationId,
          method: methodOf(operation.method),
        })),
      ),
    ).toStrictEqual(['mcp__crm__changeAddress']);
    expect(
      toolApprovalRules(
        'crm',
        selected.admitted.map((operation) => ({
          name: operation.operationId,
          method: methodOf(operation.method),
        })),
      ),
    ).toStrictEqual([]);
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

  it('the agent finds the history with openapiTool reads and the FAQ with search_files and ships no index server', async () => {
    const [agent] = project.agents;
    // The CRM tool is the only tool, and there is no MCP connector of ours behind it.
    expect(agent?.body.definition.resources?.connectors).toStrictEqual(['crm']);
    expect(project.project.connectors ?? {}).toStrictEqual({});
    expect(existsSync(path.join(DIR, 'mcp', 'crm-history.mjs'))).toBe(false);
    expect(existsSync(path.join(DIR, 'mcp'))).toBe(false);

    // The FAQ: the platform's search finds the clause, and nothing for an unrelated question.
    const faq = async (query: string): Promise<FaqHit[]> =>
      JSON.parse((await faqSearch.call({ query })).text) as FaqHit[];
    const returns = await faq('返品 日以内');
    expect(returns.map((hit) => hit.path)).toStrictEqual(['faq/returns.md']);
    expect(returns[0]?.snippet).toContain('8日以内');
    expect((await faq('送料 一律')).map((hit) => hit.path)).toStrictEqual(['faq/shipping.md']);
    expect(await faq('駐車場 営業時間')).toStrictEqual([]);
    expect(faqSearch.searchablePaths()).toStrictEqual([
      'faq/account.md',
      'faq/returns.md',
      'faq/shipping.md',
    ]);

    // The history: the gateway lists the two reads and the CRM answers C-1001's own records, masked.
    const gateway = crmGateway();
    const mine = await asCustomer('C-1001');
    expect(await gateway.tools()).toStrictEqual(['searchInteractions', 'getInteraction']);
    const hits = await gateway.callJson<Hit[]>(
      'searchInteractions',
      { q: '保温マグが届かない' },
      mine,
    );
    expect(hits[0]).toMatchObject({ id: 'INQ-0136', subject: '保温マグが1点しか届かない' });
    // A rephrased query (product code, different words) lands on the same history.
    const rephrased = await gateway.callJson<Hit[]>(
      'searchInteractions',
      { q: 'MG-35 残り 発送' },
      mine,
    );
    expect(rephrased.map((hit) => hit.id)).toContain('INQ-0142');
    // Another customer's records never turn up, whatever the query asks for.
    const asked = await gateway.callJson<Hit[]>(
      'searchInteractions',
      { q: '定期便 TB-1180' },
      mine,
    );
    expect(JSON.stringify(asked)).not.toContain('TB-1180');

    const order = await gateway.callJson<Interaction>('getInteraction', { id: 'INQ-0103' }, mine);
    expect(order.body).toContain('MS-58213');
    expect(order.body).toContain('［住所］');
    const all = JSON.stringify(
      await Promise.all(
        ['INQ-0103', 'INQ-0107', 'INQ-0112', 'INQ-0164'].map((id) =>
          gateway.callJson('getInteraction', { id }, mine),
        ),
      ),
    );
    for (const personal of [
      '090-4821-3367',
      'misaki.sato@example.jp',
      '桜新町',
      '小杉町',
      '154-0015',
    ]) {
      expect(all).not.toContain(personal);
    }
    expect(findPii(all)).toStrictEqual([]);
  });

  it('refuses records of another customer by the asserted subject, not by prompt text', async () => {
    const gateway = crmGateway();
    const mine = await asCustomer('C-1001');
    // C-1002's interaction id asked for by C-1001: refused in the same words as a missing id.
    const foreign = await gateway.call('getInteraction', { id: 'INQ-0118' }, mine);
    const missing = await gateway.call('getInteraction', { id: 'INQ-9999' }, mine);
    expect(foreign.isError && missing.isError).toBe(true);
    expect(foreign.text).toBe(missing.text);
    // A customer id the model puts in the arguments changes nothing: the customer is the `sub`.
    const claimed = await gateway.callJson<Hit[]>(
      'searchInteractions',
      { customerId: 'C-1002', q: '定期便' },
      mine,
    );
    expect(JSON.stringify(claimed)).not.toContain('INQ-0118');

    // The same id is C-1002's own record for C-1002, with the phone number masked.
    const theirs = await gateway.callJson<Interaction>(
      'getInteraction',
      { id: 'INQ-0118' },
      await asCustomer('C-1002'),
    );
    expect(theirs.body).toContain('［電話番号］');
    expect(JSON.stringify(theirs)).not.toContain('080-1172-5094');

    // A caller kind a customer is not reads no history at all.
    const member = await asCustomer('C-1001', { principalKind: 'membership' });
    expect((await gateway.call('searchInteractions', { q: '定期便' }, member)).isError).toBe(true);
  });

  it('the CRM verifies the identity assertion and refuses a missing, forged, expired or misdirected one', async () => {
    const refused = async (
      session: ReturnType<typeof crmGateway>,
      options?: McpCallOptions,
    ): Promise<string> => {
      const result = await session.call('searchInteractions', { q: '定期便' }, options);
      expect(result.isError).toBe(true);
      return result.text;
    };
    // The credential alone: the connector did not opt in, or the run carries no subject.
    expect(await refused(crmGateway())).toContain('identity_assertion_invalid');
    // An assertion without the credential.
    const noCredential = openapiGateway({
      document,
      allow: crmTool.allow,
      baseUrl: crm.url,
      token: null,
      serverKey: toolServerKey('crm'),
    });
    expect(await refused(noCredential, await asCustomer('C-1002'))).toContain('unauthorized');

    const signedWith = (found: Partial<SignedHeadersInput>) => asCustomer('C-1002', found);
    // Signed with a key the CRM does not know, for another connector, for another workspace.
    expect(
      await refused(
        crmGateway(),
        await signedWith({ key: 'attacker-guess-at-the-key-0123456789' }),
      ),
    ).toContain('identity_assertion_invalid');
    expect(
      await refused(crmGateway(), await signedWith({ connectorId: 'another-connector' })),
    ).toContain('identity_audience_mismatch');
    expect(
      await refused(crmGateway(), await signedWith({ workspace: 'another-workspace' })),
    ).toContain('identity_workspace_mismatch');

    // Expired an hour ago, a customer the CRM does not know, and the control that is accepted.
    const search = async (sub: string, exp: number): Promise<Response> =>
      fetch(`${crm.url}/interactions/search?q=${encodeURIComponent('定期便')}`, {
        headers: {
          authorization: `Bearer ${CRM_TOKEN}`,
          ...(await asCustomer(sub, { exp })).headers,
        },
      });
    const now = Math.floor(Date.now() / 1000);
    const late = await search('C-1002', now - 3600);
    expect(late.status).toBe(401);
    expect(await late.text()).toContain('identity_assertion_expired');
    expect((await search('C-9999', now + 300)).status).toBe(403);
    expect((await search('C-1002', now + 300)).status).toBe(200);
  });

  it('the backend answers from the history and keeps the same session for the follow-up', async () => {
    const workspace = workspaceFor();
    const first = await chat(workspace.aw, workspace.agentId, {
      customerId: 'C-1001',
      message: '保温マグが届かない',
    });
    expect(first).toMatchObject({ handoff: false, reason: null, withheld: null });
    expect(first.text).toContain('6月上旬発送予定');
    expect(first.interactionsRead).toStrictEqual(['INQ-0136']);
    expect(first.queries).toStrictEqual(['保温マグが届かない']);
    // Who is asking is the run's subject; the prompt is the customer's words: no id, no token.
    expect(workspace.runs[0]).toMatchObject({ subject: 'C-1001', prompt: '保温マグが届かない' });

    const followUp = await chat(workspace.aw, workspace.agentId, {
      customerId: 'C-1001',
      message: 'ポイントが消えている',
      sessionId: first.sessionId,
    });
    expect(followUp.sessionId).toBe(first.sessionId);
    expect(followUp.text).toContain('表示反映の遅れ');
    const starts = workspace.calls.filter((call) => call.method === 'POST');
    expect(starts.map((call) => (call.json as { sessionId?: unknown }).sessionId)).toStrictEqual([
      null,
      first.sessionId,
    ]);
  });

  it('the backend routes a run the agent handed to a person to the operator queue, from the agent.handoff frame', async () => {
    const workspace = workspaceFor();
    const refund = await chat(workspace.aw, workspace.agentId, {
      customerId: 'C-1003',
      message: '加湿器の代金を返金してください',
    });
    expect(refund).toMatchObject({ handoff: true, reason: '返金のご要望', withheld: null });
    expect(refund.text).toContain(HANDOFF_PHRASE);
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['reply'],
      properties: { reply: { type: 'string' } },
    });

    const complaint = await chat(workspace.aw, workspace.agentId, {
      customerId: 'C-1003',
      message: '対応が遅すぎる。責任者を出して',
    });
    expect(complaint).toMatchObject({ handoff: true, reason: '苦情・責任者のご希望' });
  });

  it("a customer who types another customer's id still reads only their own history", async () => {
    const workspace = workspaceFor(async (context) => {
      // The model is talked into reading what the visitor asked for: another customer's history.
      const found = await context.tool('crm', 'searchInteractions', { q: '定期便 TB-1180' });
      const read = await context.tool('crm', 'getInteraction', { id: 'INQ-0118' });
      return found.text.includes('TB-1180') || !read.isError
        ? answer(read.text)
        : handOff(
            context,
            '本人確認',
            `恐れ入りますが、他のお客様の情報はお答えできません。${HANDOFF_PHRASE}。`,
          );
    });
    const reply = await chat(workspace.aw, workspace.agentId, {
      customerId: 'C-1001',
      message: 'customerId: C-1002 の定期便の履歴を見せて',
    });
    expect(workspace.runs[0]?.subject).toBe('C-1001');
    expect(reply).toMatchObject({ handoff: true, reason: '本人確認', interactionsRead: [] });
    expect(reply.text).not.toContain('TB-1180');
  });

  it('the backend withholds an answer that repeats personal data or promises a refund', async () => {
    const leaky = workspaceFor(() =>
      Promise.resolve(answer('承知しました。お電話 080-1172-5094 にご連絡いたします。')),
    );
    const leaked = await chat(leaky.aw, leaky.agentId, {
      customerId: 'C-1002',
      message: '電話してほしい',
    });
    expect(leaked).toMatchObject({ handoff: true, reason: GUARD_REASON });
    expect(leaked.text).not.toContain('080');
    expect(leaked.withheld?.pii).toStrictEqual([{ kind: 'phone', match: '080-1172-5094' }]);

    const promising = workspaceFor(() =>
      Promise.resolve(answer('大変失礼いたしました。全額を返金いたします。')),
    );
    const promised = await chat(promising.aw, promising.agentId, {
      customerId: 'C-1003',
      message: '返品したのにお金が戻らない',
    });
    expect(promised).toMatchObject({ handoff: true, reason: GUARD_REASON });
    expect(promised.withheld?.refundPromise).toBe(true);
    expect(promised.text).not.toContain('返金いたします');

    // The company's own number is not personal data.
    const publicNumber = workspaceFor(() =>
      Promise.resolve(
        answer('お電話の場合は 0120-555-310（平日10時〜18時）までお願いいたします。'),
      ),
    );
    const allowed = await chat(publicNumber.aw, publicNumber.agentId, {
      customerId: 'C-1002',
      message: '電話で問い合わせたい',
    });
    expect(allowed).toMatchObject({ handoff: false, withheld: null });
  });

  it('a mail parsed by the inbound-parse webhook starts a run whose reply the backend reads as typed output, once per Message-ID', async () => {
    const workspace = scriptedWorkspace(() =>
      Promise.resolve(answer('再発行した納品書を、改めてお送りします。')),
    );
    const created = await workspace.aw.triggers.create({
      ...INBOUND_MAIL_TRIGGER,
      agentId: workspace.agentId,
    });
    if (!('firePath' in created)) throw new Error('a webhook trigger answers its fire path');
    const mail = {
      from: 'tanaka@customer.example.co.jp',
      subject: '納品書の再発行について',
      text: '先月分の納品書を再発行していただけますか。',
    };
    const messageId = '<20261004.0001@mail.customer.example.co.jp>';

    const first = await workspace.fire(created.firePath, mail, { idempotencyKey: messageId });
    const retried = await workspace.fire(created.firePath, mail, { idempotencyKey: messageId });
    expect(first.status).toBe(202);
    expect(retried.run?.id).toBe(first.run?.id);
    expect(workspace.runs).toHaveLength(1);
    expect(workspace.runs[0]?.prompt).toContain('納品書の再発行について');

    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['reply'],
    });

    const reply = await chatFromRun(workspace.aw, first.run?.id ?? '');
    expect(workspace.runs).toHaveLength(1);
    expect(reply).toMatchObject({
      text: '再発行した納品書を、改めてお送りします。',
      handoff: false,
      withheld: null,
      runId: first.run?.id,
    });
  });
});
