import { describe, expect, it } from 'vitest';

import { FakeChallengeVerifier } from './fake';
import { createChallengeVerifier } from './production';

describe('createChallengeVerifier', () => {
  it.each([null, '', '   '])('returns null for an unset challenge (%j)', (name) => {
    expect(createChallengeVerifier(name)).toBeNull();
  });

  it('refuses a name no provider answers to, naming the variable', () => {
    expect(() => createChallengeVerifier('recaptcha')).toThrow(
      /AW_EMAIL_LINK_CHALLENGE "recaptcha"/u,
    );
    expect(() => createChallengeVerifier('constructor')).toThrow(/not a known sign-up challenge/u);
  });

  it('does not offer the fake adapter by name', () => {
    expect(() => createChallengeVerifier('fake')).toThrow(/not a known sign-up challenge/u);
  });
});

describe('FakeChallengeVerifier', () => {
  it('passes only the configured answer and records every call', async () => {
    const verifier = new FakeChallengeVerifier('right');
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.1' });
    await expect(verifier.verify('right', headers)).resolves.toBe('pass');
    await expect(verifier.verify('wrong', headers)).resolves.toBe('fail');
    expect(verifier.calls.map((call) => call.answer)).toEqual(['right', 'wrong']);
    expect(verifier.calls[0]?.headers).toBe(headers);
  });
});
