/**
 * The ringi review fixture: the authority server, the fake workflow system, the project, the
 * scripted reviewer and the desk a test files a ringi with. The cases are in the
 * `ringi-review.<concern>.test-support.ts` files next to this one.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolServerKey } from '@indx-workspace/contracts/tool-connectors';
import { afterAll, beforeAll } from 'vitest';

import { isGrantedPath } from '../../../apps/web/server/files/search-terms.ts';
import { createFileSearch } from '../harness/file-search.ts';
import { GALLERY_WORKSPACE_ID, headersAs } from '../harness/identity.ts';
import { startMcpServer, type McpSession } from '../harness/mcp-client.ts';
import { openapiGateway, type OpenApiDocument } from '../harness/openapi-gateway.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type BuiltinTools,
  type ScriptAnswer,
  type ScriptContext,
  type ScriptedWorkspace,
} from '../harness/scripted-workspace.ts';
import {
  startReview,
  type AccessList,
  type ReviewDependencies,
  type RingiSubmission,
} from './backend/review-run.ts';
import type { Finding } from './backend/review-sheet.ts';
import { parseAuthorityMatrix, type AuthorityMatrix } from './mcp/authority.mjs';
import agentDefinition from './agents/ringi-review.ts';
import surfaceDefinition from './surfaces/ringi-desk.ts';
import { workflow as workflowTool } from './tools/workflow.ts';
import { startFakeWorkflow, type FakeWorkflow } from './workflow/fake-workflow.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, 'data');
const CONNECTOR_ID = '6b1c1f0e-0000-4000-8000-000000000004';
// Who filed it: the first two are in `data/access.json` (the second may read 人事部's precedents
// only), the third is in no list.
const SUBMITTER = '山本 健';
const HR_CLERK = '高木 理恵';
const STRANGER = '佐藤 美咲';

interface Hit {
  readonly path: string;
  readonly page: number | null;
  readonly snippet: string;
}
interface RingiRecord {
  readonly id: string;
  readonly 件名: string;
  readonly 区分: string;
  readonly 結果: string;
  readonly 理由: string;
  readonly 出典: string;
}
interface Decision {
  readonly approver: string;
  readonly route: string;
  readonly coReview: string | null;
  readonly clause: string;
}

const GRANTS = ['rules', 'ringi'];
// The platform's own tools as a run has them: `search_files` covers only the run's `fileScope`, and
// so does what the sandbox holds for `Read`, so a file outside the scope does not exist for the run.
const builtins: BuiltinTools = {
  search_files: createFileSearch({ root: DATA, grants: GRANTS }).call,
  Read: async (args, run) => {
    const file = String(args['path']);
    return isGrantedPath(file, run.fileScope ?? GRANTS)
      ? { text: await readFile(path.join(DATA, file), 'utf8'), isError: false }
      : { text: `File does not exist: ${file}`, isError: true };
  },
};

const WORKFLOW_TOKEN = 'workflow-test-token';
const WORKFLOW_ID = '6b1c1f0e-0000-4000-8000-000000000014';
const WORKFLOW_KEY = 'gallery-workflow-api-secret-0123456789';

let authority: McpSession;
let workflowSystem: FakeWorkflow;
let project: GalleryProject;
let matrix: AuthorityMatrix;
let access: AccessList;

beforeAll(async () => {
  authority = await startMcpServer(path.join(DIR, 'mcp', 'authority-server.mjs'));
  workflowSystem = await startFakeWorkflow({
    token: WORKFLOW_TOKEN,
    identity: { key: WORKFLOW_KEY, audience: WORKFLOW_ID, workspace: GALLERY_WORKSPACE_ID },
  });
  project = await loadGalleryProject(DIR, {
    'agents/ringi-review.ts': agentDefinition,
    'surfaces/ringi-desk.ts': surfaceDefinition,
  });
  matrix = parseAuthorityMatrix(
    await readFile(path.join(DATA, 'rules', 'authority-matrix.md'), 'utf8'),
  );
  access = JSON.parse(await readFile(path.join(DATA, 'access.json'), 'utf8')) as AccessList;
});
afterAll(async () => {
  authority.close();
  await workflowSystem.close();
});

/** The headers the platform sends the workflow system for a run started with `subject`. */
const asPersonAtWorkflow = headersAs({ key: WORKFLOW_KEY, connectorId: WORKFLOW_ID });

let workflowDocument: OpenApiDocument | null = null;

