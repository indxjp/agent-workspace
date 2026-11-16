import { RUN_START_PROBLEM_CODES } from '@indx-workspace/contracts/runs';
import {
  SURFACE_ATTACHMENT_MAX_BYTES,
  SURFACE_ATTACHMENTS_MAX_FILES,
  SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES,
} from '@indx-workspace/contracts/surfaces';
import { describe, expect, it } from 'vitest';
import {
  RUN_REFUSAL_JA,
  RUN_REFUSAL_LEFT_IN_ENGLISH,
  runRefusalReason,
} from './run-refusal-messages';

describe('run refusal reasons in the reader’s language', () => {
  const covered = Object.keys(RUN_REFUSAL_JA);

  it('covers every run-start code except the one left in English on purpose', () => {
    // A new code in RUN_START_PROBLEM_CODES fails here until it has Japanese in RUN_REFUSAL_JA
    // or a reason in RUN_REFUSAL_LEFT_IN_ENGLISH.
    const left: readonly string[] = RUN_REFUSAL_LEFT_IN_ENGLISH;
    expect([...covered, ...left].sort()).toEqual(Object.keys(RUN_START_PROBLEM_CODES).sort());
    for (const code of left) expect(covered).not.toContain(code);
  });

  it('only covers codes the run API really sends', () => {
    for (const code of covered) expect(Object.hasOwn(RUN_START_PROBLEM_CODES, code)).toBe(true);
  });

  it('gives every covered code a Japanese sentence with no English words', () => {
    for (const [code, sentence] of Object.entries(RUN_REFUSAL_JA)) {
      // "API", "URL", "MiB", a provider's name and the Builder's name are written in Latin
      // letters in Japanese too.
      expect(sentence.replace(/API|URL|MiB|OpenAI|Builder/gu, ''), code).not.toMatch(/[A-Za-z]/u);
      expect(sentence.endsWith('。'), code).toBe(true);
    }
    expect(new Set(Object.values(RUN_REFUSAL_JA)).size).toBe(covered.length);
  });

  it('shows Japanese for a known code and the server’s text otherwise', () => {
    expect(runRefusalReason('model_unavailable', 'english.', 'ja')).toBe(
      RUN_REFUSAL_JA.model_unavailable,
    );
    expect(runRefusalReason('run_subject_forbidden', 'english.', 'ja')).toBe('english.');
    expect(runRefusalReason('not_a_run_start_code', 'english.', 'ja')).toBe('english.');
    expect(runRefusalReason(null, 'english.', 'ja')).toBe('english.');
    expect(runRefusalReason('toString', 'english.', 'ja')).toBe('english.');
  });

  it('states the attachment limits the server enforces', () => {
    expect(RUN_REFUSAL_JA.run_attachments_too_large).toContain(
      `${String(SURFACE_ATTACHMENTS_MAX_FILES)} ファイルまで`,
    );
    expect(RUN_REFUSAL_JA.run_attachments_too_large).toContain(
      `1 ファイル ${String(SURFACE_ATTACHMENT_MAX_BYTES / (1024 * 1024))} MiB まで`,
    );
    expect(RUN_REFUSAL_JA.run_attachments_too_large).toContain(
      `合計 ${String(SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES / (1024 * 1024))} MiB まで`,
    );
  });

  it('always shows the server’s own sentence to an English reader', () => {
    for (const code of covered) expect(runRefusalReason(code, 'english.', 'en')).toBe('english.');
  });
});
