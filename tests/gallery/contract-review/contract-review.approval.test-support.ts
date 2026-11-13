import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { scriptedWorkspace } from '../harness/scripted-workspace.ts';
import { RunDidNotComplete } from '../shared/run-answer.ts';
import { readDocx } from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';
import { decideReview, reviewContract } from './backend/review.ts';
import { contractPath, NDA, SERVICE_AGREEMENT, SUPPLY_AGREEMENT } from './data/drafts.ts';
import {
  sandbox,
  node,
  checkInSandbox,
  redlineJson,
  redlineDocx,
  reviewer,
  type DraftScript,
  reviewWorkspace,
  requestOf,
  paused,
  approved,
  writeReview,
} from './contract-review.fixture.test-support.ts';
export function defineApprovalCases(): void {
  it('clauses.mjs redline plus office-reader write the draft with a 【修正案】 paragraph per must-flag finding', () => {
    const file = contractPath(SERVICE_AGREEMENT);
    const { bytes } = redlineDocx(file, redlineJson(file));
    const original = readDocx(readFileSync(path.join(sandbox, file))).paragraphs;
    const redlined = readDocx(bytes).paragraphs;
    expect(redlined.slice(0, original.length).map(({ text }) => text)).toStrictEqual(
      original.map(({ text }) => text),
    );
    const proposals = redlined.slice(original.length).map(({ text }) => text);
    expect(proposals[0]).toBe('【修正案】');
    const flagged = checkInSandbox(file).findings.filter((finding) => finding.mustFlag);
    expect(proposals.slice(1).map((text) => text.slice(0, 11))).toStrictEqual(
      flagged.map((finding) => `【修正案 ${finding.rule}】`),
    );
    expect(proposals.at(-1)).toContain('反社会的勢力に該当しないこと');
    expect(() => node('contract-playbook/scripts/clauses.mjs', ['redline', file])).toThrow(
      /usage: clauses.mjs redline/u,
    );
  });

  it('the backend returns the redlined .docx the agent wrote', async () => {
    const workspace = reviewWorkspace(reviewer());
    const review = await approved(workspace);
    const file = contractPath(SERVICE_AGREEMENT);
    const written = redlineDocx(file, redlineJson(file));
    expect(review.status).toBe('reviewed');
    if (review.status !== 'reviewed') return;
    expect(review.redline.name).toBe('業務委託契約書_株式会社ミナトシステムズ案_修正案.docx');
    // The bytes are the agent's file, not a copy the backend rebuilt.
    expect(Buffer.from(review.redline.bytes)).toStrictEqual(written.bytes);
  });

  it('the backend pauses on the redline before the Word is made, and approving it returns the rows and the .docx', async () => {
    const workspace = reviewWorkspace(reviewer());
    const awaiting = await paused(workspace);

    // Nothing is built: the run waits on the redline's Write, and legal reads the paragraphs it holds.
    expect(awaiting.status).toBe('awaiting_legal');
    expect(awaiting.call.toolName).toBe('Write');
    expect(awaiting.redline.at(-1)?.text).toMatch(/^【修正案 PB-06】/u);
    expect(awaiting.redline.at(-1)?.text).toContain('反社会的勢力に該当しないこと');
    expect(workspace.runs).toHaveLength(1);
    expect((await workspace.aw.runs.get(awaiting.runId)).status).toBe('awaiting_approval');
    expect(await workspace.aw.runs.outputs(awaiting.runId)).toStrictEqual([]);

    // Legal approves; the continuation is the same session and the same Write.
    const outcome = await decideReview(workspace.aw, awaiting, { approve: true });
    expect(workspace.runs[1]).toMatchObject({
      prompt: 'approved',
      sessionId: workspace.runs[0]?.sessionId,
      approvedToolCalls: [{ toolName: 'Write' }],
    });
    expect(outcome.status).toBe('reviewed');
    if (outcome.status !== 'reviewed') return;
    expect(outcome.sessionId).toBe(awaiting.sessionId);
    expect(outcome.rows).toHaveLength(7);
    const text = readDocx(Buffer.from(outcome.redline.bytes)).paragraphs.map(
      ({ text: line }) => line,
    );
    expect(text.slice(-awaiting.redline.length)).toStrictEqual(
      awaiting.redline.map(({ text: line }) => line),
    );
  });

  it('a rejection with a comment sends the redline back, and the revised redline pauses again', async () => {
    const workspace = reviewWorkspace(reviewer());
    const first = await paused(workspace);

    const comment = '反社条項は標準文言のままで';
    const second = await decideReview(workspace.aw, first, { approve: false, comment });
    expect(workspace.runs[1]).toMatchObject({
      prompt: `rejected: ${comment}`,
      sessionId: first.sessionId,
      approvedToolCalls: [],
    });
    expect(second.status).toBe('awaiting_legal');
    if (second.status !== 'awaiting_legal') return;
    expect(second.runId).not.toBe(first.runId);
    expect(second.redline).not.toStrictEqual(first.redline);
    expect(second.redline.at(-1)?.text).toContain(`（${comment}）`);
    expect((await workspace.aw.runs.get(second.runId)).status).toBe('awaiting_approval');
    for (const entry of workspace.runs) {
      expect(await workspace.aw.runs.outputs(entry.id)).toStrictEqual([]);
    }

    // Approving the revised redline builds the Word file from it.
    const outcome = await decideReview(workspace.aw, second, { approve: true });
    expect(outcome.status).toBe('reviewed');
    if (outcome.status !== 'reviewed') return;
    expect(readDocx(Buffer.from(outcome.redline.bytes)).paragraphs.at(-1)?.text).toContain(
      `（${comment}）`,
    );
  });

  it('a second decision on the same run is refused with 409 run_not_awaiting_approval', async () => {
    const workspace = reviewWorkspace(reviewer());
    const awaiting = await paused(workspace);
    await decideReview(workspace.aw, awaiting, { approve: true });

    // The paused run was decided once; a second decision finds nothing to decide.
    await expect(decideReview(workspace.aw, awaiting, { approve: true })).rejects.toMatchObject({
      status: 409,
      code: 'run_not_awaiting_approval',
    });
    await expect(
      decideReview(workspace.aw, awaiting, { approve: false, comment: 'やはり直す' }),
    ).rejects.toMatchObject({ status: 409, code: 'run_not_awaiting_approval' });
    expect(workspace.runs).toHaveLength(2);
  });

  it('the backend refuses an approved review when the agent wrote no Word file, or one that leaves out a must-flag', async () => {
    expect(await approved(reviewWorkspace(reviewer([], 'none')))).toMatchObject({
      status: 'refused',
      missing: [],
      redlineMissing: [],
      problems: ['outputs/業務委託契約書_株式会社ミナトシステムズ案_修正案.docx を書いていません'],
    });

    // A Word file with no 【修正案】 paragraph, or one that does not open at all, carries no proposal.
    const rules = ['PB-01', 'PB-03', 'PB-04', 'PB-05', 'PB-06'];
    for (const docx of ['bare', 'broken'] as const) {
      expect(await approved(reviewWorkspace(reviewer([], docx)))).toMatchObject({
        status: 'refused',
        missing: [],
        redlineMissing: rules.map((rule) => ({ rule })),
      });
    }
  });

  it('the backend refuses an approved review listing the must-flag findings the table left out', async () => {
    // The model forgets the absent 反社 clause and the auto-renewal; PB-08 is not a must-flag.
    const refused = await approved(reviewWorkspace(reviewer(['PB-06', 'PB-05', 'PB-08'])));
    expect(refused).toMatchObject({
      status: 'refused',
      missing: [
        { rule: 'PB-05', clause: '第8条' },
        { rule: 'PB-06', clause: null },
      ],
      redlineMissing: [],
      problems: [
        '〔PB-05〕第8条 のリスク表の行がありません',
        '〔PB-06〕欠落 のリスク表の行がありません',
      ],
    });
  });

  it('the backend shows legal nothing when the run ends without the redline, pauses on another file, or fails its rows', async () => {
    const request = requestOf(SERVICE_AGREEMENT);
    const redlineFile = `drafts/${SERVICE_AGREEMENT.team}/${path.basename(SERVICE_AGREEMENT.file, '.docx')}_修正案.json`;
    const refusedWith = async (script: DraftScript) => {
      const workspace = reviewWorkspace(script);
      return reviewContract(workspace.aw, workspace.agentId, request);
    };

    expect(
      await refusedWith((_context, file) => Promise.resolve(writeReview(file, [], (rows) => rows))),
    ).toMatchObject({
      status: 'refused',
      problems: ['エージェントが修正案を書かずに終わりました'],
    });
    expect(
      await refusedWith(async ({ native }) => {
        await native('Write', { file_path: 'drafts/other.json', content: '{}' });
        return 'unreachable';
      }),
    ).toMatchObject({
      status: 'refused',
      problems: [`Write が ${redlineFile} 以外を書こうとして止まった`],
    });
    expect(
      await refusedWith(async ({ native }) => {
        await native('Write', { file_path: redlineFile, content: 'not json' });
        return 'unreachable';
      }),
    ).toMatchObject({ status: 'refused', problems: [`${redlineFile} が JSON ではない`] });
    expect(
      await refusedWith(async ({ native }) => {
        await native('Write', { file_path: redlineFile, content: '{"paragraphs":[]}' });
        return 'unreachable';
      }),
    ).toMatchObject({
      status: 'refused',
      problems: [expect.stringContaining('paragraphs') as unknown],
    });

    // An answer without the rows is not a review the backend can check: the platform fails the run,
    // and the backend surfaces that.
    const silent = scriptedWorkspace(() => Promise.resolve('問題は見当たりませんでした。'));
    const failure: unknown = await reviewContract(
      silent.aw,
      silent.agentId,
      requestOf(SUPPLY_AGREEMENT),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunDidNotComplete);
    expect(failure instanceof RunDidNotComplete ? failure.run : null).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/^output_schema_unsatisfied: /u) as unknown,
    });
  });

  it('the backend still reports a downgraded must-flag and a rule the playbook does not have, from typed rows', async () => {
    const workspace = reviewWorkspace(
      reviewer([], 'redlined', (rows) => [
        // The 準拠法 row covers the must-flag but rates it 低 against the playbook's 高.
        ...rows.map((row) => (row.rules.includes('PB-02') ? { ...row, risk: '低' as const } : row)),
        ...rows.slice(0, 1).map((row) => ({ ...row, rules: ['PB-99'] })),
      ]),
    );
    const review = await approved(workspace, requestOf(NDA));
    expect(review.status).toBe('reviewed');
    if (review.status !== 'reviewed') return;
    expect(review.downgraded.map(({ row, finding }) => [row.risk, finding.severity])).toStrictEqual(
      [['低', '高']],
    );
    expect(review.unknownRules).toStrictEqual(['PB-99']);
  });
}
