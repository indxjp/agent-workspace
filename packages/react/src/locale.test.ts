import { SURFACE_LOCALES } from '@indx-workspace/contracts/surfaces';
import { describe, expect, it } from 'vitest';

import { awDevModelFix, surfaceStrings } from './locale.js';

describe('surfaceStrings (S1-18, #456)', () => {
  it('has the same keys in every locale', () => {
    const keys = SURFACE_LOCALES.map((locale) => Object.keys(surfaceStrings(locale)).sort());
    for (const each of keys) expect(each).toEqual(keys[0]);
  });

  it('localises Japanese, rather than repeating English', () => {
    const en = surfaceStrings('en');
    const ja = surfaceStrings('ja');
    expect(en.send).toBe('Send');
    expect(ja.send).toBe('送信');
    expect(ja.messageLabel('Support')).not.toBe(en.messageLabel('Support'));
    expect(en.toolActivity(1)).toBe('1 tool step');
    expect(en.toolActivity(2)).toBe('2 tool steps');
    expect(ja.toolActivity(3)).toBe('ツールの実行 3 件');
    const fixed = [
      'suggestedPromptsLabel',
      'disclaimerLabel',
      'tryKeyHeading',
      'tryGetKey',
      'tryKeyOrPaste',
      'tryEmbed',
      'tryCopy',
      'trySnippetCaption',
      'tryNotPromoted',
      'tryModelReachFix',
      'agentSwitcherLabel',
      'feedbackUp',
      'feedbackDown',
      'feedbackFailed',
      'toolInput',
      'toolOutput',
      'earlierMessage',
      'turnLimitReached',
    ];
    for (const key of fixed) {
      expect(Reflect.get(ja, key)).not.toBe(Reflect.get(en, key));
    }
    expect(en.rateLimited(12)).toBe('Too many messages. Try again in 12 s.');
    expect(ja.rateLimited(12)).toContain('12 秒後');
    expect(ja.rateLimited(null)).not.toBe(en.rateLimited(null));
    expect(ja.launcherLabel('Help')).toBe('Helpを開く');
    expect(ja.tryHeading('Help')).toBe('Helpを試す');
    expect(ja.tryModelKeyFix(['MAIN_MODEL_KEY'])).not.toBe(en.tryModelKeyFix(['MAIN_MODEL_KEY']));
  });
});

describe('awDevModelFix (issue #661)', () => {
  it('names the secrets for a missing or rejected key, in each locale', () => {
    for (const locale of SURFACE_LOCALES) {
      const strings = surfaceStrings(locale);
      for (const code of ['model_connection_unresolved', 'model_credential_rejected']) {
        expect(awDevModelFix(code, strings)).toContain('ANTHROPIC_API_KEY');
        const named = awDevModelFix(code, strings, ['MAIN_MODEL_KEY', 'OTHER_KEY']);
        expect(named).toContain('MAIN_MODEL_KEY');
        expect(named).toContain('OTHER_KEY');
        expect(named).not.toContain('ANTHROPIC_API_KEY');
        expect(named).toContain('aw dev');
      }
    }
    expect(awDevModelFix('model_credential_rejected', surfaceStrings('en'), ['K'])).toBe(
      'Running under aw dev: set K to a valid key and restart aw dev.',
    );
  });

  it('gives a provider that cannot be connected to the reachability hint, and other codes nothing', () => {
    const strings = surfaceStrings('en');
    expect(awDevModelFix('model_connection_failed', strings)).toBe(strings.tryModelReachFix);
    expect(awDevModelFix('model_connection_failed', strings)).not.toContain('ANTHROPIC_API_KEY');
    expect(awDevModelFix('model_unavailable', strings)).toBeNull();
    expect(awDevModelFix('surface_rate_limited', strings)).toBeNull();
  });
});
