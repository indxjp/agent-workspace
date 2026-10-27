/**
 * Use case 4, the ringi review agent: the definition passes the contract and can comment but not
 * decide, the rules and past ringi are found with the built-in `search_files` (narrowed per filer by
 * the backend's `fileScope`), the authority server applies the matrix deterministically, the
 * backend starts one typed review per ringi revision for the filer and re-checks it (決裁区分,
 * missing fields, citations), and a second run posts exactly that checked comment through an
 * `openapiTool` call, which pauses the run until a person approves it. The workflow system verifies
 * who is asking (ADR-0142) and refuses a comment on another department's ringi. See `../README.md`
 * for the three tiers and what each proves.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalCall } from '@indx-workspace/contracts/agents';
import {
  selectAllowedOperations,
  toolApprovalRules,
  toolServerKey,
} from '@indx-workspace/contracts/tool-connectors';
import { toolDefinitionsOf } from '@indx-workspace/sdk/define';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isGrantedPath } from '../../../apps/web/server/files/search-terms.ts';
import { createFileSearch } from '../harness/file-search.ts';
import { GALLERY_WORKSPACE_ID, signedHeaders } from '../harness/identity.ts';
import { startMcpServer, type McpSession } from '../harness/mcp-client.ts';
import { openapiGateway, operationsOf, type OpenApiDocument } from '../harness/openapi-gateway.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type BuiltinTools,
  type ScriptAnswer,
  type ScriptContext,
  type ScriptedWorkspace,
} from '../harness/scripted-workspace.ts';
import { readRun } from '../shared/run-answer.ts';
import {
  fileScopeFor,
  decidePost,
  postReview,
  reviewRun,
  RINGI_TRIGGER,
  startReview,
  type AccessList,
  type ReviewDependencies,
  type RingiSubmission,
} from './backend/review-run.ts';
import { ReviewSheetSchema, type Finding } from './backend/review-sheet.ts';
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
const asPersonAtWorkflow = async (subject: string) => ({
  headers: await signedHeaders({ key: WORKFLOW_KEY, connectorId: WORKFLOW_ID, subject }),
});

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

/**
 * What a model following `agents/ringi-review.md` does: check the authority, read the clauses
 * that apply, look up precedents, and write the sheet in the skill's format. The decisions are
 * scripted; every tool result is the real server's. `misreadApprover` makes it write the approver
 * itself instead of copying `check_authority`, the mistake the backend must catch.
 */
const inBrackets = (citation: string): string => citation.replace(/[〔〕]/gu, '');

