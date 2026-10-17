/**
 * Spec A.11's *"provider master credentials never enter a sandbox"*, as a property rather than a
 * name list.
 *
 * The case that matters most is the last one: a variable this repository has never heard of,
 * spelled like a credential, holding something that is not this run's token. A check written as
 * "is `ANTHROPIC_API_KEY` absent" passes that input, and it is exactly the input a second engine
 * brings.
 */
import { describe, expect, it } from 'vitest';

import {
  isCredentialEnvName,
  PROVIDER_MASTER_CREDENTIAL_ENV,
  sandboxEnvironmentVerdict,
} from './sandbox-env.js';

const TOKEN = 'run-scoped-gateway-token';

describe('sandboxEnvironmentVerdict', () => {
  it('accepts an environment whose credential-shaped variables all hold the run token', () => {
    const verdict = sandboxEnvironmentVerdict(
      {
        PATH: '/usr/bin',
        ANTHROPIC_BASE_URL: 'https://gateway.internal',
        ANTHROPIC_AUTH_TOKEN: TOKEN,
        OPENAI_API_KEY: TOKEN,
      },
      TOKEN,
    );
    expect(verdict.ok).toBe(true);
    // ADR-0015: the passing arm says what it looked at, so a verdict computed over an
    // environment something upstream had emptied is not indistinguishable from this one.
    expect(verdict.ok ? verdict.checked : -1).toBe(2);
  });

  it('refuses ANTHROPIC_API_KEY by name, whatever it holds', () => {
    for (const value of [TOKEN, 'sk-ant-real-key', '']) {
      const verdict = sandboxEnvironmentVerdict({ [PROVIDER_MASTER_CREDENTIAL_ENV]: value }, TOKEN);
      expect(verdict.ok, JSON.stringify(value)).toBe(false);
      expect(verdict.ok ? '' : verdict.reason).toContain('A.11');
    }
  });

  it('refuses it case-insensitively, because environment names are on Windows', () => {
    for (const name of ['anthropic_api_key', 'Anthropic_Api_Key', 'ANTHROPIC_API_KEY']) {
      expect(sandboxEnvironmentVerdict({ [name]: 'x' }, TOKEN).ok, name).toBe(false);
    }
  });

  it('refuses a provider key in a variable it has never heard of', () => {
    const verdict = sandboxEnvironmentVerdict(
      { PATH: '/usr/bin', SOME_FUTURE_PROVIDER_API_KEY: 'sk-live-real-credential' },
      TOKEN,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.variable).toBe('SOME_FUTURE_PROVIDER_API_KEY');
  });

  it('refuses a credential-shaped variable holding a token that merely resembles the run token', () => {
    // By value, never by prefix or length: a different token is a run reaching the gateway as
    // somebody else.
    const verdict = sandboxEnvironmentVerdict({ X_AUTH_TOKEN: `${TOKEN}-other` }, TOKEN);
    expect(verdict.ok).toBe(false);
  });

  it('says nothing about a variable that is not credential-shaped', () => {
    // Stated as a test because it is the declared limit of this check, not an oversight: a
    // secret hidden in `DATABASE_URL` is outside it, and `RunEnvironment`'s reserved names and
    // the gateway's own issuance are what cover that.
    const verdict = sandboxEnvironmentVerdict({ DATABASE_URL: 'postgres://u:p@h/db' }, TOKEN);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok ? verdict.checked : -1).toBe(0);
  });
});

describe('isCredentialEnvName', () => {
  it.each([
    ['ANTHROPIC_API_KEY', true],
    ['OPENAI_API_KEY', true],
    ['anthropic_auth_token', true],
    ['AW_SESSION_MIRROR_TOKEN', false],
    ['PATH', false],
    ['API_KEY_PREFIX', false],
  ])('%s → %s', (name, expected) => {
    expect(isCredentialEnvName(name)).toBe(expected);
  });
});
