import { canonicalCall } from '@indx-workspace/contracts/agents';
import { createClient } from '@indx-workspace/sdk';
import { fetchDouble } from '@indx-workspace/sdk/testing';
import { expect, it } from 'vitest';

import { RunDidNotComplete } from '../shared/run-answer.ts';
import {
  createDiagnosisDesk,
  DiagnosisError,
  inspectTurn,
  type DiagnosisSession,
} from './backend/diagnose.ts';
import { submitExpertReview } from './backend/review.ts';
import {
  TECHNICIAN,
  EXPERT,
  RESOLUTION,
  system,
  assertAnswered,
  workspaceFor,
  pressDiagnosis,
  flaggedWorkspace,
  unapprovedWorkspace,
  bareWorkspace,
  UNSAFE_FIRST_TURN,
  stepless,
  handoffWorkspace,
} from './maintenance-troubleshooting.fixture.test-support.ts';

export function defineCheckCases(): void {
  it('a turn with two steps, an uncited step or an unlogged resolution is flagged, and an answer without the fields fails the run', async () => {
    const workspace = flaggedWorkspace();
    const desk = createDiagnosisDesk(workspace.aw, workspace.agentId);

    const first = await desk.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない',
    });
    assertAnswered(first);
    expect(first.ok).toBe(false);
    expect(first.violations).toStrictEqual(['multiple-steps', 'uncited-step']);

    const second = await desk.reply(first.sessionId, '直った');
    assertAnswered(second);
    expect(second).toMatchObject({ kind: 'resolution', logged: null, ok: false });
    expect(second.violations).toStrictEqual(['resolution-not-logged']);
    // An unlogged "resolution" does not close the session.
    expect(desk.session(first.sessionId).status).toBe('diagnosing');

    // A real run's logResolution call nobody has approved yet pauses the run: the turn is a typed
    // pause with the run id, nothing reaches the maintenance system, and the session stays open.
    const before = system.requests.length;
    const unapproved = unapprovedWorkspace();
    const strictDesk = createDiagnosisDesk(unapproved.aw, unapproved.agentId);
    const opened = await strictDesk.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない',
    });
    assertAnswered(opened);
    const paused = await strictDesk.reply(opened.sessionId, '直った');
    expect(paused).toMatchObject({
      status: 'awaiting_approval',
      runId: unapproved.runs[1]?.id,
      sessionId: opened.sessionId,
      call: {
        toolName: 'mcp__maintenance__logResolution',
        canonicalCall: canonicalCall('mcp__maintenance__logResolution', { body: RESOLUTION }),
      },
    });
    expect(system.requests).toHaveLength(before);
    expect(strictDesk.session(opened.sessionId)).toMatchObject({ status: 'diagnosing' });
    expect(strictDesk.session(opened.sessionId).turns).toHaveLength(1);

    // The rest of the rules, on the pure check.
    const noSafety = inspectTurn(UNSAFE_FIRST_TURN);
    expect(noSafety.violations).toStrictEqual([
      'missing-safety',
      'step-out-of-order',
      'unverified-citation',
    ]);
    expect(inspectTurn(stepless('圧力計を見てください。', null)).violations).toStrictEqual([
      'no-step',
    ]);
    // The run's handoff frame, not the agent's own label, makes a turn an escalation.
    expect(
      inspectTurn(stepless('熟練者に引き継ぎます。', '既知の原因では解決しませんでした')),
    ).toMatchObject({ kind: 'escalation', violations: [] });
    await expect(desk.start({ technician: ' ', message: 'x' })).rejects.toBeInstanceOf(
      DiagnosisError,
    );

    // A bare text answer has no kind and no step for the backend to check: the platform fails the
    // run, and the desk surfaces that instead of guessing from the text.
    const bare = bareWorkspace();
    await expect(
      createDiagnosisDesk(bare.aw, bare.agentId).start({
        technician: TECHNICIAN,
        message: 'プレス2号機 油圧が上がらない',
      }),
    ).rejects.toBeInstanceOf(RunDidNotComplete);
  });

  it('after the known causes the agent hands the session to the expert, from the agent.handoff frame, and it takes no more steps', async () => {
    const workspace = handoffWorkspace();
    const notified: DiagnosisSession[] = [];
    const desk = createDiagnosisDesk(workspace.aw, workspace.agentId, {
      notifyExpert: (session) => {
        notified.push(session);
      },
    });

    const first = await desk.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない',
    });
    const second = await desk.reply(
      first.sessionId,
      '油面は正常。ストレーナもリリーフ弁も清掃済み',
    );
    expect(second).toMatchObject({ kind: 'escalation', ok: true });
    expect(notified).toHaveLength(1);
    expect(notified[0]?.escalation?.reason).toBe('agent');
    expect(notified[0]?.escalation?.summary).toContain('手順1：油面計を確認してください。');
    expect(notified[0]?.escalation?.summary).toContain('→ 結果: 油面は正常');
    expect(notified[0]?.escalation?.summary).toContain(
      '引継ぎ理由: 既知の原因では解決しませんでした',
    );
    await expect(desk.reply(first.sessionId, 'まだ？')).rejects.toMatchObject({
      code: 'session_closed',
    });

    // The backend's own stop: a desk that allows one step escalates on the second by itself.
    const press = workspaceFor(pressDiagnosis);
    const strict = createDiagnosisDesk(press.aw, press.agentId, {
      maxSteps: 1,
      notifyExpert: (session) => {
        notified.push(session);
      },
    });
    const opened = await strict.start({
      technician: TECHNICIAN,
      message: 'プレス2号機 油圧が上がらない',
    });
    const over = await strict.reply(opened.sessionId, '油面は正常。ポンプからガラガラ音がする');
    expect(over).toMatchObject({ kind: 'step', step: 2, ok: true });
    expect(strict.session(opened.sessionId).status).toBe('escalated');
    expect(notified[1]?.escalation?.reason).toBe('step-limit');
  });

  it('an expert correction is sent as run feedback that aw eval add-case turns into a case', async () => {
    const api = fetchDouble(() => new Response(null, { status: 204 }));
    const aw = createClient({
      baseUrl: 'https://workspace.example.co.jp',
      auth: { kind: 'api-key', apiKey: 'aw_test_gallery' },
      fetch: api.fetch,
    });
    const runId = '0b9f5d0a-0000-4000-8000-000000000009';
    const comment = await submitExpertReview(aw, {
      runId,
      expert: EXPERT,
      correct: false,
      correction: 'ガラガラ音なら油面の次はストレーナ。リリーフ弁を先に触らせない。',
    });
    expect(api.calls[0]?.url.pathname).toBe(`/api/runs/${runId}/feedback`);
    expect(api.calls[0]?.json).toStrictEqual({ rating: 'down', comment });
    expect(comment).toContain('熟練者訂正（山本 浩二）');
    await expect(
      submitExpertReview(aw, { runId, expert: EXPERT, correct: false }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
}