/** The platform's gateway for the workflow tool, with the calls a person approved. */
async function workflowGateway(approvedToolCalls: readonly string[] = []) {
  workflowDocument ??= JSON.parse(
    await readFile(path.join(DIR, 'apis', 'workflow.openapi.json'), 'utf8'),
  ) as OpenApiDocument;
  return openapiGateway({
    document: workflowDocument,
    allow: workflowTool.allow,
    baseUrl: workflowSystem.url,
    token: WORKFLOW_TOKEN,
    serverKey: toolServerKey('workflow'),
    approvedToolCalls,
  });
}

const QUOTE_ID = 'a0000000-0000-4000-8000-000000000011';

/** A filed ringi as the workflow system sends it: over 3,000万円, one quote, no 期待効果. */
const CONVEYOR: RingiSubmission = {
  ringiId: 'R-2026-0101',
  revision: 1,
  title: '第3工場 搬送コンベヤの更新',
  category: '設備投資',
  amountYen: 45_000_000,
  department: '製造本部 第3製造部',
  submittedBy: SUBMITTER,
  applicant: '山本 健',
  purpose: '老朽化したコンベヤ（導入2008年）の更新',
  paymentTerms: '検収後翌月末',
  plannedDate: '2026-12-01',
  quotes: [{ fileId: QUOTE_ID }],
  inBudget: true,
};

/** The ringi in the prompt: the template's last line is the JSON body. */
const submitted = (prompt: string): RingiSubmission =>
  JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as RingiSubmission;

const REQUIRED_FIELDS = [
  ['applicant', '起案者'],
  ['purpose', '目的'],
  ['effect', '期待効果'],
  ['paymentTerms', '支払条件'],
  ['plannedDate', '実施予定日'],
] as const;

const inBrackets = (citation: string): string => citation.replace(/[〔〕]/gu, '');

interface ReviewerOptions {
  readonly misreadApprover?: string;
  readonly invent?: string;
  readonly inventInline?: string;
}

/** The comment arguments of the post run, kept so the continuation can make the same call. */
interface Posting {
  args: Record<string, unknown> | null;
}

/**
 * The post request (postReview) passes the given arguments to postComment unchanged; once
 * approved, the continuation makes the same call again; once rejected, it stops. Answers `null`
 * for a review prompt.
 */
async function postingReply(context: ScriptContext, posting: Posting): Promise<string | null> {
  const post = /```json\n([\s\S]*?)\n```/u.exec(context.prompt)?.[1];
  if (post !== undefined) {
    posting.args = JSON.parse(post) as Record<string, unknown>;
    await context.tool('workflow', 'postComment', posting.args);
    return '投稿しました。';
  }
  if (context.prompt === 'approved' && posting.args !== null) {
    await context.tool('workflow', 'postComment', posting.args);
    return '投稿しました。';
  }
  return context.prompt.startsWith('rejected') ? '投稿しませんでした。' : null;
}

const searchFiles = async (context: ScriptContext, query: string): Promise<Hit[]> =>
  JSON.parse((await context.builtin('search_files', { query })).text) as Hit[];

/** Find the clause with search_files, open the rule file, and copy the 出典 line of section `§`. */
async function readClause(context: ScriptContext, query: string, section: string): Promise<string> {
  const [hit] = (await searchFiles(context, query)).filter((entry) =>
    entry.path.startsWith('rules/'),
  );
  const { text } = await context.builtin('Read', { path: hit?.path ?? '' });
  const line = new RegExp(`^出典: (〔[^〕]*§${section}〕)$`, 'mu').exec(text);
  return line?.[1] ?? '';
}

async function omissionsOf(context: ScriptContext, ringi: RingiSubmission): Promise<Finding[]> {
  const omissions: Finding[] = [];
  const required = await readClause(context, '必須記載事項', '4.1');
  for (const [key, label] of REQUIRED_FIELDS) {
    if ((ringi[key] ?? '').trim() === '') {
      omissions.push({ text: `${label}が記載されていない。`, citations: [inBrackets(required)] });
    }
  }
  return omissions;
}

async function breachesOf(
  context: ScriptContext,
  ringi: RingiSubmission,
  options: ReviewerOptions,
): Promise<Finding[]> {
  const breaches: Finding[] = [];
  if (options.invent !== undefined) {
    breaches.push({ text: '上限に抵触するおそれがある。', citations: [options.invent] });
  }
  if (options.inventInline !== undefined) {
    breaches.push({
      text: `上限に抵触するおそれがある。〔${options.inventInline}〕`,
      citations: [],
    });
  }
  if (ringi.amountYen > 1_000_000 && ringi.quotes?.length === 1) {
    const quotes = await readClause(context, '相見積 見積書', '4.2');
    breaches.push({
      text: '100万円を超えるが見積が1社で、特命理由の記載がない。',
      citations: [inBrackets(quotes)],
    });
  }
  return breaches;
}

