import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, it } from 'vitest';
import { scriptedWorkspace } from '../harness/scripted-workspace.ts';
import { RunDidNotComplete } from '../shared/run-answer.ts';
import { readDocx } from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';
import {
  decideReview,
  fileScopeFor,
  NoContractAccess,
  reviewContract,
  type AccessList,
  type ReviewRequest,
} from './backend/review.ts';
import {
  contractPath,
  NDA,
  SERVICE_AGREEMENT,
  SUPPLY_AGREEMENT,
  type Draft,
} from './data/drafts.ts';
import {
  ACCESS,
  SALES_MEMBER,
  PURCHASING_MEMBER,
  docxOf,
  reviewer,
  uploads,
  search,
  playbookFiles,
  reviewWorkspace,
  requestOf,
  paused,
  approved,
} from './contract-review.fixture.test-support.ts';
export function defineAccessCases(): void {
  it('the backend reads the rows as typed output after legal approves, and returns the review when they cover every must-flag finding', async () => {
    const workspace = reviewWorkspace(reviewer());
    expect(readDocx(docxOf(SERVICE_AGREEMENT)).paragraphs).toHaveLength(
      SERVICE_AGREEMENT.paragraphs.length,
    );
    const review = await approved(workspace);

    expect(review.status).toBe('reviewed');
    if (review.status !== 'reviewed') return;
    expect(review.unknownRules).toStrictEqual([]);
    expect(review.rows.map((row) => [row.clause, row.risk, row.rules.join()])).toStrictEqual([
      ['第6条', '高', 'PB-01'],
      ['第7条', '高', 'PB-03'],
      ['第5条', '高', 'PB-04'],
      ['第8条', '中', 'PB-05'],
      [null, '高', 'PB-06'],
      ['第3条', '中', 'PB-08'],
      ['第5条', '低', 'PB-04'],
    ]);
    expect(review.rows[4]?.proposal).toContain('反社会的勢力に該当しないこと');
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['review', 'rows'],
      properties: {
        rows: {
          type: 'array',
          items: { required: ['clause', 'topic', 'risk', 'reason', 'rules', 'proposal'] },
        },
      },
    });
    // The continuation keeps the schema, so the rows come back typed after the approval.
    expect(workspace.runs[1]?.outputSchema).toStrictEqual(workspace.runs[0]?.outputSchema);
    expect(review.answer).toContain('| 条項 | 論点 | リスク度 | 理由 | 修正文案 |');
  });

  it('a review run names the version, and the version pins the playbook revision the review applied', async () => {
    const workspace = reviewWorkspace(reviewer());
    await approved(workspace);
    const runId = workspace.runs[0]?.id;
    if (runId === undefined) throw new Error('the review started no run');

    // run id → the version the run executed …
    const run = await workspace.aw.runs.get(runId);
    expect(run.agentVersion).toBe(1);
    // … → that version's body → the playbook revision it pins …
    const { items } = await workspace.aw.agents.versions.list(workspace.agentId);
    const version = items.find((item) => item.number === run.agentVersion);
    const pinned = version?.body.definition.resources.skillRevisions;
    expect(pinned).toStrictEqual({ 'contract-playbook': 1 });
    // … → the published revision the version pins: its number, file count and date.
    const playbook = await workspace.aw.skills.get('contract-playbook');
    expect(playbook.revisions).toMatchObject([
      { number: pinned?.['contract-playbook'], fileCount: playbookFiles()['contract-playbook'] },
    ]);
  });

  it('the draft rides on the review run as an attachment; the prompt names the working folder, not the draft', async () => {
    const workspace = reviewWorkspace(reviewer());
    const request = requestOf(SERVICE_AGREEMENT);
    await reviewContract(workspace.aw, workspace.agentId, request);

    const [start] = workspace.calls.filter((call) => call.method === 'POST');
    expect(start?.json).toMatchObject({
      prompt:
        '添付の契約書ドラフトを審査基準に照らしてレビューし、リスク表を作成してください。\n作業フォルダ: drafts/営業一部/',
      attachments: [{ fileId: request.file.id }],
      subject: SALES_MEMBER,
      fileScope: ['contracts/営業一部', 'playbook', 'drafts/営業一部'],
      sessionId: null,
    });
    expect(workspace.runs[0]?.prompt).not.toContain('contracts/');
    expect(workspace.runs[0]?.prompt).not.toContain(SERVICE_AGREEMENT.file);
  });

  it('a reviewer reaches only the contracts of their deal teams, by fileScope and not by prompt text', async () => {
    // The model searches for a phrase only the purchasing team's contract holds.
    const asked = async (draft: Draft, reviewerName: string, query: string) => {
      let seen = '';
      const workspace = scriptedWorkspace(
        async ({ builtin }) => {
          seen = (await builtin('search_files', { query })).text;
          return seen;
        },
        {},
        { search_files: search.call },
      );
      // The prompt is the same for everyone; only the run's subject and scope decide.
      // The model answers in prose, so the run fails its schema; only what it searched matters here.
      await reviewContract(workspace.aw, workspace.agentId, requestOf(draft, reviewerName)).catch(
        (error: unknown) => {
          if (!(error instanceof RunDidNotComplete)) throw error;
        },
      );
      const paths = (JSON.parse(seen) as { path: string }[]).map((hit) => hit.path);
      return { paths, run: workspace.runs[0] };
    };

    const sales = await asked(SERVICE_AGREEMENT, SALES_MEMBER, '北陸精工');
    expect(sales.run).toMatchObject({
      subject: SALES_MEMBER,
      fileScope: ['contracts/営業一部', 'playbook', 'drafts/営業一部'],
    });
    expect(sales.paths).toStrictEqual([]);
    expect(
      (await search.call({ query: '北陸精工' }, { fileScope: ['contracts/営業一部'] })).text,
    ).toBe('[]');

    // Purchasing finds its own contract, and none of sales'.
    const purchasing = await asked(SUPPLY_AGREEMENT, PURCHASING_MEMBER, '北陸精工');
    expect(purchasing.run).toMatchObject({
      subject: PURCHASING_MEMBER,
      fileScope: ['contracts/購買部', 'playbook', 'drafts/購買部'],
    });
    expect(purchasing.paths).toStrictEqual([contractPath(SUPPLY_AGREEMENT)]);
    const secrecy = await asked(SUPPLY_AGREEMENT, PURCHASING_MEMBER, 'Harborline');
    expect(secrecy.paths).toStrictEqual([]);

    // A member of both teams reaches both, and the scratch folder is the attached draft's team.
    const both: AccessList = { ...ACCESS, 高橋: { teams: ['営業一部', '購買部'] } };
    const shared = reviewWorkspace(reviewer());
    await reviewContract(shared.aw, shared.agentId, {
      ...requestOf(SUPPLY_AGREEMENT, '高橋'),
      access: both,
    });
    const twoTeams = shared.runs[0];
    expect(twoTeams?.fileScope).toStrictEqual([
      'contracts/営業一部',
      'contracts/購買部',
      'playbook',
      'drafts/購買部',
    ]);
  });

  it('a reviewer with no deal team, or an attachment outside their teams, is refused before any run', async () => {
    const refused = async (request: ReviewRequest) => {
      const workspace = reviewWorkspace(reviewer());
      await expect(reviewContract(workspace.aw, workspace.agentId, request)).rejects.toThrow(
        NoContractAccess,
      );
      expect(workspace.runs).toHaveLength(0);
    };

    // No team, a reviewer access.json does not list, and a key that is on every object.
    const none: AccessList = { ...ACCESS, 新人: { teams: [] } };
    for (const name of ['新人', '見知らぬ人', '__proto__']) {
      await refused({ ...requestOf(SERVICE_AGREEMENT, name), access: none });
    }
    expect(() => fileScopeFor('__proto__', ACCESS)).toThrow(NoContractAccess);
    expect(fileScopeFor(SALES_MEMBER, ACCESS)).toStrictEqual(['contracts/営業一部', 'playbook']);

    // Sales cannot attach purchasing's contract by its file id, nor an id this session never uploaded.
    await refused(requestOf(SUPPLY_AGREEMENT, SALES_MEMBER));
    await refused({ ...requestOf(SERVICE_AGREEMENT), file: { id: randomUUID(), name: 'x.docx' } });
    const stray = randomUUID();
    const flat = new Map([...uploads, [stray, contractPath(NDA).replace('営業一部/', '')]]);
    await refused({
      ...requestOf(NDA),
      file: { id: stray, name: NDA.file },
      uploads: flat,
    });
    const dotted = new Map([[stray, 'contracts/営業一部/../購買部/x.docx']]);
    await refused({ ...requestOf(NDA), file: { id: stray, name: 'x.docx' }, uploads: dotted });
  });

  it("the continuation keeps the reviewer's subject and fileScope on approve and reject", async () => {
    const scope = ['contracts/営業一部', 'playbook', 'drafts/営業一部'];
    const workspace = reviewWorkspace(reviewer());
    const first = await paused(workspace);
    const second = await decideReview(workspace.aw, first, {
      approve: false,
      comment: '反社条項は標準文言のままで',
    });
    expect(second.status).toBe('awaiting_legal');
    if (second.status !== 'awaiting_legal') return;
    expect(second.team).toBe('営業一部');
    expect((await decideReview(workspace.aw, second, { approve: true })).status).toBe('reviewed');
    expect(workspace.runs).toHaveLength(3);
    for (const entry of workspace.runs) {
      expect(entry).toMatchObject({ subject: SALES_MEMBER, fileScope: scope });
    }
  });

  it("a redline written to another team's scratch folder pauses nothing to approve", async () => {
    const workspace = reviewWorkspace(async ({ native }) => {
      await native('Write', {
        file_path: `drafts/購買部/${path.basename(SERVICE_AGREEMENT.file, '.docx')}_修正案.json`,
        content: '{"paragraphs":[{"style":null,"text":"x"}]}',
      });
      return 'unreachable';
    });
    const outcome = await reviewContract(
      workspace.aw,
      workspace.agentId,
      requestOf(SERVICE_AGREEMENT),
    );
    expect(outcome.status).toBe('refused');
  });
}