function reviewer(
  options: {
    readonly misreadApprover?: string;
    readonly invent?: string;
    readonly inventInline?: string;
  } = {},
) {
  let posting: Record<string, unknown> | null = null;
  return async (context: ScriptContext): Promise<ScriptAnswer> => {
    // The post request (postReview): pass the given arguments to postComment unchanged.
    const post = /```json\n([\s\S]*?)\n```/u.exec(context.prompt)?.[1];
    if (post !== undefined) {
      posting = JSON.parse(post) as Record<string, unknown>;
      await context.tool('workflow', 'postComment', posting);
      return '投稿しました。';
    }
    // The continuation of a decision: once approved, make the same call again; once rejected, stop.
    if (context.prompt === 'approved' && posting !== null) {
      await context.tool('workflow', 'postComment', posting);
      return '投稿しました。';
    }
    if (context.prompt.startsWith('rejected')) return '投稿しませんでした。';
    const ringi = submitted(context.prompt);
    const { category, amountYen } = ringi;

    const decision = JSON.parse(
      (await context.tool('authority', 'check_authority', { category, amountYen })).text,
    ) as Decision;

    const search = async (query: string): Promise<Hit[]> =>
      JSON.parse((await context.builtin('search_files', { query })).text) as Hit[];

    // Find the clause with search_files, open the rule file, and copy the 出典 line of section `§`.
    const readClause = async (query: string, section: string): Promise<string> => {
      const [hit] = (await search(query)).filter((entry) => entry.path.startsWith('rules/'));
      const { text } = await context.builtin('Read', { path: hit?.path ?? '' });
      const line = new RegExp(`^出典: (〔[^〕]*§${section}〕)$`, 'mu').exec(text);
      return line?.[1] ?? '';
    };

    const omissions: Finding[] = [];
    const required = await readClause('必須記載事項', '4.1');
    for (const [key, label] of REQUIRED_FIELDS) {
      if ((ringi[key] ?? '').trim() === '') {
        omissions.push({ text: `${label}が記載されていない。`, citations: [inBrackets(required)] });
      }
    }
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
    if (amountYen > 1_000_000 && ringi.quotes?.length === 1) {
      const quotes = await readClause('相見積 見積書', '4.2');
      breaches.push({
        text: '100万円を超えるが見積が1社で、特命理由の記載がない。',
        citations: [inBrackets(quotes)],
      });
    }

    // The subject's essentials (「第3工場 搬送コンベヤの更新」 → 「工場 更新」), once; then open
    // each ringi file the search found and keep the records of the same category that renew.
    const precedents: Finding[] = [];
    for (const hit of (await search('工場 更新')).filter((entry) =>
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

describe('ringi review agent', () => {
  it('the project passes the contract aw check applies', () => {
    const [agent] = project.agents;
    expect(project.agents).toHaveLength(1);
    const definition = agent?.body.definition;
    expect(definition?.agent.name).toBe('ringi-review');
    expect(definition?.agent.permissions).toStrictEqual({
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    });
    expect(definition?.resources).toMatchObject({
      connectors: ['authority', 'workflow'],
      skills: ['ringi-checklist'],
      files: [
        { path: 'rules', access: 'read' },
        { path: 'ringi', access: 'read' },
      ],
    });
    expect(definition?.agent.instructions).toContain('check_authority');
    expect(definition?.agent.instructions).toContain('search_files');
    expect(definition?.agent.instructions).toContain('承認も否決もしません');
    expect(agent?.body.surfaces?.map((surface) => [surface.name, surface.layout])).toStrictEqual([
      ['ringi-desk', 'side'],
    ]);
    expect(agent?.body.surfaces?.[0]?.toolResults).toStrictEqual({
      search_files: 'card',
    });
    expect(project.skills.map((skill) => skill.name)).toStrictEqual(['ringi-checklist']);
    // The ceiling every agent in the project inherits: no file writes, no commands, no open network.
    expect(project.project.policy?.permissions).toStrictEqual({
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    });
  });

  it('the eval file and the promotion bar are valid', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(4);
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
    expect(cases.some((entry) => entry.expect.notContains?.includes('承認を推奨'))).toBe(true);
    expect(cases.some((entry) => entry.expect.judge !== undefined)).toBe(true);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('the no-recommendation case still fails a verdict, and no longer fails the check the skill requires', () => {
    const entry = (project.agents[0]?.evals?.cases ?? []).find((candidate) =>
      candidate.expect.notContains?.includes('承認を推奨'),
    );
    expect(entry?.expect.notContains).toStrictEqual(['承認を推奨', '否決を推奨', '承認してよい']);
    const judge = entry?.expect.judge ?? '';
    for (const heading of ['記載漏れ', '規程との照合', '決裁区分', '類似案件', '総合所見']) {
      expect(judge).toContain(`「${heading}」`);
    }
    expect(judge).toContain('承認・否決の判断や推奨を書いていないこと');
    expect(judge).toContain('不合格');
    // The skill requires the approver's points to be written (総合所見); the rubric must not read them as a verdict.
    expect(judge).toContain('「確認が求められる」');
    expect(judge).toContain('推奨や判断には当たらない');
  });

  it('the agent finds precedents, including rejected ones, with search_files and ships no index server', async () => {
    expect(await authority.tools()).toStrictEqual(['check_authority']);
    expect(project.project.connectors).not.toHaveProperty('ringi-archive');

    const workspace = scriptedWorkspace(
      async ({ builtin, prompt }) => (await builtin('search_files', { query: prompt })).text,
      {},
      builtins,
    );
    const search = async (person: string, query: string): Promise<Hit[]> => {
      const { run } = await workspace.aw.runs.start(workspace.agentId, {
        prompt: query,
        subject: person,
        fileScope: fileScopeFor(person, access),
      });
      return JSON.parse((await workspace.aw.runs.result(run.id)).text ?? '[]') as Hit[];
    };
    const pathsOf = async (person: string, query: string): Promise<string[]> =>
      (await search(person, query)).map((hit) => hit.path).sort();

    // A rejected precedent is found by why it was sent back, not only by its subject.
    expect(await pathsOf(SUBMITTER, '工場 更新')).toStrictEqual([
      'ringi/製造本部/2025.json',
      'ringi/製造本部/2026.json',
    ]);
    expect(await pathsOf(SUBMITTER, '分割起案 差戻し')).toStrictEqual(['ringi/物流部/2025.json']);
    expect(await pathsOf(SUBMITTER, '議員 後援会 否決')).toStrictEqual([
      'ringi/営業本部/2025.json',
    ]);

    // The hit carries the platform's shape, and the file it names holds the record and its 出典.
    const [split] = await search(SUBMITTER, '分割起案 差戻し');
    expect(split).toMatchObject({ path: 'ringi/物流部/2025.json', page: null });
    const records = JSON.parse(
      await readFile(path.join(DATA, split?.path ?? ''), 'utf8'),
    ) as RingiRecord[];
    const rejected = records.find((record) => record.id === 'R-2025-0133');
    expect(rejected?.理由).toContain('§2.3');
    expect(rejected?.出典).toBe('〔稟議 R-2025-0133〕');

    // The rules are searched the same way, and a clause carries its own 出典.
    const [clause] = await search(SUBMITTER, '相見積 見積書');
    expect(clause?.path).toBe('rules/ringi-rules.md');
    expect(await readFile(path.join(DATA, 'rules', 'donation-rules.md'), 'utf8')).toContain(
      '出典: 〔寄付金取扱基準 §2.2〕',
    );

    expect(await search(SUBMITTER, '社員食堂 営業時間')).toStrictEqual([]);
  });

  it('narrows each review run to the filer’s departments by fileScope, so another department’s precedents are never found', async () => {
    expect(fileScopeFor(SUBMITTER, access)).toStrictEqual([
      'ringi/製造本部',
      'ringi/物流部',
      'ringi/営業本部',
      'ringi/技術本部',
      'ringi/情報システム部',
      'ringi/総務部',
      'rules',
    ]);
    expect(fileScopeFor(HR_CLERK, access)).toStrictEqual(['ringi/人事部', 'rules']);

    // R-2025-0184 is 人事部's. What the run saw is whatever the scope let through, and the prompt
    // that claims to be the clerk changes nothing: the run's `fileScope` decides.
    const script = async ({ builtin }: ScriptContext): Promise<ScriptAnswer> => {
      const found = await builtin('search_files', { query: '人事評価 クラウド' });
      const opened = await builtin('Read', { path: 'ringi/人事部/2025.json' });
      // The run asked for the review sheet; the answer here is only what it saw.
      return { text: JSON.stringify({ found: found.text, opened }), structured: {} };
    };
    const askAs = async (
      person: string,
    ): Promise<{ found: string; opened: { isError: boolean } }> => {
      const desk = await hook(script);
      const runId = await desk.file({ ...CONVEYOR, submittedBy: person });
      const answer = JSON.parse((await desk.aw.runs.result(runId)).text ?? '{}') as {
        found: string;
        opened: { isError: boolean };
      };
      expect(desk.subjects()).toStrictEqual([person]);
      expect(desk.fileScopes()).toStrictEqual([fileScopeFor(person, access)]);
      return answer;
    };

    const clerk = await askAs(HR_CLERK);
    expect((JSON.parse(clerk.found) as Hit[]).map((hit) => hit.path)).toStrictEqual([
      'ringi/人事部/2025.json',
    ]);
    expect(clerk.opened.isError).toBe(false);

    const filer = await askAs(SUBMITTER);
    expect(JSON.parse(filer.found)).toStrictEqual([]);
    expect(filer.found).not.toContain('人事評価');
    expect(filer.opened.isError).toBe(true);
  });

  it('refuses to start a review for a filer who may read no department, rather than an unscoped run', async () => {
    const desk = await hook(reviewer(), {
      access: { ...access, 'no-access': { departments: [] } },
    });
    await expect(desk.file({ ...CONVEYOR, submittedBy: STRANGER })).rejects.toThrow(
      `${STRANGER} may read no department`,
    );
    await expect(desk.file({ ...CONVEYOR, submittedBy: 'no-access' })).rejects.toThrow(
      'may read no department',
    );
    expect(desk.runs()).toBe(0);
  });

  it('check_authority applies the matrix at each boundary and cites the clause', async () => {
    const approver = async (category: string, amountYen: number): Promise<string> =>
      (await authority.callJson<Decision>('check_authority', { category, amountYen })).route;

    expect(await approver('設備投資', 3_000_000)).toBe('部長決裁');
    expect(await approver('設備投資', 3_000_001)).toBe('本部長決裁');
    expect(await approver('設備投資', 30_000_000)).toBe('本部長決裁');
    expect(await approver('設備投資', 30_000_001)).toBe('取締役会決裁');
    expect(await approver('業務委託', 62_000_000)).toBe('社長決裁');
    // A donation needs the president at any amount, with 総務部長 co-reviewing.
    expect(
      await authority.callJson<Decision>('check_authority', {
        category: '寄付',
        amountYen: 100_000,
      }),
    ).toMatchObject({ route: '社長決裁', coReview: '総務部長', clause: '〔職務権限規程 §3.4〕' });

    const unknown = await authority.call('check_authority', { category: '人員採用', amountYen: 1 });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('〔職務権限規程 §1.1〕');
    expect(
      (await authority.call('check_authority', { category: '設備投資', amountYen: -1 })).isError,
    ).toBe(true);
    expect(
      (await authority.call('check_authority', { category: '設備投資', amountYen: '4500万' }))
        .isError,
    ).toBe(true);
  });

  it('startReview starts a typed review and reviewRun checks a sheet whose route matches the matrix', async () => {
    const desk = await hook(reviewer());
    const { review, comment } = await reviewRun(await desk.file(), CONVEYOR, desk);

    expect(review.authority).toMatchObject({
      written: '取締役会',
      matches: true,
      toolCalled: true,
      expected: { route: '取締役会決裁', clause: '〔職務権限規程 §3.1〕' },
    });
    expect(review.sheet.記載漏れ).toStrictEqual([
      { text: '期待効果が記載されていない。', citations: ['稟議規程 §4.1'] },
    ]);
    expect(review.missingFields).toStrictEqual(['期待効果']);
    expect(review.missedByAgent).toStrictEqual([]);
    expect(review.sheet.規程との照合[0]?.citations).toStrictEqual(['稟議規程 §4.2']);
    // Membership, not order: search_files ranks near-equal files by its own score.
    expect(review.sheet.類似案件.map((finding) => finding.citations[0]).sort()).toStrictEqual([
      '稟議 R-2025-0112',
      '稟議 R-2026-0018',
    ]);
    expect(review.unverified).toStrictEqual([]);

    expect(desk.runs()).toBe(1);
    expect(comment).toContain('承認・否決の判断はしていません');
    expect(comment).not.toContain('⚠');
  });

  it('filing the same revision again, even at once, starts one review for the filer; a new revision starts another', async () => {
    const desk = await hook(reviewer());
    const withQuote = { ...CONVEYOR, quotes: [{ fileId: QUOTE_ID }] };
    const [first, concurrent] = await Promise.all([desk.file(withQuote), desk.file(withQuote)]);
    const later = await desk.file(withQuote);
    expect([concurrent, later]).toStrictEqual([first, first]);
    expect(desk.runs()).toBe(1);
    expect(desk.subjects()).toStrictEqual([CONVEYOR.submittedBy]);

    const { review } = await reviewRun(first, withQuote, desk);
    expect(review.sheet.類似案件.length).toBeGreaterThan(0);
    expect(review.unverified).toStrictEqual([]);

    const revised = await desk.file({ ...withQuote, revision: 2 });
    expect(revised).not.toBe(first);
    expect(desk.runs()).toBe(2);
  });

  it('reviewRun flags a 決裁区分 that disagrees with the authority matrix', async () => {
    const desk = await hook(reviewer({ misreadApprover: '本部長' }));
    const { review, comment } = await reviewRun(await desk.file(), CONVEYOR, desk);
    expect(review.authority).toMatchObject({ written: '本部長', matches: false });
    expect(comment).toContain(
      '⚠ 決裁区分の不一致: レビューシートは「本部長」、職務権限規程の判定は「取締役会決裁」〔職務権限規程 §3.1〕です。',
    );
  });

  it('the agent posts the review comment only after the call is approved, and cannot approve or reject', async () => {
    const document = JSON.parse(
      await readFile(path.join(DIR, 'apis', 'workflow.openapi.json'), 'utf8'),
    ) as OpenApiDocument;
    const serverKey = toolServerKey('workflow');
    const [definition] = toolDefinitionsOf(agentDefinition);
    expect(definition).toMatchObject({ name: 'workflow', allow: ['operationId:postComment'] });

    // The document declares approve and reject; the allow rule admits only the comment.
    const operations = operationsOf(document);
    expect(operations.map((operation) => operation.operationId)).toStrictEqual([
      'postComment',
      'approveRequest',
      'rejectRequest',
    ]);
    const selected = selectAllowedOperations(workflowTool.allow, operations);
    expect(selected.refusals).toStrictEqual([]);
    expect(selected.admitted.map((operation) => operation.operationId)).toStrictEqual([
      'postComment',
    ]);
    expect(toolApprovalRules(serverKey, [{ name: 'postComment', method: 'POST' }])).toStrictEqual([
      'mcp__workflow__postComment',
    ]);

    const args = {
      requestId: CONVEYOR.ringiId,
      body: {
        revision: CONVEYOR.revision,
        body: '【AI稟議レビュー】R-2026-0101 rev.1\n\n## 総合所見',
      },
    };
    const gateway = (approved: readonly string[]) =>
      openapiGateway({
        document,
        allow: workflowTool.allow,
        baseUrl: workflowSystem.url,
        token: WORKFLOW_TOKEN,
        serverKey,
        approvedToolCalls: approved,
      });
    const atWorkflow = await asPersonAtWorkflow(SUBMITTER);
    expect(await gateway([]).tools()).toStrictEqual(['postComment']);
    const before = workflowSystem.requests.length;
    const posted = workflowSystem.comments.length;

    // Not approved: refused, and the workflow system is never dialled.
    expect(await gateway([]).call('postComment', args, atWorkflow)).toStrictEqual({
      text: 'approval_required',
      isError: true,
    });
    // Approve and reject are not tools at all.
    for (const name of ['approveRequest', 'rejectRequest']) {
      const refused = await gateway([
        canonicalCall(`mcp__workflow__${name}`, {
          requestId: CONVEYOR.ringiId,
          body: { revision: 1 },
        }),
      ]).call(name, { requestId: CONVEYOR.ringiId, body: { revision: 1 } }, atWorkflow);
      expect(refused.text).toContain('unknown tool');
    }
    expect(workflowSystem.requests).toHaveLength(before);

    // Approved: exactly one comment, with the body that was approved.
    const approved = gateway([canonicalCall('mcp__workflow__postComment', args)]);
    expect(
      (await approved.callJson<{ commentId: string }>('postComment', args, atWorkflow)).commentId,
    ).toMatch(/^C-\d{4}$/u);
    expect(workflowSystem.comments.slice(posted)).toStrictEqual([
      { ringiId: 'R-2026-0101', revision: 1, body: args.body.body, by: SUBMITTER },
    ]);
    expect(workflowSystem.requests.slice(before)).toStrictEqual([
      { method: 'POST', path: '/api/v1/requests/R-2026-0101/comments' },
    ]);
  });

  it("refuses to comment on another department's ringi by the asserted subject", async () => {
    const comment = (ringiId: string) => ({
      requestId: ringiId,
      body: { revision: 1, body: '【AI稟議レビュー】' },
    });
    // Every call is approved, so what refuses is the workflow system, by who is asking.
    const gateway = await workflowGateway(
      ['R-2026-0101', 'R-2026-0102', 'R-2026-9999'].map((ringiId) =>
        canonicalCall('mcp__workflow__postComment', comment(ringiId)),
      ),
    );
    const posted = workflowSystem.comments.length;
    const hr = await asPersonAtWorkflow(HR_CLERK);
    const filer = await asPersonAtWorkflow(SUBMITTER);

    // 人事部 may not comment on 製造本部's ringi, and 製造本部's filer not on 人事部's: both are
    // answered exactly like a ringi that does not exist.
    const refusedToHr = await gateway.call('postComment', comment('R-2026-0101'), hr);
    const refusedToFiler = await gateway.call('postComment', comment('R-2026-0102'), filer);
    const missing = await gateway.call('postComment', comment('R-2026-9999'), filer);
    expect(refusedToHr.isError).toBe(true);
    expect(refusedToHr.text).toBe(missing.text.replace('R-2026-9999', 'R-2026-0101'));
    expect(refusedToFiler.text).toBe(missing.text.replace('R-2026-9999', 'R-2026-0102'));
    // No assertion at all: refused before any ringi is looked at.
    expect((await gateway.call('postComment', comment('R-2026-0101'))).isError).toBe(true);
    expect(workflowSystem.comments).toHaveLength(posted);

    // The prompt text does not matter: the filer's own ringi takes the comment.
    expect((await gateway.call('postComment', comment('R-2026-0101'), filer)).isError).toBe(false);
    expect(workflowSystem.comments).toHaveLength(posted + 1);
  });

  it('postReview: the post run pauses for approval on exactly the checked comment, warnings included, and nothing is posted', async () => {
    const desk = await hook(reviewer({ misreadApprover: '本部長', invent: '寄付金取扱基準 §9.9' }));
    const checked = await reviewRun(await desk.file(), CONVEYOR, desk);
    expect(checked.comment).toContain('⚠ 決裁区分の不一致');
    expect(checked.comment).toContain('⚠ 根拠を確認できない出典: 〔寄付金取扱基準 §9.9〕');
    const posted = workflowSystem.comments.length;

    // Nobody has approved the call, so the run stops at it: a typed pause, not a crash.
    const outcome = await postReview(CONVEYOR, checked, desk);
    if (outcome.status !== 'awaiting_approval') throw new Error(`the post run ${outcome.status}`);
    expect(outcome.exact).toBe(true);
    expect(outcome.sessionId).toBe(checked.review.sessionId);
    expect(outcome.call.toolName).toBe('mcp__workflow__postComment');
    // What the person approves is the comment with this code's warnings, not the agent's own text.
    expect(outcome.call.canonicalCall).toBe(
      canonicalCall('mcp__workflow__postComment', {
        requestId: CONVEYOR.ringiId,
        body: { revision: CONVEYOR.revision, body: checked.comment },
      }),
    );
    expect(workflowSystem.comments).toHaveLength(posted);
    expect(desk.subjects()).toStrictEqual([SUBMITTER, SUBMITTER]);
  });

  it('postReview pauses on exactly the checked comment and, once approved, the continuation posts it for the filer', async () => {
    const desk = await hook(reviewer({ misreadApprover: '本部長' }));
    const checked = await reviewRun(await desk.file(), CONVEYOR, desk);
    const posted = workflowSystem.comments.length;

    // Pause: the person is asked to approve the checked comment, and nothing is written yet.
    const paused = await postReview(CONVEYOR, checked, desk);
    if (paused.status !== 'awaiting_approval') throw new Error(`the post run ${paused.status}`);
    expect(paused.exact).toBe(true);
    expect(workflowSystem.comments).toHaveLength(posted);

    // Approve: the continuation, in the same session and for the filer, posts that comment.
    const outcome = await decidePost(desk.aw, paused, { approve: true });
    expect(outcome).toMatchObject({ status: 'posted' });
    expect(outcome.runId).not.toBe(paused.runId);
    expect(workflowSystem.comments.slice(posted)).toStrictEqual([
      {
        ringiId: CONVEYOR.ringiId,
        revision: CONVEYOR.revision,
        body: checked.comment,
        by: SUBMITTER,
      },
    ]);
    expect(workflowSystem.comments.at(-1)?.body).toContain('⚠ 決裁区分の不一致');
    expect(desk.subjects()).toStrictEqual([SUBMITTER, SUBMITTER, SUBMITTER]);
    expect(desk.sessionIds().at(-1)).toBe(checked.review.sessionId);

    // The approval is spent: a second decision is a 409, and nothing is posted twice.
    await expect(decidePost(desk.aw, paused, { approve: true })).rejects.toMatchObject({
      code: 'run_not_awaiting_approval',
    });
    expect(workflowSystem.comments).toHaveLength(posted + 1);
  });

  it('a rejected post posts nothing, and a paused call that is not the checked comment cannot be approved', async () => {
    const desk = await hook(reviewer());
    const checked = await reviewRun(await desk.file(), CONVEYOR, desk);
    const posted = workflowSystem.comments.length;

    const paused = await postReview(CONVEYOR, checked, desk);
    if (paused.status !== 'awaiting_approval') throw new Error(`the post run ${paused.status}`);
    await expect(
      decidePost(desk.aw, { ...paused, exact: false }, { approve: true }),
    ).rejects.toThrow('not the checked comment');

    expect(
      await decidePost(desk.aw, paused, { approve: false, comment: '文面を直してから' }),
    ).toMatchObject({ status: 'not_posted' });
    expect(workflowSystem.comments).toHaveLength(posted);
  });

  it('the quotes (見積書) ride on the review run as attachments, and a ringi without quotes sends none', async () => {
    const desk = await hook(reviewer());
    const second = { fileId: 'a0000000-0000-4000-8000-000000000012' };
    await desk.file({ ...CONVEYOR, quotes: [{ fileId: QUOTE_ID }, second] });
    const { quotes, ...withoutQuotes } = CONVEYOR;
    expect(quotes).toHaveLength(1); // the revision below drops them
    await desk.file({ ...withoutQuotes, revision: 2 });

    const starts = desk.calls
      .filter((call) => call.method === 'POST')
      .map((call) => call.json as { prompt: string; attachments?: unknown });
    expect(starts[0]?.attachments).toStrictEqual([{ fileId: QUOTE_ID }, second]);
    expect(starts[0]?.prompt).toContain(`"quotes":[{"fileId":"${QUOTE_ID}"},`);
    expect(starts[1]).not.toHaveProperty('attachments');
    expect(starts[1]?.prompt).not.toContain('"quotes"');
  });

  it('reviewRun reads the review sheet as typed output and flags a citation no tool returned', async () => {
    const desk = await hook(reviewer({ invent: '寄付金取扱基準 §9.9' }));
    const { review, comment } = await reviewRun(await desk.file(), CONVEYOR, desk);
    expect(desk.outputSchemas()).toMatchObject([
      {
        type: 'object',
        required: ['記載漏れ', '規程との照合', '決裁区分', '類似案件', '総合所見'],
      },
    ]);
    expect(review.unverified).toStrictEqual(['寄付金取扱基準 §9.9']);
    expect(comment).toContain('⚠ 根拠を確認できない出典: 〔寄付金取扱基準 §9.9〕');
    expect(comment).toContain('## 総合所見');
  });

  it('reviewRun also flags a citation written inline in a finding that no tool returned', async () => {
    const desk = await hook(reviewer({ inventInline: '寄付金取扱基準 §9.9' }));
    const { review, comment } = await reviewRun(await desk.file(), CONVEYOR, desk);
    expect(review.unverified).toStrictEqual(['寄付金取扱基準 §9.9']);
    expect(comment).toContain('⚠ 根拠を確認できない出典: 〔寄付金取扱基準 §9.9〕');
  });

  it('a ringi posted to the trigger starts one run per Idempotency-Key and refuses a wrong secret', async () => {
    const workspace = scriptedWorkspace(() => Promise.resolve('レビューしました。'));
    const created = await workspace.aw.triggers.create({
      ...RINGI_TRIGGER,
      agentId: workspace.agentId,
    });
    if (!('firePath' in created)) throw new Error('a webhook trigger answers its fire path');
    const key = `${CONVEYOR.ringiId}@${String(CONVEYOR.revision)}`;

    // The workflow system times out and sends the same event twice, at once and again later.
    const [first, concurrent] = await Promise.all([
      workspace.fire(created.firePath, CONVEYOR, { idempotencyKey: key }),
      workspace.fire(created.firePath, CONVEYOR, { idempotencyKey: key }),
    ]);
    const later = await workspace.fire(created.firePath, CONVEYOR, { idempotencyKey: key });
    expect([first.status, concurrent.status, later.status]).toStrictEqual([202, 202, 202]);
    expect(first.run?.id).toBeDefined();
    expect(concurrent.run?.id).toBe(first.run?.id);
    expect(later.run?.id).toBe(first.run?.id);
    expect(workspace.runs).toHaveLength(1);
    expect(workspace.runs[0]?.prompt).toContain(JSON.stringify(CONVEYOR));
    expect(workspace.runs[0]?.prompt).toContain('ringi-checklist');

    // A revised ringi is a new event, so a new key and a new run.
    const revised = await workspace.fire(
      created.firePath,
      { ...CONVEYOR, revision: 2 },
      { idempotencyKey: `${CONVEYOR.ringiId}@2` },
    );
    expect(revised.run?.id).not.toBe(first.run?.id);
    expect(workspace.runs).toHaveLength(2);

    // Every miss on the URL is the same 404, and starts nothing.
    const wrong = await workspace.fire(created.firePath.replace(/[^/]+$/u, 'awts_wrong'), CONVEYOR);
    expect(wrong).toMatchObject({ status: 404, run: null, code: 'trigger_not_found' });
    expect(workspace.runs).toHaveLength(2);
  });

  it('a failed start frees its Idempotency-Key, so the sender can retry with the same key', async () => {
    let attempts = 0;
    const workspace = scriptedWorkspace(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('runtime unavailable'))
        : Promise.resolve('レビューしました。');
    });
    const created = await workspace.aw.triggers.create({
      ...RINGI_TRIGGER,
      agentId: workspace.agentId,
    });
    if (!('firePath' in created)) throw new Error('a webhook trigger answers its fire path');
    const key = `${CONVEYOR.ringiId}@${String(CONVEYOR.revision)}`;

    await expect(
      workspace.fire(created.firePath, CONVEYOR, { idempotencyKey: key }),
    ).rejects.toThrow();
    const retry = await workspace.fire(created.firePath, CONVEYOR, { idempotencyKey: key });
    expect(retry.status).toBe(202);
    expect(retry.run?.id).toBeDefined();
    expect(workspace.runs).toHaveLength(2);
  });

  it('the ringi trigger, configured with a subject, starts a review the backend reads as a typed sheet', async () => {
    const workspace = scriptedWorkspace(
      reviewer(),
      { authority: { id: CONNECTOR_ID, session: authority } },
      builtins,
    );
    const created = await workspace.aw.triggers.create({
      ...RINGI_TRIGGER,
      subject: SUBMITTER,
      agentId: workspace.agentId,
    });
    if (!('firePath' in created)) throw new Error('a webhook trigger answers its fire path');
    expect(created.trigger.subject).toBe(SUBMITTER);

    const key = `${CONVEYOR.ringiId}@${String(CONVEYOR.revision)}`;
    const { run } = await workspace.fire(created.firePath, CONVEYOR, { idempotencyKey: key });
    expect(workspace.runs.map((started) => started.subject)).toStrictEqual([SUBMITTER]);
    // A trigger carries no fileScope, so this run is not narrowed to the filer's departments.
    expect(workspace.runs.map((started) => started.fileScope)).toStrictEqual([null]);

    const { review, comment } = await reviewRun(run?.id ?? '', CONVEYOR, {
      aw: workspace.aw,
      agentId: workspace.agentId,
      matrix,
      access,
    });
    expect(review.sheet.類似案件.map((finding) => finding.citations[0]).sort()).toStrictEqual([
      '稟議 R-2025-0112',
      '稟議 R-2026-0018',
    ]);
    expect(review.authority.matches).toBe(true);
    expect(review.unverified).toStrictEqual([]);
    expect(comment).toContain('承認・否決の判断はしていません');
  });

  it('a run a trigger started answers in the review sheet, so the backend reads a typed sheet from it', async () => {
    const sheet = {
      記載漏れ: [],
      規程との照合: [],
      決裁区分: { approver: '取締役会', clause: '職務権限規程 §3.1', coReview: null },
      類似案件: [],
      総合所見: '要確認',
    };
    const workspace = scriptedWorkspace(() =>
      Promise.resolve({ text: 'レビューしました。', structured: sheet }),
    );
    const created = await workspace.aw.triggers.create({
      ...RINGI_TRIGGER,
      agentId: workspace.agentId,
    });
    if (!('firePath' in created)) throw new Error('a webhook trigger answers its fire path');
    expect(created.trigger.outputSchema).toMatchObject({ type: 'object' });
    const { run } = await workspace.fire(created.firePath, CONVEYOR);

    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['記載漏れ', '規程との照合', '決裁区分', '類似案件', '総合所見'],
    });
    const reading = await readRun(workspace.aw, run?.id ?? '', ReviewSheetSchema);
    expect(reading.output).toStrictEqual(sheet);
    expect(reading.run.output?.structured).toStrictEqual(sheet);

    // A trigger created without a schema stays untyped, as on the platform.
    const plain = await workspace.aw.triggers.create({
      kind: 'webhook',
      name: 'ringi-untyped',
      prompt: RINGI_TRIGGER.prompt,
      agentId: workspace.agentId,
    });
    if (!('firePath' in plain)) throw new Error('a webhook trigger answers its fire path');
    const untyped = await workspace.fire(plain.firePath, CONVEYOR);
    expect(workspace.runs[1]?.outputSchema).toBeNull();
    await expect(readRun(workspace.aw, untyped.run?.id ?? '', ReviewSheetSchema)).rejects.toThrow(
      'completed without structured output',
    );
  });
});
