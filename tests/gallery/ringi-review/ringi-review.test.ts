/**
 * Use case 4, the ringi review agent: the definition passes the contract and stays read-only, the
 * archive server finds precedents and applies the authority matrix deterministically, and the
 * webhook hook reviews each ringi revision once, re-checks the agent's 決裁区分 and posts the
 * sheet back. See `../README.md` for the three tiers and what each proves.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startMcpServer, type McpSession } from '../harness/mcp-client.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import { scriptedWorkspace, type ScriptContext } from '../harness/scripted-workspace.ts';
import {
  InvalidSubmission,
  memoryKeyStore,
  onRingiSubmitted,
  type HookDependencies,
  type RingiSubmission,
} from './backend/on-ringi-submitted.ts';
import { parseReviewSheet } from './backend/review-sheet.ts';
import { parseAuthorityMatrix, type AuthorityMatrix } from './mcp/authority.mjs';
import agentDefinition from './agents/ringi-review.ts';
import surfaceDefinition from './surfaces/ringi-desk.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONNECTOR_ID = '6b1c1f0e-0000-4000-8000-000000000004';

interface RingiHit {
  readonly id: string;
  readonly 件名: string;
  readonly 区分: string;
  readonly 結果: string;
}
interface RingiRecord extends RingiHit {
  readonly 理由: string;
  readonly citation: string;
}
interface RuleHit {
  readonly id: string;
  readonly source: string;
  readonly section: string;
}
interface Decision {
  readonly approver: string;
  readonly route: string;
  readonly coReview: string | null;
  readonly clause: string;
}

let archive: McpSession;
let project: GalleryProject;
let matrix: AuthorityMatrix;

beforeAll(async () => {
  archive = await startMcpServer(path.join(DIR, 'mcp', 'ringi-archive.mjs'));
  project = await loadGalleryProject(DIR, {
    'agents/ringi-review.ts': agentDefinition,
    'surfaces/ringi-desk.ts': surfaceDefinition,
  });
  matrix = parseAuthorityMatrix(
    await readFile(path.join(DIR, 'data', 'rules', 'authority-matrix.md'), 'utf8'),
  );
});
afterAll(() => {
  archive.close();
});

/** A filed ringi as the workflow system sends it: over 3,000万円, one quote, no 期待効果. */
const CONVEYOR: RingiSubmission = {
  ringiId: 'R-2026-0101',
  revision: 1,
  title: '第3工場 搬送コンベヤの更新',
  category: '設備投資',
  amountYen: 45_000_000,
  department: '製造本部 第3製造部',
  applicant: '山本 健',
  purpose: '老朽化したコンベヤ（導入2008年）の更新',
  paymentTerms: '検収後翌月末',
  plannedDate: '2026-12-01',
  quotes: 1,
  inBudget: true,
};

const field = (prompt: string, label: string): string =>
  new RegExp(`^${label}: (.*)$`, 'mu').exec(prompt)?.[1]?.trim() ?? '';

/**
 * What a model following `agents/ringi-review.md` does: check the authority, read the clauses
 * that apply, look up precedents, and write the sheet in the skill's format. The decisions are
 * scripted; every tool result is the real server's. `misreadRoute` makes it write the route
 * itself instead of copying `check_authority`, the mistake the backend must catch.
 */
