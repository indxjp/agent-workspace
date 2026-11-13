import { describe, expect, it } from 'vitest';

import { RUN_STATUS_NAMES, badgeForRunStatus, failureBadge } from '@indx-workspace/react/run-model';

import { runStatusLabel, runViewStrings } from './run-view-messages';

// UX-15 in #2086: the run view's own words, in English (the mockup's text) and Japanese.
describe('runViewStrings', () => {
  const en = runViewStrings('en');
  const ja = runViewStrings('ja');

  it('keeps the English the mockup prints', () => {
    expect(en.followUpLabel).toBe('Ask a follow-up');
    expect(en.send).toBe('Send');
    expect(en.technicalDetails).toBe('Show technical details');
    expect(en.working('Report writer')).toBe('Report writer is working');
  });

  it('has a Japanese word for every English one', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const sample = (value: (typeof en)[typeof key]) =>
        typeof value === 'function' ? value('X') : value;
      expect(sample(ja[key]), key).not.toBe('');
      expect(sample(ja[key]), key).not.toBe(sample(en[key]));
    }
    expect(ja.working('Report writer')).toBe('Report writer が作業中です');
  });
});

describe('runStatusLabel', () => {
  it('leaves every English label as it is', () => {
    for (const status of RUN_STATUS_NAMES) {
      const { label } = badgeForRunStatus(status);
      expect(runStatusLabel(label, 'en')).toBe(label);
    }
  });

  it('has Japanese for every label a known status prints, so a new status cannot slip through in English', () => {
    for (const status of RUN_STATUS_NAMES) {
      const { label } = badgeForRunStatus(status);
      const ja = runStatusLabel(label, 'ja');
      expect(ja, status).not.toBe(label);
      expect(ja, status).not.toMatch(/[A-Za-z]/u);
    }
    expect(runStatusLabel(badgeForRunStatus(42).label, 'ja')).toBe('不明');
    expect(runStatusLabel('Awaiting approval', 'ja')).toBe('承認待ち');
  });

  it('keeps the status the server named after a failure, and shows an unknown status as it came', () => {
    expect(runStatusLabel(failureBadge('unknown').label, 'ja')).toBe('失敗');
    expect(runStatusLabel(failureBadge('timed_out').label, 'ja')).toBe('失敗 · timed_out');
    expect(runStatusLabel(failureBadge('cancelled').label, 'ja')).toBe('キャンセル済み');
    expect(runStatusLabel(badgeForRunStatus('exploded').label, 'ja')).toBe('exploded');
  });
});
