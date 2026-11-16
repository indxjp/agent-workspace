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

  it('says every run-target line in Japanese, leaving only the names it is given', () => {
    // Non-Latin stand-ins for the agent, the model, the connection and the reason, so any Latin
    // letter left is an English word of the line itself.
    const words = ja.runTarget;
    const lines = [
      words.override('①', '②', '③'),
      ...(['agent', 'project', 'workspace', 'deployment'] as const).flatMap((source) => [
        words.runnable('①', '②', '③', source, false),
        words.runnable('①', '②', '③', source, true),
      ]),
      words.unrunnable('①', 'agent_runtime_profile_missing', '④'),
      words.unrunnable('①', 'model_connection_unresolved', '④'),
      words.unknown('①'),
    ];
    for (const line of lines) expect(line).not.toMatch(/[A-Za-z]/u);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('puts no space between a Japanese word and the particle after it', () => {
    const words = ja.runTarget;
    expect(words.runnable('①', 'model-x', '③', 'deployment', true)).toContain(
      'model-x またはその最新の日付付きリリースで実行します',
    );
    expect(words.runnable('①', 'model-x', '③', 'agent', false)).toContain('model-x で実行します');
  });

  it('shows the server’s English reason, as it came, to an English reader', () => {
    expect(en.runTarget.unrunnable('General', 'agent_runtime_profile_missing', 'why.')).toBe(
      'General cannot run yet — why.',
    );
  });
});
