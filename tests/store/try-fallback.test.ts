/**
 * What the Try tab's fallback and the home page's featured chat show of a recording (spec, "How
 * Try it works"): its steps in order, the approval wait as it was decided, the label that says it
 * was recorded with the scripted model, and "recording coming" for an entry with none.
 */
import { canonicalCall } from '@indx-workspace/contracts/agents';
import { describe, expect, it } from 'vitest';

import type { Recording } from '../../examples/store/catalog/recording.ts';
import { RECORDINGS } from '../../examples/store/catalog/recordings.generated.ts';
import {
  fallbackContent,
  readableAnswer,
  replayOf,
} from '../../examples/store/app/agents/[slug]/try/replay.ts';
import { verificationLabel } from '../../examples/store/app/verification.ts';

const booking = { body: { quantity: 20 } };
const recording: Recording = {
  slug: 'quotation',
  lang: 'en',
  recordedWith: 'scripted-model',
  turn: {
    prompt: 'Quote 20 units',
    stopReason: 'end_turn',
    steps: [
      { kind: 'tool', name: 'mcp__erp__getRate', input: {}, output: '{"rate":1}', isError: false },
      { kind: 'tool', name: 'mcp__erp__createQuote', input: booking, output: null, isError: false },
      { kind: 'approval', toolName: 'mcp__erp__createQuote', decision: 'approved' },
      { kind: 'tool', name: 'mcp__erp__createQuote', input: booking, output: '{}', isError: false },
      { kind: 'answer', text: 'Quoted.' },
    ],
  },
};

describe('the fallback of a recording', () => {
  it('shows its steps in order, the approval as decided, and the answer', () => {
    const parts = replayOf(recording.turn);
    expect(parts.map((part) => part.kind)).toEqual(['tools', 'approval', 'tools', 'answer']);
    const [first, approval, second] = parts;
    expect(first?.kind === 'tools' ? first.steps.map((step) => step.name) : []).toEqual([
      'mcp__erp__getRate',
      'mcp__erp__createQuote',
    ]);
    expect(approval).toEqual({
      kind: 'approval',
      call: {
        toolName: 'mcp__erp__createQuote',
        canonicalCall: canonicalCall('mcp__erp__createQuote', booking),
      },
      decision: 'approved',
    });
    expect(second?.kind === 'tools' ? second.steps[0]?.output : null).toBe('{}');
  });

  it('says it was recorded with the scripted model, in both languages, and never live', () => {
    const english = fallbackContent(recording, 'en');
    const japanese = fallbackContent(recording, 'ja');
    expect(english.kind === 'recording' ? english.label : '').toBe(
      'Recorded with the scripted model',
    );
    expect(japanese.kind === 'recording' ? japanese.label : '').toBe('台本どおりのモデルで録画');
    expect(english.kind === 'recording' ? english.prompt : '').toBe('Quote 20 units');
    // Never live: neither the recording's label nor the card's verification line says so.
    for (const text of [
      english.kind === 'recording' ? english.label : '',
      japanese.kind === 'recording' ? japanese.label : '',
      verificationLabel(recording.slug, 'en'),
      verificationLabel(recording.slug, 'ja'),
    ]) {
      expect(text).not.toMatch(/live|ライブ/iu);
    }
  });

  it('says a recording is coming when the entry has none', () => {
    expect(fallbackContent(null, 'en')).toEqual({ kind: 'coming', text: 'Recording coming' });
    expect(fallbackContent(null, 'ja')).toEqual({ kind: 'coming', text: '録画は準備中です' });
  });

  it('replays every committed recording with one approval part per approval wait', () => {
    expect(RECORDINGS.length).toBeGreaterThan(0);
    for (const entry of RECORDINGS) {
      const parts = replayOf(entry.turn);
      const waits = entry.turn.steps.filter((step) => step.kind === 'approval').length;
      expect(
        parts.filter((part) => part.kind === 'approval'),
        `${entry.slug} ${entry.lang}`,
      ).toHaveLength(waits);
      expect(parts.at(-1)?.kind, `${entry.slug} ${entry.lang} ends with its answer`).toBe('answer');
    }
  });

  it('shows a structured answer as a titled list, never as a raw JSON blob', () => {
    const sheet = JSON.stringify({
      findings: [{ text: 'Expected benefit is missing.', citations: ['Rule 4.1'] }],
      route: { approver: 'Board', coReview: null },
      notes: [],
      summary: 'Check the quote count.',
    });
    expect(readableAnswer(sheet)).toBe(
      [
        '**findings**',
        '',
        '- Expected benefit is missing. (Rule 4.1)',
        '',
        '**route**',
        '',
        '- approver: Board',
        '',
        '**notes**',
        '',
        '-',
        '',
        '**summary**',
        '',
        '- Check the quote count.',
      ].join('\n'),
    );
    // Prose, and JSON that is not an object, are shown as they are.
    expect(readableAnswer('Quoted.')).toBe('Quoted.');
    expect(readableAnswer('[1,2]')).toBe('[1,2]');
    for (const entry of RECORDINGS) {
      for (const part of replayOf(entry.turn)) {
        if (part.kind === 'answer') {
          expect(part.text, `${entry.slug} ${entry.lang}`).not.toMatch(/^\s*[{[]/u);
        }
      }
    }
  });

  it('says so when an English recording answers in Japanese', () => {
    const japanese = (lang: 'ja' | 'en'): Recording => ({
      ...recording,
      lang,
      turn: { ...recording.turn, steps: [{ kind: 'answer', text: '見積を作成しました。' }] },
    });
    const english = fallbackContent(japanese('en'), 'en');
    expect(english.kind === 'recording' ? english.label : '').toBe(
      'Recorded with the scripted model; the sample data and the answer are in Japanese',
    );
    // A Japanese page needs no such note; an English answer in English needs none either.
    const page = fallbackContent(japanese('ja'), 'ja');
    expect(page.kind === 'recording' ? page.label : '').toBe('台本どおりのモデルで録画');
    expect(fallbackContent(recording, 'en').kind === 'recording').toBe(true);
    for (const entry of RECORDINGS) {
      const content = fallbackContent(entry, entry.lang);
      const answers = entry.turn.steps.flatMap((step) =>
        step.kind === 'answer' ? [step.text] : [],
      );
      const inJapanese = answers.some((text) => /[ぁ-ヿ一-鿿]/u.test(text));
      expect(content.kind === 'recording' && /Japanese/u.test(content.label)).toBe(
        entry.lang === 'en' && inJapanese,
      );
    }
  });
});