/**
 * The subject's essentials (「第3工場 搬送コンベヤの更新」 → 「工場 更新」), once; then open each
 * ringi file the search found and keep the records of the same category that renew.
 */
async function precedentsOf(context: ScriptContext, category: string): Promise<Finding[]> {
  const precedents: Finding[] = [];
  for (const hit of (await searchFiles(context, '工場 更新')).filter((entry) =>
    entry.path.startsWith('ringi/'),
  )) {
    const { text } = await context.builtin('Read', { path: hit.path });
    for (const record of JSON.parse(text) as RingiRecord[]) {
      if (record.区分 !== category || !record.件名.includes('更新')) continue;
      precedents.push({
        text: `${record.id}（${record.結果}）${record.件名}: 同じ区分の設備更新の先例。`,
        citations: [inBrackets(record.出典)],
      });
    }
  }
  return precedents;
}

/**
 * What a model following `agents/ringi-review.md` does: check the authority, read the clauses
 * that apply, look up precedents, and write the sheet in the skill's format. The decisions are
 * scripted; every tool result is the real server's. `misreadApprover` makes it write the approver
 * itself instead of copying `check_authority`, the mistake the backend must catch.
 */
function reviewer(options: ReviewerOptions = {}) {
  const posting: Posting = { args: null };
  return async (context: ScriptContext): Promise<ScriptAnswer> => {
    const reply = await postingReply(context, posting);
    if (reply !== null) return reply;
    const ringi = submitted(context.prompt);
    const { category, amountYen } = ringi;

    const decision = JSON.parse(
      (await context.tool('authority', 'check_authority', { category, amountYen })).text,
    ) as Decision;
    const omissions = await omissionsOf(context, ringi);
    const breaches = await breachesOf(context, ringi, options);
    const precedents = await precedentsOf(context, category);

    const sheet = {
      記載漏れ: omissions,
      規程との照合: breaches,
      決裁区分: {
        approver: options.misreadApprover ?? decision.approver,
        clause: inBrackets(decision.clause),
        coReview: decision.coReview,
      },
      類似案件: precedents,
      総合所見: '決裁者は、期待効果の記載と、見積が1社である理由を確認してください。',
    };
    return { text: JSON.stringify(sheet), structured: sheet };
  };
}

async function hook(
  script: ReturnType<typeof reviewer>,
  overrides: Partial<ReviewDependencies> = {},
): Promise<
  ReviewDependencies & {
    /** The workflow system filing a ringi: start its review. Answers the run id. */
    readonly file: (ringi?: RingiSubmission) => Promise<string>;
    readonly runs: () => number;
    readonly calls: ScriptedWorkspace['calls'];
    readonly outputSchemas: () => readonly unknown[];
    readonly subjects: () => readonly (string | null)[];
    readonly sessionIds: () => readonly string[];
    readonly fileScopes: () => readonly (readonly string[] | null)[];
  }
> {
  const workspace = scriptedWorkspace(
    script,
    {
      authority: { id: CONNECTOR_ID, session: authority },
      workflow: {
        id: WORKFLOW_ID,
        session: await workflowGateway(),
        identityKey: WORKFLOW_KEY,
      },
    },
    builtins,
  );
  const desk = {
    aw: workspace.aw,
    agentId: workspace.agentId,
    matrix,
    access,
    ...overrides,
    file: (ringi = CONVEYOR) => startReview(ringi, desk),
    runs: () => workspace.runs.length,
    calls: workspace.calls,
    outputSchemas: () => workspace.runs.map((run) => run.outputSchema),
    subjects: () => workspace.runs.map((run) => run.subject),
    sessionIds: () => workspace.runs.map((run) => run.sessionId),
    fileScopes: () => workspace.runs.map((run) => run.fileScope),
  };
  return desk;
}

export {
  DIR,
  DATA,
  CONNECTOR_ID,
  SUBMITTER,
  HR_CLERK,
  STRANGER,
  type Hit,
  type RingiRecord,
  type Decision,
  builtins,
  WORKFLOW_TOKEN,
  authority,
  workflowSystem,
  project,
  matrix,
  access,
  asPersonAtWorkflow,
  workflowGateway,
  QUOTE_ID,
  CONVEYOR,
  reviewer,
  hook,
};
