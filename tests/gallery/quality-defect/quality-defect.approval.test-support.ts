import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { analyseDefect, decideCase, DraftNotReady } from './backend/analyse.ts';
import {
  SAMPLE,
  QA_LEAD,
  type Defect,
  BURR,
  qmsGateway,
  asPerson,
  qms,
  registrations,
  answerOf,
  qualityWorkspace,
  pausedOn,
  registeredOf,
  registrationFor,
  followInstructions,
} from './quality-defect.fixture.test-support.ts';

export function defineApprovalCases(): void {
  it('the backend pauses on registering the case, and approving it registers the case under the same subject', async () => {
    const workspace = qualityWorkspace(followInstructions());
    const lead = await asPerson(QA_LEAD);
    const before = registrations();

    // The DR reads the draft; nothing is in the QMS while the run waits.
    const awaiting = await pausedOn(workspace);
    expect(awaiting.status).toBe('awaiting_approval');
    expect(awaiting.readyForReview).toBe(true);
    expect(workspace.runs).toHaveLength(1);
    expect(registrations()).toBe(before);

    // The DR approves; the continuation is the same session and subject, and makes the same call.
    const outcome = registeredOf(await decideCase(workspace.aw, awaiting, { approve: true }));
    expect(workspace.runs[1]).toMatchObject({
      prompt: 'approved',
      sessionId: workspace.runs[0]?.sessionId,
      subject: QA_LEAD,
      approvedToolCalls: [{ toolName: 'mcp__qms__createCase' }],
    });
    expect(outcome.sessionId).toBe(awaiting.sessionId);
    expect(outcome.answer).toBe(awaiting.answer);
    expect(outcome.registration).toStrictEqual(awaiting.registration);
    expect(outcome.caseId).toMatch(/^Q-\d{4}$/u);
    expect(registrations()).toBe(before + 1);
    expect(qms.requests.at(-1)).toMatchObject({ method: 'POST', by: QA_LEAD });

    // The number is the QMS's, and the case is now a 過去トラ the next search reads.
    const record = await qmsGateway().callJson<Defect>('getDefect', { qNo: outcome.caseId }, lead);
    expect(record).toMatchObject({
      partNo: 'BRK-2201',
      process: 'プレス',
      causeCode: '金型摩耗',
      fourM: '機械',
    });
  });

  it('a DR comment rejects the registration, and the revised 8D pauses again', async () => {
    const workspace = qualityWorkspace(followInstructions());
    const before = registrations();
    const first = await pausedOn(workspace);
    const comment = '暫定対策に金型の研磨後ショット数の確認を加えること';

    const second = await decideCase(workspace.aw, first, { approve: false, comment });
    expect(workspace.runs[1]).toMatchObject({
      prompt: `rejected: ${comment}`,
      sessionId: first.sessionId,
      approvedToolCalls: [],
    });
    if (second.status !== 'awaiting_approval')
      throw new Error(`expected a pause: ${second.status}`);
    expect(second.runId).not.toBe(first.runId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.draft?.sections.find((section) => section.id === 'D3')?.body).toContain(
      '研磨後ショット数',
    );
    // The revised draft is checked again, and still nothing is registered.
    expect(second.readyForReview).toBe(true);
    expect((await workspace.aw.runs.get(second.runId)).status).toBe('awaiting_approval');
    expect(registrations()).toBe(before);

    // Approving the revised 8D registers that one.
    const outcome = registeredOf(await decideCase(workspace.aw, second, { approve: true }));
    expect(outcome.registration.report).toContain('研磨後ショット数');
    expect(registrations()).toBe(before + 1);
  });

  it('a second decision on the same run is refused with 409 run_not_awaiting_approval', async () => {
    const workspace = qualityWorkspace(followInstructions());
    const awaiting = await pausedOn(workspace);
    registeredOf(await decideCase(workspace.aw, awaiting, { approve: true }));

    // The paused run was decided once; a second decision finds nothing to decide.
    await expect(decideCase(workspace.aw, awaiting, { approve: true })).rejects.toMatchObject({
      status: 409,
      code: 'run_not_awaiting_approval',
    });
    await expect(
      decideCase(workspace.aw, awaiting, { approve: false, comment: 'やはり直す' }),
    ).rejects.toMatchObject({ status: 409, code: 'run_not_awaiting_approval' });
    expect(workspace.runs).toHaveLength(2);
  });

  it('the backend does not let the DR approve a draft that failed its checks, a blank rejection, or a registration of another part', async () => {
    // A draft with no D6 is paused on like any other, but its approval is refused with the findings.
    const broken = qualityWorkspace(async (context) => {
      const sample = await readFile(SAMPLE, 'utf8');
      const report = sample.replace(/^## D6[\s\S]*?(?=^## D7)/mu, '');
      await context.tool('qms', 'createCase', { body: registrationFor(report) });
      return answerOf(report);
    });
    const awaiting = await pausedOn(broken);
    expect(awaiting.readyForReview).toBe(false);
    await expect(decideCase(broken.aw, awaiting, { approve: true })).rejects.toBeInstanceOf(
      DraftNotReady,
    );
    // Nothing was decided: the run is still paused, and a rejection needs the DR's words.
    await expect(
      decideCase(broken.aw, awaiting, { approve: false, comment: ' ' }),
    ).rejects.toMatchObject({
      fields: ['comment'],
    });
    expect(broken.runs).toHaveLength(1);
    expect((await broken.aw.runs.get(awaiting.runId)).status).toBe('awaiting_approval');

    // A registration of another part than the one QA entered is not shown to the DR as this defect's.
    const other = qualityWorkspace(async (context) => {
      const report = await readFile(SAMPLE, 'utf8');
      await context.tool('qms', 'createCase', {
        body: { ...registrationFor(report), partNo: 'ASY-6001' },
      });
      return answerOf(report);
    });
    const refused = await analyseDefect(other.aw, other.agentId, BURR, QA_LEAD);
    expect(refused).toMatchObject({
      status: 'refused',
      problems: ['partNo が入力した不具合と違う'],
    });
  });
}
