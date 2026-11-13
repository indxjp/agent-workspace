import { expect, it } from 'vitest';

import { scriptedWorkspace } from '../harness/scripted-workspace.ts';
import { chat, chatFromRun, GUARD_REASON, INBOUND_MAIL_TRIGGER } from './backend/chat.ts';
import { answer, HANDOFF_PHRASE, workspaceFor } from './customer-inquiry.fixture.test-support.ts';

export function defineBackendCases(): void {
  it('the backend answers from the history and keeps the same session for the follow-up', async () => {
    const workspace = workspaceFor();
    const first = await chat(workspace.aw, workspace.agentId, {
      customerId: 'C-1001',
      message: '保温マグが届かない',
    });
    expect(first).toMatchObject({ handoff: false, reason: null, withheld: null });
    expect(first.text).toContain('6月上旬発送予定');
    expect(first.interactionsRead).toStrictEqual(['INQ-0136']);
    expect(first.queries).toStrictEqual(['保温マグが届かない']);
    // Who is asking is the run's subject; the prompt is the customer's words: no id, no token.
    expect(workspace.runs[0]).toMatchObject({ subject: 'C-1001', prompt: '保温マグが届かない' });

    const followUp = await chat(workspace.aw, workspace.agentId, {
      customerId: 'C-1001',
      message: 'ポイントが消えている',
      sessionId: first.sessionId,
    });
    expect(followUp.sessionId).toBe(first.sessionId);
    expect(followUp.text).toContain('表示反映の遅れ');
    const starts = workspace.calls.filter((call) => call.method === 'POST');
    expect(starts.map((call) => (call.json as { sessionId?: unknown }).sessionId)).toStrictEqual([
      null,
      first.sessionId,
    ]);
  });

  it('the backend routes a run the agent handed to a person to the operator queue, from the agent.handoff frame', async () => {
    const workspace = workspaceFor();
    const refund = await chat(workspace.aw, workspace.agentId, {
      customerId: 'C-1003',
      message: '加湿器の代金を返金してください',
    });
    expect(refund).toMatchObject({ handoff: true, reason: '返金のご要望', withheld: null });
    expect(refund.text).toContain(HANDOFF_PHRASE);
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['reply'],
      properties: { reply: { type: 'string' } },
    });

    const complaint = await chat(workspace.aw, workspace.agentId, {
      customerId: 'C-1003',
      message: '対応が遅すぎる。責任者を出して',
    });
    expect(complaint).toMatchObject({ handoff: true, reason: '苦情・責任者のご希望' });
  });

  it('the backend withholds an answer that repeats personal data or promises a refund', async () => {
    const leaky = workspaceFor(() =>
      Promise.resolve(answer('承知しました。お電話 080-1172-5094 にご連絡いたします。')),
    );
    const leaked = await chat(leaky.aw, leaky.agentId, {
      customerId: 'C-1002',
      message: '電話してほしい',
    });
    expect(leaked).toMatchObject({ handoff: true, reason: GUARD_REASON });
    expect(leaked.text).not.toContain('080');
    expect(leaked.withheld?.pii).toStrictEqual([{ kind: 'phone', match: '080-1172-5094' }]);

    const promising = workspaceFor(() =>
      Promise.resolve(answer('大変失礼いたしました。全額を返金いたします。')),
    );
    const promised = await chat(promising.aw, promising.agentId, {
      customerId: 'C-1003',
      message: '返品したのにお金が戻らない',
    });
    expect(promised).toMatchObject({ handoff: true, reason: GUARD_REASON });
    expect(promised.withheld?.refundPromise).toBe(true);
    expect(promised.text).not.toContain('返金いたします');

    // The company's own number is not personal data.
    const publicNumber = workspaceFor(() =>
      Promise.resolve(
        answer('お電話の場合は 0120-555-310（平日10時〜18時）までお願いいたします。'),
      ),
    );
    const allowed = await chat(publicNumber.aw, publicNumber.agentId, {
      customerId: 'C-1002',
      message: '電話で問い合わせたい',
    });
    expect(allowed).toMatchObject({ handoff: false, withheld: null });
  });

  it('a mail parsed by the inbound-parse webhook starts a run whose reply the backend reads as typed output, once per Message-ID', async () => {
    const workspace = scriptedWorkspace(() =>
      Promise.resolve(answer('再発行した納品書を、改めてお送りします。')),
    );
    const created = await workspace.aw.triggers.create({
      ...INBOUND_MAIL_TRIGGER,
      agentId: workspace.agentId,
    });
    if (!('firePath' in created)) throw new Error('a webhook trigger answers its fire path');
    const mail = {
      from: 'tanaka@customer.example.co.jp',
      subject: '納品書の再発行について',
      text: '先月分の納品書を再発行していただけますか。',
    };
    const messageId = '<20261004.0001@mail.customer.example.co.jp>';

    const first = await workspace.fire(created.firePath, mail, { idempotencyKey: messageId });
    const retried = await workspace.fire(created.firePath, mail, { idempotencyKey: messageId });
    expect(first.status).toBe(202);
    expect(retried.run?.id).toBe(first.run?.id);
    expect(workspace.runs).toHaveLength(1);
    expect(workspace.runs[0]?.prompt).toContain('納品書の再発行について');

    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['reply'],
    });

    const reply = await chatFromRun(workspace.aw, first.run?.id ?? '');
    expect(workspace.runs).toHaveLength(1);
    expect(reply).toMatchObject({
      text: '再発行した納品書を、改めてお送りします。',
      handoff: false,
      withheld: null,
      runId: first.run?.id,
    });
  });
}
