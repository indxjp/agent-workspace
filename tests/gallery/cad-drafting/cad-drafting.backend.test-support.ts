import { readDxf } from '@agent-workspace/skills-office/office-reader/scripts/dxf.mjs';
import { expect, it } from 'vitest';

import { decideDraft, proposeDraft, type Requirements } from './backend/draft.ts';
import { draft, summarise, type ChangeSet } from './skills/dxf-draft/scripts/dxf.mjs';
import {
  REQUIREMENTS,
  changeSetFor,
  designer,
  desk,
  deskOf,
  drawingOf,
  proposed,
} from './cad-drafting.fixture.test-support.ts';

export function defineBackendCases(): void {
  it('the backend pauses on the change set before anything is drawn, and drafts it once approved, marked 未検図', async () => {
    const workspace = desk(designer());
    const proposal = await proposed(workspace);
    expect(workspace.runs[0]?.prompt).toContain('外形: 幅 140 × 高さ 90 mm');
    expect(workspace.runs[0]?.outputSchema).toBeNull();
    // The pause carries the agent's change set from the Write, validated: only height and holes changed.
    expect(proposal.call.toolName).toBe('Write');
    expect(Object.keys(proposal.changeSet).sort()).toStrictEqual([
      'base',
      'drawingNo',
      'height',
      'holes',
      'width',
    ]);
    expect(proposal.changeSet.base).toBe('BRK-1003');

    // The designer approves; the continuation is the same session and the same Write.
    const outcome = await decideDraft(workspace.aw, proposal, { approve: true });
    expect(workspace.runs[1]).toMatchObject({
      prompt: 'approved',
      sessionId: workspace.runs[0]?.sessionId,
      approvedToolCalls: [{ toolName: 'Write' }],
    });
    expect(outcome.status).toBe('ready-for-check');
    if (outcome.status !== 'ready-for-check') return;
    expect(outcome.sessionId).toBe(proposal.sessionId);
    expect(outcome.changeSet).toStrictEqual(proposal.changeSet);
    expect(summarise(readDxf(Buffer.from(outcome.dxf)))).toMatchObject({
      drawingNo: 'BRK-1101',
      width: 140,
      height: 90,
      status: '未検図',
      derivedFrom: 'BRK-1003',
    });
    expect(outcome.summary.title['作成']).toBe('2026-10-04 高橋');
  });

  it('a rejection that names another base sends it back, and the revised change set pauses again', async () => {
    const workspace = desk(designer());
    const first = await proposed(workspace);
    expect(first.changeSet.base).toBe('BRK-1003');

    const second = await decideDraft(workspace.aw, first, {
      approve: false,
      comment: 'BRK-1004 を元に',
    });
    expect(workspace.runs[1]).toMatchObject({
      prompt: 'rejected: BRK-1004 を元に',
      approvedToolCalls: [],
    });
    expect(second.status).toBe('awaiting_approval');
    if (second.status !== 'awaiting_approval') return;
    expect(second.changeSet.base).toBe('BRK-1004');
    expect(second.runId).not.toBe(first.runId);
    expect((await workspace.aw.runs.get(second.runId)).status).toBe('awaiting_approval');
    expect(await workspace.aw.runs.outputs(second.runId)).toStrictEqual([]);

    // The script refuses a notched outline it would have to stretch: the agent writes no file, and
    // the backend refuses rather than draw one itself.
    const notched = await decideDraft(workspace.aw, second, { approve: true });
    expect(notched).toMatchObject({
      status: 'refused',
      problems: ['エージェントが outputs/BRK-1101.dxf を書いていません'],
    });
    if (notched.status !== 'refused') return;
    expect(notched.answer).toContain('BRK-1004 の外形は矩形ではありません');
    expect('dxf' in notched).toBe(false);
  });

  it('nothing is drafted before approval, and a rejection drafts nothing', async () => {
    const workspace = desk(designer());
    const proposal = await proposed(workspace);
    expect(workspace.runs).toHaveLength(1);
    expect(workspace.runs[0]?.approvedToolCalls).toStrictEqual([]);
    expect((await workspace.aw.runs.get(proposal.runId)).status).toBe('awaiting_approval');
    expect(await workspace.aw.runs.outputs(proposal.runId)).toStrictEqual([]);

    const revised = await decideDraft(workspace.aw, proposal, {
      approve: false,
      comment: '高さを確認してから',
    });
    expect(revised.status).toBe('awaiting_approval');
    for (const entry of workspace.runs) {
      expect(await workspace.aw.runs.outputs(entry.id)).toStrictEqual([]);
    }
  });

  it('a reference drawing rides on the proposal run as an attachment, and none is sent without one', async () => {
    const workspace = desk(designer());
    const referenceId = 'a0000000-0000-4000-8000-000000000007';

    await proposeDraft(workspace.aw, workspace.agentId, deskOf(), { fileId: referenceId });
    await proposeDraft(workspace.aw, workspace.agentId, deskOf());

    const starts = workspace.calls
      .filter((call) => call.method === 'POST')
      .map((call) => call.json as { prompt: string; attachments?: unknown });
    expect(starts[0]?.attachments).toStrictEqual([{ fileId: referenceId }]);
    expect(starts[0]?.prompt).toContain('外形: 幅 140 × 高さ 90 mm');
    expect(starts[1]).not.toHaveProperty('attachments');
  });

  it('the backend returns the DXF the agent wrote, not one it regenerates', async () => {
    const stamped = (changeSet: ChangeSet): ChangeSet => ({
      ...changeSet,
      drafter: 'エージェント',
      date: '2026-10-05',
    });
    const workspace = desk(designer((changeSet) => changeSet, REQUIREMENTS, stamped));
    const outcome = await decideDraft(workspace.aw, await proposed(workspace), { approve: true });
    expect(outcome.status).toBe('ready-for-check');
    if (outcome.status !== 'ready-for-check') return;
    // Regenerating from the requirements would stamp 2026-10-04 高橋; these are the agent's bytes.
    const [written] = await workspace.aw.runs.outputs(workspace.runs[1]?.id ?? '');
    expect(written?.name).toBe('BRK-1101.dxf');
    expect(outcome.dxf).toBe(
      draft(
        await drawingOf('BRK-1003'),
        stamped(changeSetFor(REQUIREMENTS, summarise(await drawingOf('BRK-1003')))),
      ).dxf,
    );
    expect(outcome.summary.title['作成']).toBe('2026-10-05 エージェント');
  });

  it('the backend refuses a DXF the agent wrote that does not parse, instead of throwing', async () => {
    const script = designer();
    const workspace = desk((context) =>
      script({ ...context, write: (name) => context.write(name, 'not a dxf') }),
    );
    const outcome = await decideDraft(workspace.aw, await proposed(workspace), { approve: true });
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.problems).toHaveLength(1);
    expect(outcome.problems[0]).toMatch(/^outputs\/BRK-1101\.dxf を図面として読めません: /u);
  });

  it('the backend validates the change set in the paused Write and refuses one that invents a dimension before anyone approves it', async () => {
    const workspace = desk(designer((changeSet) => ({ ...changeSet, width: 145 })));
    const outcome = await proposeDraft(workspace.aw, workspace.agentId, deskOf());
    // The run asks for no schema: the change set is the Write's content, untrusted until validated.
    expect(workspace.runs[0]?.outputSchema).toBeNull();
    expect(outcome).toMatchObject({
      status: 'refused',
      changeSet: { width: 145 },
      runId: workspace.runs[0]?.id,
    });
    if (outcome.status !== 'refused') return;
    expect(outcome.problems[0]).toBe('幅: 要件は 140、作図は 145');
    expect(workspace.runs).toHaveLength(1);
  });

  it('the backend refuses a paused Write that is not the change set, whatever it holds', async () => {
    const paused = async (write: Record<string, unknown>) => {
      const workspace = desk(async ({ native }) => {
        await native('Write', write);
        return 'unreachable';
      });
      return proposeDraft(workspace.aw, workspace.agentId, deskOf());
    };
    const file = 'drafts/BRK-1101.changes.json';
    const base = summarise(await drawingOf('BRK-1003'));
    const good = changeSetFor(REQUIREMENTS, base);

    expect(await paused({ file_path: 'drafts/other.json', content: '{}' })).toMatchObject({
      status: 'refused',
      problems: [`Write が ${file} 以外を書こうとして止まった`],
    });
    expect(await paused({ file_path: file, content: 'not json' })).toMatchObject({
      status: 'refused',
      problems: [`${file} が JSON ではない`],
    });
    expect(await paused({ file_path: file, content: '{"base":"BRK-1003"}' })).toMatchObject({
      status: 'refused',
      changeSet: null,
    });
    // A path is not a drawing number: the schema refuses it before anything is read.
    const asPath = await paused({
      file_path: file,
      content: JSON.stringify({ ...good, base: 'drawings/BRK/BRK-1003.dxf' }),
    });
    expect(asPath).toMatchObject({ status: 'refused', changeSet: null });
    // A well-formed number the store does not hold is invented too.
    expect(
      await paused({ file_path: file, content: JSON.stringify({ ...good, base: 'BRK-9999' }) }),
    ).toMatchObject({ status: 'refused', problems: ['BRK-9999 は図面庫にありません'] });
  });

  it('the backend refuses a draft that invents a dimension, stretches a notched outline or loses a hole', async () => {
    // The model writes 145 where the designer asked for 140, and moves a hole.
    const sloppy = desk(
      designer((changeSet) => ({
        ...changeSet,
        width: 145,
        holes: (changeSet.holes ?? []).map((hole, at) => (at === 1 ? { ...hole, x: 130 } : hole)),
      })),
    );
    const invented = await proposeDraft(sloppy.aw, sloppy.agentId, deskOf());
    expect(invented).toMatchObject({ status: 'refused' });
    if (invented.status !== 'refused') return;
    expect(invented.problems[0]).toBe('幅: 要件は 140、作図は 145');
    expect(invented.problems[1]).toMatch(/^取付穴: 要件・元図にない穴があります/u);

    // A requirement whose hole would cut the edge is refused before anyone is asked to approve.
    const cutting: Requirements = {
      ...REQUIREMENTS,
      holes: {
        diameter: 11,
        positions: [
          { x: 15, y: 15 },
          { x: 136, y: 15 },
        ],
      },
    };
    const edgeWorkspace = desk(designer((changeSet) => changeSet, cutting));
    const edge = await proposeDraft(edgeWorkspace.aw, edgeWorkspace.agentId, deskOf(cutting));
    expect(edge).toMatchObject({
      status: 'refused',
      problems: ['穴2 (136, 15) φ11: 外形 140×90 からはみ出します'],
    });

    // A DXF whose width is not what the change set says (the file is what is delivered) is refused.
    const wrongFile = desk(
      designer(
        (changeSet) => changeSet,
        REQUIREMENTS,
        (changeSet) => ({ ...changeSet, width: 145 }),
      ),
    );
    const stretched = await decideDraft(wrongFile.aw, await proposed(wrongFile), {
      approve: true,
    });
    expect(stretched).toMatchObject({ status: 'refused' });
    if (stretched.status !== 'refused') return;
    expect(stretched.problems).toContain('幅: 要件は 140、作図は 145');

    // An answer with no change set is not guessed at: there is nothing to approve.
    const silent = desk(() => Promise.resolve('作図しました。'));
    expect(await proposeDraft(silent.aw, silent.agentId, deskOf())).toMatchObject({
      status: 'refused',
      problems: ['エージェントが変更セットを書かずに終わりました'],
      changeSet: null,
    });
  });
}
