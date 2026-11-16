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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  toolApprovalRules,
  toolServerKey,
  TOOL_OPERATION_METHODS,
  type ToolOperationMethod,
} from '@indx-workspace/contracts/tool-connectors';
import { afterAll, beforeAll } from 'vitest';

import { createFileSearch } from '../harness/file-search.ts';
import { GALLERY_WORKSPACE_ID, headersAs } from '../harness/identity.ts';
import type { McpCallOptions } from '../harness/mcp-client.ts';
import {
  openapiGateway,
  operationsOf,
  type OpenApiDocument,
  type OpenApiGatewaySession,
  type Operation,
} from '../harness/openapi-gateway.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type BuiltinTools,
  type ScriptAnswer,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import { startFakeCrm, type FakeCrm } from './crm/fake-crm.mjs';
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
const asCustomer = headersAs({ key: IDENTITY_KEY, connectorId: CONNECTOR_ID });

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

/** The approval rules the platform derives for the CRM tool's selected operations. */
const approvalRulesOf = (selected: readonly Pick<Operation, 'operationId' | 'method'>[]) =>
  toolApprovalRules(
    'crm',
    selected.map((operation) => ({
      name: operation.operationId,
      method: methodOf(operation.method),
    })),
  );

/** The FAQ as the platform's `search_files` answers `query`. */
const faq = async (query: string): Promise<FaqHit[]> =>
  JSON.parse((await faqSearch.call({ query })).text) as FaqHit[];

/** Every interaction in `ids` as the gateway reads it for `options`, as one JSON string. */
const readInteractions = async (
  gateway: OpenApiGatewaySession,
  ids: readonly string[],
  options: McpCallOptions,
): Promise<string> =>
  JSON.stringify(
    await Promise.all(ids.map((id) => gateway.callJson('getInteraction', { id }, options))),
  );

export {
  DIR,
  CRM_TOKEN,
  HANDOFF_PHRASE,
  document,
  operations,
  crm,
  project,
  crmGateway,
  asCustomer,
  faqSearch,
  answer,
  handOff,
  workspaceFor,
  approvalRulesOf,
  faq,
  readInteractions,
  type Hit,
  type Interaction,
};