function reviewer(options: { readonly misreadRoute?: string } = {}) {
  return async (context: ScriptContext): Promise<string> => {
    const { prompt } = context;
    const category = field(prompt, '区分');
    const amountYen = Number(/amountYen=(\d+)/u.exec(prompt)?.[1]);
    const title = field(prompt, '件名');

    const decision = JSON.parse(
      (await context.tool('ringi-archive', 'check_authority', { category, amountYen })).text,
    ) as Decision;

    const readClause = async (query: string): Promise<string> => {
      const hits = JSON.parse(
        (await context.tool('ringi-archive', 'search_rules', { query, limit: 1 })).text,
      ) as RuleHit[];
      const id = hits[0]?.id ?? '';
      const clause = JSON.parse(
        (await context.tool('ringi-archive', 'read_rule', { id })).text,
      ) as { citation: string };
      return clause.citation;
    };

    const omissions: string[] = [];
    const required = await readClause('稟議書の必須記載事項');
    for (const label of ['起案者', '目的', '期待効果', '支払条件', '実施予定日']) {
      if (field(prompt, label) === '（未記載）') {
        omissions.push(`- ${label}が記載されていない。${required}`);
      }
    }
    const breaches: string[] = [];
    if (amountYen > 1_000_000 && field(prompt, '見積社数') === '1') {
      const quotes = await readClause('相見積 見積書の添付');
      breaches.push(`- 100万円を超えるが見積が1社で、特命理由の記載がない。${quotes}`);
    }

    // Search by the subject; when nothing shares enough of it, rephrase to its essentials
    // (「第3工場 搬送コンベヤの更新」 → 「第3工場 更新」). The real agent searches the
    // essentials once and never re-searches; this scripted reviewer is more patient.
    const searchPrecedents = async (query: string): Promise<RingiHit[]> =>
      JSON.parse(
        (await context.tool('ringi-archive', 'search_ringi', { query, category, limit: 2 })).text,
      ) as RingiHit[];
    let hits = await searchPrecedents(title);
    if (hits.length === 0) {
      const [site = ''] = title.split(/\s/u);
      hits = await searchPrecedents(`${site} ${title.split('の').at(-1) ?? ''}`);
    }
    const precedents: string[] = [];
    for (const hit of hits) {
      const record = JSON.parse(
        (await context.tool('ringi-archive', 'get_ringi', { id: hit.id })).text,
      ) as RingiRecord;
      precedents.push(
        `- ${record.id}（${record.結果}）${record.件名}: 同じ区分の設備更新の先例。${record.citation}`,
      );
    }

    const route = options.misreadRoute ?? decision.route;
    return [
      `# 稟議レビュー ${field(prompt, '稟議ID')}`,
      '',
      '## 記載漏れ',
      ...(omissions.length > 0 ? omissions : ['- なし']),
      '',
      '## 規程との照合',
      ...(breaches.length > 0 ? breaches : ['- なし']),
      '',
      '## 決裁区分',
      `- 決裁区分: ${route}${decision.clause}`,
      `- 合議: ${decision.coReview ?? 'なし'}`,
      '',
      '## 類似案件',
      ...(precedents.length > 0 ? precedents : ['- なし']),
      '',
      '## 総合所見',
      '決裁者は、期待効果の記載と、見積が1社である理由を確認してください。',
    ].join('\n');
  };
}

