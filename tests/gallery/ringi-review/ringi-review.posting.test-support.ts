import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalCall } from '@indx-workspace/contracts/agents';
import {
  selectAllowedOperations,
  toolApprovalRules,
  toolServerKey,
} from '@indx-workspace/contracts/tool-connectors';
import { toolDefinitionsOf } from '@indx-workspace/sdk/define';
import { expect, it } from 'vitest';

import { openapiGateway, operationsOf, type OpenApiDocument } from '../harness/openapi-gateway.ts';
import { decidePost, postReview, reviewRun } from './backend/review-run.ts';
import agentDefinition from './agents/ringi-review.ts';
import { workflow as workflowTool } from './tools/workflow.ts';
import {
  CONVEYOR,
  DIR,
  SUBMITTER,
  WORKFLOW_TOKEN,
  asPersonAtWorkflow,
  hook,
  reviewer,
  workflowSystem,
} from './ringi-review.fixture.test-support.ts';

export function definePostingCases(): void {
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
}
