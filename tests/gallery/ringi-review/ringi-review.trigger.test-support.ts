import { expect, it } from 'vitest';

import { scriptedWorkspace } from '../harness/scripted-workspace.ts';
import { readRun } from '../shared/run-answer.ts';
import { RINGI_TRIGGER, reviewRun } from './backend/review-run.ts';
import { ReviewSheetSchema } from './backend/review-sheet.ts';
import {
  CONNECTOR_ID,
  CONVEYOR,
  SUBMITTER,
  access,
  authority,
  builtins,
  matrix,
  reviewer,
} from './ringi-review.fixture.test-support.ts';

export function defineTriggerCases(): void {
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
}
