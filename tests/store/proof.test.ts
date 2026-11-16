/**
 * The P5 contract every lane shares: a run's frames become a recorded turn one way
 * (`proof/record-turn.ts`), one rule judges whether the entry's moment happened (`judgeMoment`),
 * and a card is verified with real Claude only when its latest real-model record passed
 * (`cardVerification`).
 */
import { describe, expect, it } from 'vitest';

import type { RunEventFrame } from '@indx-workspace/sdk/events';

import { judgeMoment, recordingFor } from '../../examples/store/catalog/recording.ts';
import {
  REAL_MODEL_EVIDENCE,
  cardVerification,
  realModelEvidenceSchema,
  type RealModelRun,
} from '../../examples/store/catalog/verification.ts';
import { verificationLabel } from '../../examples/store/app/verification.ts';
import { recordTurn } from './proof/record-turn.ts';

const runtime = (name: string, data: object): RunEventFrame => ({
  kind: 'runtime',
  id: null,
  name,
  data: { frame: name, engine: 'claude-agent-sdk', raw: {}, ...data },
});
const call = (id: string, name: string) =>
  runtime('agent.tool.call', { toolCallId: id, name, kind: 'edit', input: { id: 1 } });
const result = (id: string, output: string) =>
  runtime('agent.tool.result', { toolCallId: id, status: 'completed', output, isError: false });
const said = (id: string, text: string) =>
  runtime('agent.message', {
    messageId: id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
  });
const asked = (id: string, toolName: string) =>
  runtime('agent.approval.requested', {
    toolCallId: id,
    toolName,
    canonicalCall: `${toolName}({"id":1})`,
  });
const ended = runtime('agent.result', { stopReason: 'end_turn', turns: 2, engineCostUsd: null });

/** A quote is read, its write waits for approval, is approved, and then runs. */
const approvedWrite = recordTurn('Quote 20 units at 15% off', [
  {
    frames: [
      call('t1', 'mcp__erp__getPrices'),
      result('t1', '20 units'),
      call('t2', 'mcp__erp__createQuote'),
      asked('t2', 'mcp__erp__createQuote'),
    ],
    decision: 'approved',
  },
  {
    frames: [
      call('t3', 'mcp__erp__createQuote'),
      result('t3', 'Q-1'),
      said('m1', 'Drafted.'),
      said('m1', 'Drafted Q-1.'),
      ended,
    ],
  },
]);

describe('recordTurn', () => {
  it('keeps every step in order across the approval, an answer repeated under its id replaced', () => {
    expect(approvedWrite.steps.map((step) => step.kind)).toEqual([
      'tool',
      'tool',
      'approval',
      'tool',
      'answer',
    ]);
    expect(approvedWrite.steps.at(-1)).toEqual({ kind: 'answer', text: 'Drafted Q-1.' });
    expect(approvedWrite.steps[2]).toEqual({
      kind: 'approval',
      toolName: 'mcp__erp__createQuote',
      decision: 'approved',
    });
    expect(approvedWrite.stopReason).toBe('end_turn');
  });

  it('ignores a frame whose payload is not the agent frame it is named as', () => {
    const turn = recordTurn('hi', [
      { frames: [runtime('agent.tool.call', { toolCallId: 't1' }), ended] },
    ]);
    expect(turn.steps).toEqual([]);
  });
});

describe('judgeMoment', () => {
  it('passes a turn that called the tools and ran the approved write', () => {
    expect(judgeMoment(approvedWrite, { tools: ['getPrices'], approval: 'createQuote' })).toEqual({
      pass: true,
    });
  });

  it('names the tool that was not called', () => {
    expect(judgeMoment(approvedWrite, { tools: ['getRates'], approval: null })).toEqual({
      pass: false,
      reason: 'getRates was not called and answered',
    });
  });

  it('fails a write that never waited, or waited and was not approved', () => {
    const noWait = recordTurn('q', [{ frames: [call('t1', 'createQuote'), result('t1', 'Q-1')] }]);
    expect(judgeMoment(noWait, { tools: ['createQuote'], approval: 'createQuote' })).toEqual({
      pass: false,
      reason: 'createQuote did not wait for approval',
    });
    const stillWaiting = recordTurn('q', [
      { frames: [call('t1', 'createQuote'), asked('t1', 'createQuote')] },
    ]);
    expect(
      judgeMoment(stillWaiting, { tools: ['createQuote'], approval: 'createQuote' }),
    ).toMatchObject({ pass: false });
  });

  it('does not take a tool whose name only ends the same way', () => {
    const other = recordTurn('q', [
      { frames: [call('t1', 'mcp__x__precreateQuote'), result('t1', 'ok')] },
    ]);
    expect(judgeMoment(other, { tools: ['createQuote'], approval: null })).toMatchObject({
      pass: false,
    });
  });
});

describe('cardVerification', () => {
  const run = (over: Partial<RealModelRun>): RealModelRun => ({
    entry: 'quotation',
    runId: 'run-1',
    date: '2026-11-20T01:00:00.000Z',
    result: 'pass',
    reason: 'the quote waited for approval and was written',
    environment: 'staging',
    ...over,
  });

  it('starts with no evidence, so every card is verified with the scripted model', () => {
    expect(REAL_MODEL_EVIDENCE.runs).toEqual([]);
    expect(cardVerification('quotation')).toEqual({ kind: 'scripted-model' });
  });

  it('is real-model only when the entry has a record and its latest one passed', () => {
    expect(cardVerification('quotation', [run({})])).toEqual({
      kind: 'real-model',
      runId: 'run-1',
      date: '2026-11-20T01:00:00.000Z',
    });
    expect(cardVerification('wiki', [run({})])).toEqual({ kind: 'scripted-model' });
    expect(
      cardVerification('quotation', [
        run({}),
        run({ runId: 'run-2', date: '2026-11-21T01:00:00.000Z', result: 'fail' }),
      ]),
    ).toEqual({ kind: 'scripted-model' });
  });

  it('refuses evidence from anywhere but staging, or with no reason', () => {
    expect(
      realModelEvidenceSchema.safeParse({ runs: [{ ...run({}), environment: 'production' }] })
        .success,
    ).toBe(false);
    expect(realModelEvidenceSchema.safeParse({ runs: [run({ reason: ' ' })] }).success).toBe(false);
  });
});

describe('recordingFor', () => {
  it('finds nothing for an entry with no recording', () => {
    expect(recordingFor([], 'quotation', 'ja')).toBeNull();
  });
});

describe('verificationLabel', () => {
  it('says "verified with the scripted model" while there is no passed real-model record', () => {
    expect(verificationLabel('quotation', 'en')).toBe('Verified with the scripted model');
    expect(verificationLabel('quotation', 'ja')).toBe('台本どおりのモデルで検証済み');
  });
});
