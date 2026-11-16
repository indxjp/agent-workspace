import { expect, it } from 'vitest';

import { scriptedWorkspace } from '../harness/scripted-workspace.ts';
import { RunDidNotComplete } from '../shared/run-answer.ts';
import { decideQuote, draftQuote } from './backend/quote.ts';
import {
  awaitingOf,
  bookingOf,
  DRAWING_ID,
  erp,
  quotationModel,
  requestFor,
  SALES_LEAD,
  SPECS,
  workspaceFor,
} from './quotation.fixture.test-support.ts';

export function defineBackendCases(): void {
  it('draftQuote pauses on the checked createQuote and writes nothing; once approved the continuation books it for the asking salesperson', async () => {
    const workspace = workspaceFor(quotationModel(SPECS.bracket));
    const seen = erp.requests.length;
    const awaiting = awaitingOf(
      await draftQuote(workspace.aw, workspace.agentId, requestFor(SPECS.bracket), SALES_LEAD),
    );

    // The person is asked to approve the cost model's numbers beside the spec and the orders read.
    const { proposed } = awaiting;
    expect(proposed.quote).toStrictEqual(bookingOf(SPECS.bracket));
    expect(proposed.breakdown).toMatchObject({ unitPrice: 440, total: 22000 });
    expect(proposed.similarOrders.map((order) => [order.orderNo, order.unitPrice])).toStrictEqual([
      ['SO-2024-0412', 430],
      ['SO-2025-0108', 460],
      ['SO-2025-0377', 380],
    ]);
    expect(proposed.confidence).toBe('high');
    expect(proposed.confidenceReasons[0]).toContain('中央値 430円');
    expect(proposed.spec).toMatchObject({
      drawingNo: 'TWK-M-2231 rev.B',
      customer: '東和機工株式会社',
      quantity: 50,
    });
    // Before the approval the ERP saw reads only: booking waits for the approved createQuote.
    const drafted = erp.requests.slice(seen);
    expect(drafted.every((request) => request.method === 'GET')).toBe(true);
    expect(drafted.map((request) => request.path)).toContain(
      `/api/v1/parts/search?q=${encodeURIComponent('ブラケット')}&material=SS400`,
    );

    // Approve: the continuation, in the same session and for the same salesperson, books it.
    const booked = await decideQuote(workspace.aw, awaiting, { approve: true });
    if (booked.status !== 'booked') throw new Error(`the booking run ${booked.status}`);
    expect(booked.quoteNo).toMatch(/^QT-\d{4}$/u);
    expect(booked.answer).toContain('見積単価 440円');
    expect(booked.sessionId).toBe(awaiting.sessionId);
    expect(booked.runId).not.toBe(awaiting.runId);
    expect(erp.requests.slice(seen).filter((request) => request.method === 'POST')).toStrictEqual([
      { method: 'POST', path: '/api/v1/quotes', body: proposed.quote, by: SALES_LEAD },
    ]);
    expect(workspace.runs.map((run) => run.subject)).toStrictEqual([SALES_LEAD, SALES_LEAD]);

    // The approval is spent: a second decision is a 409, and nothing is booked twice.
    await expect(decideQuote(workspace.aw, awaiting, { approve: true })).rejects.toMatchObject({
      code: 'run_not_awaiting_approval',
    });
    expect(erp.requests.slice(seen).filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('a rejection with a comment sends the agent back and its revised createQuote pauses again, nothing booked', async () => {
    const workspace = workspaceFor(
      quotationModel(SPECS.bracket, undefined, (quote, comment) => ({
        ...quote,
        drawingNo: /図番は (.+?) です/u.exec(comment)?.[1] ?? quote['drawingNo'],
      })),
    );
    const seen = erp.requests.length;
    const first = awaitingOf(
      await draftQuote(workspace.aw, workspace.agentId, requestFor(SPECS.bracket), SALES_LEAD),
    );

    const revised = awaitingOf(
      await decideQuote(workspace.aw, first, {
        approve: false,
        comment: '図番は TWK-M-2231 rev.C です',
      }),
    );
    expect(revised.proposed.quote).toStrictEqual({
      ...first.proposed.quote,
      drawingNo: 'TWK-M-2231 rev.C',
    });
    expect(revised.proposed.breakdown).toStrictEqual(first.proposed.breakdown);
    expect(revised.runId).not.toBe(first.runId);
    expect(revised.sessionId).toBe(first.sessionId);
    expect(erp.requests.slice(seen).some((request) => request.method === 'POST')).toBe(false);

    // The revised call is the one the approval admits.
    const booked = await decideQuote(workspace.aw, revised, { approve: true });
    expect(booked).toMatchObject({ status: 'booked', quote: { drawingNo: 'TWK-M-2231 rev.C' } });
    expect(erp.requests.slice(seen).filter((request) => request.method === 'POST')).toMatchObject([
      { body: { drawingNo: 'TWK-M-2231 rev.C', unitPrice: 440, total: 22000 }, by: SALES_LEAD },
    ]);
  });

  it('a rejection the agent does not revise books nothing, and a revision to other numbers is refused', async () => {
    const seen = erp.requests.length;
    const stops = workspaceFor(quotationModel(SPECS.bracket));
    const stopped = awaitingOf(
      await draftQuote(stops.aw, stops.agentId, requestFor(SPECS.bracket), SALES_LEAD),
    );
    expect(await decideQuote(stops.aw, stopped, { approve: false })).toMatchObject({
      status: 'refused',
      code: 'not_proposed',
    });

    // Sent back for a typo, the agent also takes off 10%: the revision is checked against the cost model.
    const greedy = workspaceFor(
      quotationModel(SPECS.bracket, undefined, (quote) => ({
        ...quote,
        unitPrice: 400,
        total: 20000,
      })),
    );
    const paused = awaitingOf(
      await draftQuote(greedy.aw, greedy.agentId, requestFor(SPECS.bracket), SALES_LEAD),
    );
    const revised = await decideQuote(greedy.aw, paused, {
      approve: false,
      comment: '図番を直して',
    });
    expect(revised).toMatchObject({ status: 'refused', code: 'numbers_differ' });
    expect(revised.status === 'refused' ? revised.detail : '').toContain('unitPrice: 400 ≠ 440');

    expect(erp.requests.slice(seen).some((request) => request.method === 'POST')).toBe(false);
  });

  it('the drawing rides on the quote run as an attachment and the spec reaches the backend as the cost model input', async () => {
    const workspace = workspaceFor(quotationModel(SPECS.bracket));
    const { proposed } = awaitingOf(
      await draftQuote(workspace.aw, workspace.agentId, requestFor(SPECS.bracket), SALES_LEAD),
    );

    const [start] = workspace.calls
      .filter((call) => call.method === 'POST')
      .map((call) => call.json as { prompt: string; attachments?: unknown });
    expect(start?.attachments).toStrictEqual([{ fileId: DRAWING_ID }]);
    // The prompt carries what a drawing does not say, and no spec for the agent to copy.
    expect(start?.prompt).toContain('顧客: 東和機工株式会社');
    expect(start?.prompt).toContain('数量: 50個');
    expect(start?.prompt).not.toContain('```json');
    expect(start?.prompt).not.toContain('TWK-M-2231');
    // The spec in the proposal is the one the agent gave the cost-model script, with the request's
    // customer and quantity.
    expect(proposed.spec).toMatchObject({
      material: 'SS400',
      lengthMm: 200,
      widthMm: 100,
      thicknessMm: 3.2,
      holeCount: 4,
      holeDiameterMm: 10,
      bendCount: 2,
      quantity: 50,
    });
  });

  it('a drawing the agent cannot read into a priceable spec is refused', async () => {
    // The agent read a material the cost model does not price.
    const misread = workspaceFor(
      quotationModel(SPECS.bracket, (draft) => {
        draft.spec['material'] = 'SPCC';
      }),
    );
    const refused = await draftQuote(
      misread.aw,
      misread.agentId,
      requestFor(SPECS.bracket),
      SALES_LEAD,
    );
    expect(refused).toMatchObject({ status: 'refused', code: 'invalid_spec' });
    expect(refused.status === 'refused' ? refused.runId : null).not.toBeNull();
    expect(refused.status === 'refused' ? refused.detail : '').toContain('spec.material');
  });

  it('a request with a bad quantity or a blank customer starts no run', async () => {
    const neverRun = scriptedWorkspace(() => Promise.resolve(''));
    for (const request of [
      { ...requestFor(SPECS.bracket), quantity: 0 },
      { ...requestFor(SPECS.bracket), quantity: 1.5 },
      { ...requestFor(SPECS.bracket), quantity: Number.NaN },
      { ...requestFor(SPECS.bracket), quantity: 100001 },
      { ...requestFor(SPECS.bracket), customer: ' ' },
    ]) {
      expect(await draftQuote(neverRun.aw, neverRun.agentId, request, SALES_LEAD)).toMatchObject({
        status: 'refused',
        code: 'invalid_spec',
        runId: null,
      });
    }
    expect(neverRun.runs).toHaveLength(0);
  });

  it('the backend rates a single past order medium and no past order low', async () => {
    const first = workspaceFor(quotationModel(SPECS.cover));
    const cover = awaitingOf(
      await draftQuote(first.aw, first.agentId, requestFor(SPECS.cover), SALES_LEAD),
    ).proposed;
    expect(cover.breakdown.unitPrice).toBe(1560);
    expect(cover.similarOrders.map((order) => order.orderNo)).toStrictEqual(['SO-2025-0533']);
    expect(cover.confidence).toBe('medium');
    expect(cover.confidenceReasons).toContain('類似実績が1件のみ');

    const workspace = workspaceFor(quotationModel(SPECS.plate));
    const plate = awaitingOf(
      await draftQuote(workspace.aw, workspace.agentId, requestFor(SPECS.plate), SALES_LEAD),
    ).proposed;
    expect(plate.breakdown).toMatchObject({ unitPrice: 1180, total: 8260 });
    expect(plate.similarOrders).toStrictEqual([]);
    expect(plate.confidence).toBe('low');
  });

  it('the booking run asks for a typed answer and the backend refuses a createQuote whose numbers the cost model does not give', async () => {
    const seen = erp.requests.length;
    const workspace = workspaceFor(
      quotationModel(SPECS.bracket, (draft) => {
        // A "friendly" discount for a regular customer, written straight into the booking.
        draft.quote['unitPrice'] = 400;
        draft.quote['total'] = 20000;
      }),
    );
    const outcome = await draftQuote(
      workspace.aw,
      workspace.agentId,
      requestFor(SPECS.bracket),
      SALES_LEAD,
    );
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['spec', 'breakdown', 'similarOrders'],
      properties: { similarOrders: { type: 'array' } },
    });
    expect(outcome).toMatchObject({ status: 'refused', code: 'numbers_differ' });
    expect(outcome.status === 'refused' ? outcome.detail : '').toBe(
      'the call differs from the request and the cost model: unitPrice: 400 ≠ 440; total: 20000 ≠ 22000',
    );
    expect(erp.requests.slice(seen).some((request) => request.method === 'POST')).toBe(false);
  });

  it('the backend refuses numbers without an ERP rate and drops orders the agent never read', async () => {
    const noRate = workspaceFor(async (context) => {
      await context.builtin('run_skill_script', {
        skill: 'cost-model',
        script: 'estimate.mjs',
        args: ['quote', '--spec', JSON.stringify(SPECS.bracket)],
      });
      await context.tool('erp', 'createQuote', { body: bookingOf(SPECS.bracket) });
      return '';
    });
    expect(
      await draftQuote(noRate.aw, noRate.agentId, requestFor(SPECS.bracket), SALES_LEAD),
    ).toMatchObject({
      status: 'refused',
      code: 'rate_not_read',
    });

    const invented = workspaceFor(
      quotationModel(SPECS.cover, (draft) => {
        draft.cited.push('SO-2023-0001', 'SO-2025-0219');
      }),
    );
    const { proposed } = awaitingOf(
      await draftQuote(invented.aw, invented.agentId, requestFor(SPECS.cover), SALES_LEAD),
    );
    expect(proposed.droppedOrders).toStrictEqual(['SO-2023-0001', 'SO-2025-0219']);
    expect(proposed.similarOrders.map((order) => order.orderNo)).toStrictEqual(['SO-2025-0533']);

    // An answer without the typed shape is not a refusal the backend decides: the platform fails the
    // run, and the backend surfaces that.
    const unanswered = scriptedWorkspace(() => Promise.resolve('見積を作成しました。'));
    const failure: unknown = await draftQuote(
      unanswered.aw,
      unanswered.agentId,
      requestFor(SPECS.bracket),
      SALES_LEAD,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunDidNotComplete);
    expect(failure instanceof RunDidNotComplete ? failure.run : null).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/^output_schema_unsatisfied: /u) as unknown,
    });
  });
}
