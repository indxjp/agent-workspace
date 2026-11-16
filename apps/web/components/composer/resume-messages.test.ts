import { describe, expect, it } from 'vitest';

import { resumeStrings } from './resume-messages';

// UX-05 step 2: the words around a continued chat's earlier messages, in both languages.
describe('resumeStrings', () => {
  it('says whether the earlier messages are shown', () => {
    const en = resumeStrings('en');
    expect(en.continuing('Q3', true)).toBe(
      'Continuing “Q3”. Your next message goes on from where this chat left off.',
    );
    expect(en.continuing('Q3', false)).toContain('its earlier messages cannot be shown here');
    const ja = resumeStrings('ja');
    expect(ja.continuing('Q3', true)).toBe(
      '「Q3」の続きです。次のメッセージはこのチャットの続きとして送られます。',
    );
    expect(ja.continuing('Q3', false)).toContain('以前のメッセージはここでは表示できません');
  });

  it('counts the older messages left out', () => {
    expect(resumeStrings('en').earlierHidden(1)).toBe('1 older message is not shown.');
    expect(resumeStrings('en').earlierHidden(5)).toBe('5 older messages are not shown.');
    expect(resumeStrings('ja').earlierHidden(5)).toBe('古いメッセージ5件は表示していません。');
    expect(resumeStrings('ja').historyHeading).toBe('このチャットのこれまでのやり取り');
  });
});
