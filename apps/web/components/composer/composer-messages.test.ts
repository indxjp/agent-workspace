import { describe, expect, it } from 'vitest';

import { composerStrings } from './composer-messages';

// UX-15 in #2086: the home chat's own words, in English (the mockup's text) and Japanese.
describe('composerStrings', () => {
  const en = composerStrings('en');
  const ja = composerStrings('ja');

  it('keeps the English the mockup and spec §45 print', () => {
    expect(en.heading).toBe('What can I help with?');
    expect(en.inputPlaceholder).toBe('Ask anything…');
    expect(en.send).toBe('Send');
    expect(en.agentPicker(null)).toBe('Agent: none');
    expect(en.agentPicker('Research')).toBe('Agent: Research');
  });

  it('has a Japanese word for every English one', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const [left, right] = [en[key], ja[key]];
      const sample = (value: typeof left) =>
        typeof value === 'function' ? String((value as (x: never) => string)('X' as never)) : value;
      expect(sample(right), key).not.toBe('');
      expect(sample(right), key).not.toBe(sample(left));
    }
  });

  it('says the Japanese with the agent name and the Files switch', () => {
    expect(ja.heading).toBe('何をお手伝いしましょうか？');
    expect(ja.agentPicker('Research')).toBe('エージェント: Research');
    expect(ja.agentPicker(null)).toBe('エージェント: なし');
    expect(ja.intro(true)).toContain('ファイル');
    expect(ja.intro(false)).not.toContain('ファイル');
    expect(ja.removeChip('q3.pdf')).toBe('q3.pdf を外す');
  });

  it('says the sandbox line in each language, as the mockup prints it in English', () => {
    expect(en.sandbox(true)).toBe('Standard Sandbox · read/write');
    expect(en.sandbox(false)).toBe('Standard Sandbox · read-only');
    expect(ja.sandbox(true)).toBe('標準サンドボックス · 読み書き');
    expect(ja.sandbox(false)).toBe('標準サンドボックス · 読み取り専用');
  });
});
