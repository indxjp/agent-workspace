import { readFile } from 'node:fs/promises';

import { canonicalCall } from '@indx-workspace/contracts/agents';
import { expect, it } from 'vitest';

import { createDiagnosisDesk } from './backend/diagnose.ts';
import {
  TECHNICIAN,
  type Logged,
  RESOLUTION,
  store,
  system,
  assertAnswered,
  workspaceFor,
  pressDiagnosis,
} from './maintenance-troubleshooting.fixture.test-support.ts';

/** What the technician types once the strainer is cleaned: the turn that ends in the write. */
const CLEANED = 'ストレーナが詰まっていた。清掃したら21MPaまで上がった';

/** A press session paused on its logResolution call, with the system's request count before it. */
async function pausedOnTheLog() {
  const workspace = workspaceFor(pressDiagnosis);
  const desk = createDiagnosisDesk(workspace.aw, workspace.agentId);
  const first = await desk.start({
    technician: TECHNICIAN,
    message: 'プレス2号機 油圧が上がらない',
  });
  assertAnswered(first);
  const before = system.requests.length;
  const paused = await desk.reply(first.sessionId, CLEANED);
  return { workspace, desk, first, before, paused };
}

export function defineSessionCases(): void {
  it('a three-turn diagnosis reads each turn as typed output, ends resolved and the approved logResolution call writes the resolution', async () => {
    const workspace = workspaceFor(pressDiagnosis);
    const desk = createDiagnosisDesk(workspace.aw, workspace.agentId);

    const first = await desk.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない。圧力計が8MPaで止まる',
    });
    assertAnswered(first);
    expect(first.reply.startsWith('【安全】')).toBe(true);
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['reply', 'kind', 'step', 'citations'],
      properties: {
        kind: { enum: ['step', 'resolution'] },
        step: { anyOf: [{ required: ['number', 'instruction', 'citations'] }, { type: 'null' }] },
      },
    });
    expect(first).toMatchObject({ kind: 'step', step: 1, ok: true, violations: [] });
    expect(first.citations.map((citation) => citation.raw)).toStrictEqual([
      'AP-200 設備マニュアル p.12 §2.1',
      '過去トラ T-0001',
    ]);
    // The run is started for this technician, and the prompt is what they typed, nothing more.
    expect(workspace.runs[0]).toMatchObject({
      subject: TECHNICIAN,
      prompt: 'プレス2号機 油圧が上がらない。圧力計が8MPaで止まる',
    });

    const second = await desk.reply(
      first.sessionId,
      '油面は上限と下限の間。ポンプからガラガラ音がする',
    );
    assertAnswered(second);
    expect(second).toMatchObject({ kind: 'step', step: 2, ok: true });
    expect(second.citations.map((citation) => citation.raw)).toStrictEqual([
      '過去トラ T-0003',
      '熟練者メモ 山本 §2',
    ]);

    // The third turn ends in the write, so it pauses; the technician approves and the continuation
    // is the resolution.
    const paused = await desk.reply(first.sessionId, CLEANED);
    expect(paused).toMatchObject({ status: 'awaiting_approval' });
    const third = await desk.approve(first.sessionId, { approve: true });
    assertAnswered(third);
    expect(third).toMatchObject({ kind: 'resolution', step: null, ok: true });
    expect(third.logged).toMatchObject({
      id: 'T-0027',
      machineId: 'PR-02',
      technician: TECHNICIAN,
    });

    // One session across the four runs, and the record is in the store for the expert to review.
    expect(new Set(workspace.runs.map((run) => run.sessionId)).size).toBe(1);
    expect(desk.session(first.sessionId).status).toBe('resolved');
    const written = JSON.parse(await readFile(store, 'utf8')) as Logged[];
    expect(written).toMatchObject([{ id: 'T-0027', reviewed: false, durationMin: 80 }]);
    await expect(desk.reply(first.sessionId, 'ありがとう')).rejects.toMatchObject({
      code: 'session_closed',
    });
  });

  it('the desk pauses on the logResolution call and, once the technician approves, the continuation logs the resolution for them and resolves the session', async () => {
    // Nobody has approved the call, so the turn is a typed pause and nothing reaches the system.
    const { workspace, desk, first, before, paused } = await pausedOnTheLog();
    if (!('status' in paused)) throw new Error('the turn was answered, not paused');
    expect(paused.call).toStrictEqual({
      toolName: 'mcp__maintenance__logResolution',
      canonicalCall: canonicalCall('mcp__maintenance__logResolution', { body: RESOLUTION }),
    });
    expect(system.requests).toHaveLength(before);
    expect(desk.session(first.sessionId).status).toBe('diagnosing');

    // Approved: the continuation, in the same session and for the same technician, logs exactly it.
    const resolved = await desk.approve(first.sessionId, { approve: true });
    assertAnswered(resolved);
    expect(resolved).toMatchObject({ kind: 'resolution', ok: true, message: 'approved' });
    expect(resolved.logged).toMatchObject({ machineId: 'PR-02', technician: TECHNICIAN });
    expect(desk.session(first.sessionId).status).toBe('resolved');
    expect(workspace.runs.at(-1)).toMatchObject({
      prompt: 'approved',
      sessionId: first.sessionId,
      subject: TECHNICIAN,
      approvedToolCalls: [{ toolName: 'mcp__maintenance__logResolution' }],
    });
    expect(system.requests.slice(before)).toMatchObject([
      { method: 'POST', path: '/api/v1/resolutions', body: RESOLUTION },
    ]);
    // The decision is spent: there is nothing left to approve.
    await expect(desk.approve(first.sessionId, { approve: true })).rejects.toMatchObject({
      code: 'nothing_to_approve',
    });
  });

  it('a rejected logResolution call logs nothing, and the continuation hands the session to the expert with the technician’s comment', async () => {
    const { workspace, desk, first, before, paused } = await pausedOnTheLog();
    expect(paused).toMatchObject({ status: 'awaiting_approval' });

    const rejected = await desk.approve(first.sessionId, {
      approve: false,
      comment: '原因がまだ確定していない',
    });
    assertAnswered(rejected);
    expect(rejected).toMatchObject({
      kind: 'escalation',
      logged: null,
      message: 'rejected: 原因がまだ確定していない',
    });
    expect(desk.session(first.sessionId).status).toBe('escalated');
    expect(workspace.runs.at(-1)?.approvedToolCalls).toStrictEqual([]);
    expect(system.requests).toHaveLength(before);
  });
}