function deps(
  script: ReturnType<typeof reviewer>,
  overrides: Partial<HookDependencies> = {},
): HookDependencies & {
  readonly posted: { ringiId: string; revision: number; body: string }[];
  readonly runs: () => number;
} {
  const workspace = scriptedWorkspace(script, {
    'ringi-archive': { id: CONNECTOR_ID, session: archive },
  });
  const posted: { ringiId: string; revision: number; body: string }[] = [];
  return {
    aw: workspace.aw,
    agentId: workspace.agentId,
    store: memoryKeyStore(),
    matrix,
    postComment: (ringiId, revision, body) => {
      posted.push({ ringiId, revision, body });
      return Promise.resolve();
    },
    ...overrides,
    posted,
    runs: () => workspace.runs.length,
  };
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
      connectors: ['ringi-archive'],
      skills: ['ringi-checklist'],
      files: [{ path: 'rules', access: 'read' }],
    });
    expect(definition?.agent.instructions).toContain('check_authority');
    expect(definition?.agent.instructions).toContain('承認も否決もしません');
    expect(agent?.body.surfaces?.map((surface) => [surface.name, surface.layout])).toStrictEqual([
      ['ringi-desk', 'side'],
    ]);
    expect(project.skills.map((skill) => skill.name)).toStrictEqual(['ringi-checklist']);
    // The ceiling every agent in the project inherits: nothing here can write.
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

  it('the archive finds precedents, including rejected ones, and refuses what it does not know', async () => {
    expect(await archive.tools()).toStrictEqual([
      'search_ringi',
      'get_ringi',
      'check_authority',
      'search_rules',
      'read_rule',
    ]);

    const updates = await archive.callJson<RingiHit[]>('search_ringi', {
      query: '工場 設備の更新',
      category: '設備投資',
    });
    expect(updates.map((hit) => hit.id)).toStrictEqual(['R-2026-0018', 'R-2025-0112']);

    // A rejected precedent is found by why it was sent back, not only by its subject.
    const split = await archive.callJson<RingiHit[]>('search_ringi', {
      query: '分割起案',
      result: '差戻し',
    });
    expect(split[0]?.id).toBe('R-2025-0133');
    expect(split.every((hit) => hit.結果 === '差戻し')).toBe(true);
    const record = await archive.callJson<RingiRecord>('get_ringi', { id: 'R-2025-0133' });
    expect(record.理由).toContain('§2.3');
    expect(record.citation).toBe('〔稟議 R-2025-0133〕');

    const donations = await archive.callJson<RingiHit[]>('search_ringi', {
      query: '議員 後援会',
      category: '寄付',
      result: '否決',
    });
    expect(donations[0]?.id).toBe('R-2025-0170');

    const rules = await archive.callJson<RuleHit[]>('search_rules', { query: '相見積' });
    expect(rules[0]).toMatchObject({ source: '稟議規程', section: '4.2' });
    expect(
      (await archive.callJson<{ citation: string }>('read_rule', { id: 'donation-rules#2.2' }))
        .citation,
    ).toBe('〔寄付金取扱基準 §2.2〕');

    expect(
      await archive.callJson<RingiHit[]>('search_ringi', { query: '社員食堂の営業時間' }),
    ).toStrictEqual([]);
    expect((await archive.call('get_ringi', { id: 'R-1999-0001' })).isError).toBe(true);
    const badFilter = await archive.call('search_ringi', { query: '更新', result: '保留' });
    expect(badFilter).toMatchObject({ isError: true });
    expect(badFilter.text).toContain('承認, 差戻し, 否決');
  });

  it('check_authority applies the matrix at each boundary and cites the clause', async () => {
    const approver = async (category: string, amountYen: number): Promise<string> =>
      (await archive.callJson<Decision>('check_authority', { category, amountYen })).route;

    expect(await approver('設備投資', 3_000_000)).toBe('部長決裁');
    expect(await approver('設備投資', 3_000_001)).toBe('本部長決裁');
    expect(await approver('設備投資', 30_000_000)).toBe('本部長決裁');
    expect(await approver('設備投資', 30_000_001)).toBe('取締役会決裁');
    expect(await approver('業務委託', 62_000_000)).toBe('社長決裁');
    // A donation needs the president at any amount, with 総務部長 co-reviewing.
    expect(
      await archive.callJson<Decision>('check_authority', { category: '寄付', amountYen: 100_000 }),
    ).toMatchObject({ route: '社長決裁', coReview: '総務部長', clause: '〔職務権限規程 §3.4〕' });

    const unknown = await archive.call('check_authority', { category: '人員採用', amountYen: 1 });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('〔職務権限規程 §1.1〕');
    expect(
      (await archive.call('check_authority', { category: '設備投資', amountYen: -1 })).isError,
    ).toBe(true);
    expect(
      (await archive.call('check_authority', { category: '設備投資', amountYen: '4500万' }))
        .isError,
    ).toBe(true);
  });

  it('the hook reviews a filed ringi and posts a sheet whose route matches the matrix', async () => {
    const hook = deps(reviewer());
    const result = await onRingiSubmitted(CONVEYOR, hook);

    expect(result.status).toBe('reviewed');
    if (result.status !== 'reviewed') return;
    const { review } = result;
    expect(review.sheet.missingSections).toStrictEqual([]);
    expect(review.authority).toMatchObject({
      written: '取締役会',
      matches: true,
      toolCalled: true,
      expected: { route: '取締役会決裁', clause: '〔職務権限規程 §3.1〕' },
    });
    expect(review.sheet.sections.記載漏れ.map((finding) => finding.text)).toStrictEqual([
      '期待効果が記載されていない。〔稟議規程 §4.1〕',
    ]);
    expect(review.missingFields).toStrictEqual(['期待効果']);
    expect(review.missedByAgent).toStrictEqual([]);
    expect(review.sheet.sections.規程との照合[0]?.citations[0]).toMatchObject({
      source: '稟議規程',
      section: '4.2',
    });
    expect(
      review.sheet.sections.類似案件.map((finding) => finding.citations[0]?.raw),
    ).toStrictEqual(['稟議 R-2025-0112', '稟議 R-2026-0018']);
    expect(review.unverified).toStrictEqual([]);

    expect(hook.posted).toHaveLength(1);
    expect(hook.posted[0]).toMatchObject({ ringiId: 'R-2026-0101', revision: 1 });
    expect(hook.posted[0]?.body).toContain('承認・否決の判断はしていません');
    expect(hook.posted[0]?.body).not.toContain('⚠');
  });

  it('a retried webhook for the same revision does not start a second run', async () => {
    const hook = deps(reviewer());
    // The workflow system times out and sends the same event twice, at once and again later.
    const [first, concurrent] = await Promise.all([
      onRingiSubmitted(CONVEYOR, hook),
      onRingiSubmitted(CONVEYOR, hook),
    ]);
    const later = await onRingiSubmitted(CONVEYOR, hook);
    expect([first.status, concurrent.status, later.status].sort()).toStrictEqual([
      'duplicate',
      'duplicate',
      'reviewed',
    ]);
    expect(hook.runs()).toBe(1);
    expect(hook.posted).toHaveLength(1);

    // A revised ringi is a new event: it is reviewed again.
    const revised = await onRingiSubmitted(
      { ...CONVEYOR, revision: 2, effect: '搬送停止による稼働損失を年間約1,200万円削減' },
      hook,
    );
    expect(revised.status).toBe('reviewed');
    expect(hook.runs()).toBe(2);
    expect(hook.posted.map((post) => post.revision)).toStrictEqual([1, 2]);
  });

  it('the hook flags a 決裁区分 that disagrees with the authority matrix', async () => {
    const hook = deps(reviewer({ misreadRoute: '本部長決裁' }));
    const result = await onRingiSubmitted(CONVEYOR, hook);
    expect(result.status).toBe('reviewed');
    if (result.status !== 'reviewed') return;
    expect(result.review.authority).toMatchObject({ written: '本部長', matches: false });
    expect(result.comment).toContain(
      '⚠ 決裁区分の不一致: レビューシートは「本部長」、職務権限規程の判定は「取締役会決裁」〔職務権限規程 §3.1〕です。',
    );
  });

  it('a failed post is retried from the saved review without a second run', async () => {
    let failNext = true;
    const delivered: string[] = [];
    const hook = deps(reviewer(), {
      postComment: (_ringiId, _revision, body) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('workflow API 503'));
        }
        delivered.push(body);
        return Promise.resolve();
      },
    });
    await expect(onRingiSubmitted(CONVEYOR, hook)).rejects.toThrow('workflow API 503');
    const retried = await onRingiSubmitted(CONVEYOR, hook);
    expect(retried.status).toBe('reposted');
    expect(hook.runs()).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('取締役会決裁');
    expect((await onRingiSubmitted(CONVEYOR, hook)).status).toBe('duplicate');
  });

  it('an invalid webhook body is refused before any run starts', async () => {
    const hook = deps(reviewer());
    const refused = await onRingiSubmitted(
      { ...CONVEYOR, ringiId: 'abc', amountYen: '4500万円' },
      hook,
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(InvalidSubmission);
    expect((refused as InvalidSubmission).fields).toStrictEqual(['ringiId', 'amountYen']);
    expect(hook.runs()).toBe(0);
    expect(hook.posted).toStrictEqual([]);
  });

  it('the review sheet parser reports a dropped heading instead of reading it as no findings', () => {
    const sheet = parseReviewSheet(
      [
        '# 稟議レビュー R-2026-0102 rev.1',
        '## 記載漏れ',
        '- なし',
        '## 決裁区分',
        '- 決裁区分: 部長決裁〔職務権限規程 §3.2〕',
        '- 合議: なし',
        '## 総合所見',
        '特記事項はありません。',
      ].join('\n'),
    );
    expect(sheet.missingSections).toStrictEqual(['規程との照合', '類似案件']);
    expect(sheet.sections.記載漏れ).toStrictEqual([]);
    expect(sheet.approver).toBe('部長');
    expect(sheet.coReview).toBeNull();
    expect(sheet.summary).toBe('特記事項はありません。');
  });
});
