/**
 * What the Try it section's fallback and the home page's featured chat show of a {@link Recording}: its
 * steps in order, the approval waits among them, and the label that says honestly how it was made.
 * Pure, so `tests/store/try-fallback.test.ts` runs it.
 */
import { canonicalCall } from '@indx-workspace/contracts/agents';
import type { RunApprovalCall } from '@indx-workspace/contracts/runs';
import type { ResultChart } from '@indx-workspace/contracts/surfaces';

import type { RecordedTurn, Recording } from '../../../../catalog/recording.ts';
import { pick, type Lang } from '../../../lang.ts';
import { chartsFor } from './charts.ts';
import type { ToolStep } from './transcript.ts';

/** A value of a structured answer as one line: a finding's text with its citations, or `key: value` pairs. */
function inline(value: unknown): string {
  if (Array.isArray(value)) return value.map(inline).join(', ');
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'object' || value === null) return '';
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null);
  const said = entries.find(([key, v]) => key === 'text' && typeof v === 'string')?.[1];
  if (typeof said === 'string') {
    const cited = entries.find(([key]) => key === 'citations')?.[1];
    return Array.isArray(cited) && cited.length > 0 ? `${said} (${inline(cited)})` : said;
  }
  return entries.map(([key, v]) => `${key}: ${inline(v)}`).join(' / ');
}

/**
 * An answer to show. An agent that answers with structured output (a review sheet) leaves its JSON
 * as the message text; it is shown as a titled list per key, never as a raw JSON blob. Any other
 * answer is shown as it is.
 */
export function readableAnswer(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return text;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return text;
  return Object.entries(parsed as Record<string, unknown>)
    .map(([key, value]) => {
      const items = Array.isArray(value) ? value : [value];
      const body = items.length === 0 ? ['-'] : items.map((item) => `- ${inline(item)}`);
      return [`**${key}**`, '', ...body].join('\n');
    })
    .join('\n\n');
}

export type ReplayPart =
  | { readonly kind: 'tools'; readonly steps: readonly ToolStep[] }
  | {
      readonly kind: 'approval';
      readonly call: RunApprovalCall;
      readonly decision: 'approved' | 'rejected' | null;
    }
  | { readonly kind: 'answer'; readonly text: string };

/** `turn`'s steps for the SDK chat parts: consecutive tool calls form one trace. */
export function replayOf(turn: RecordedTurn): readonly ReplayPart[] {
  const parts: ReplayPart[] = [];
  turn.steps.forEach((step, index) => {
    const last = parts.at(-1);
    if (step.kind === 'tool') {
      const tool: ToolStep = {
        id: String(index),
        name: step.name,
        input: step.input,
        output: step.output,
        isError: step.isError,
      };
      if (last?.kind === 'tools')
        parts[parts.length - 1] = { kind: 'tools', steps: [...last.steps, tool] };
      else parts.push({ kind: 'tools', steps: [tool] });
    } else if (step.kind === 'answer') {
      parts.push({ kind: 'answer', text: readableAnswer(step.text) });
    } else {
      // The call that waited is the last one the run made under this tool's name.
      const waited = turn.steps
        .slice(0, index)
        .findLast((s) => s.kind === 'tool' && s.name === step.toolName);
      const input = waited?.kind === 'tool' ? waited.input : {};
      parts.push({
        kind: 'approval',
        call: { toolName: step.toolName, canonicalCall: canonicalCall(step.toolName, input) },
        decision: step.decision,
      });
    }
  });
  return parts;
}

const bi = (ja: string, en: string) => ({ ja, en });

const RECORDED_WITH = {
  'scripted-model': bi('台本どおりのモデルで録画', 'Recorded with the scripted model'),
} as const;

export const DECISION_WORDS = {
  approved: bi('承認済み', 'Approved'),
  rejected: bi('却下', 'Rejected'),
  waiting: bi('承認待ちで終了', 'Ended waiting for approval'),
} as const;

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

/**
 * Said under the label of an English recording whose answer is Japanese: the scripted model reads
 * the Japanese prompt and data of its use case, so the answer is not translated.
 */
const IN_JAPANESE = bi(
  'サンプルデータと回答は日本語です',
  'the sample data and the answer are in Japanese',
);

/** What the fallback shows: the recording replayed with its label, or that one is coming. */
export type FallbackContent =
  | {
      readonly kind: 'recording';
      readonly label: string;
      readonly prompt: string;
      readonly parts: readonly ReplayPart[];
      /** The recorded typed answer, and the entry's charts drawn from it under the answer. */
      readonly structured: unknown;
      readonly charts: readonly ResultChart[];
    }
  | { readonly kind: 'coming'; readonly text: string };

export function fallbackContent(recording: Recording | null, lang: Lang): FallbackContent {
  if (recording === null)
    return { kind: 'coming', text: pick(bi('録画は準備中です', 'Recording coming'), lang) };
  const label = pick(RECORDED_WITH[recording.recordedWith], lang);
  const untranslated =
    lang === 'en' &&
    recording.turn.steps.some((step) => step.kind === 'answer' && JAPANESE.test(step.text));
  return {
    kind: 'recording',
    label: untranslated ? `${label}; ${pick(IN_JAPANESE, lang)}` : label,
    prompt: recording.turn.prompt,
    parts: replayOf(recording.turn),
    structured: recording.turn.structured ?? null,
    charts: chartsFor(recording.slug, recording.turn.structured),
  };
}
