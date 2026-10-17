/**
 * Where the durable session store is, as the container knows it.
 *
 * One thing is being checked and it is the whole of what this module still decides after ENG-06
 * moved the HTTP client to `./session-state.ts`: **the configuration read is total.** A partly
 * configured store is `invalid`, never `absent` — an operator who set one of the two variables was
 * turning this on, and a deployment that silently ran without a store would have unresumable
 * sessions and no sentence anywhere saying so (ADR-0015).
 *
 * The other half of what this file used to assert — that what the runner builds is a store an
 * engine will accept — moved with the client, to `./session-state.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIMEOUT_MS,
  MIRROR_TIMEOUT_ENV,
  MIRROR_URL_ENV,
  readMirrorConfig,
} from './session.js';

describe('readMirrorConfig', () => {
  it('is absent when the deployment configured no mirror at all', () => {
    const config = readMirrorConfig({});
    expect(config.kind).toBe('absent');
    expect(config.kind === 'absent' ? config.reason : '').toMatch(/§14\.9/);
  });

  it('is configured from the deployment URL without accepting a deployment bearer', () => {
    const config = readMirrorConfig({
      [MIRROR_URL_ENV]: 'https://control.example',
    });
    expect(config).toEqual({
      kind: 'configured',
      baseUrl: 'https://control.example',
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });

  it('strips a trailing slash so no request is built with a doubled separator', () => {
    const config = readMirrorConfig({
      [MIRROR_URL_ENV]: 'https://control.example/',
    });
    expect(config.kind === 'configured' ? config.baseUrl : '').toBe('https://control.example');
  });

  it.each([
    ['a URL that is not a URL', { [MIRROR_URL_ENV]: 'control.example' }],
    ['a scheme that is not http(s)', { [MIRROR_URL_ENV]: 'file:///tmp/x' }],
    ['a timeout with no URL', { [MIRROR_TIMEOUT_ENV]: '1000' }],
  ])('refuses %s rather than falling back to absent', (_name, env) => {
    expect(readMirrorConfig(env).kind).toBe('invalid');
  });

  it.each([['12ms'], ['0'], ['-1'], ['1.5'], ['NaN'], ['']])(
    'refuses the timeout %j by parsing it before comparing it',
    (value) => {
      const env = {
        [MIRROR_URL_ENV]: 'https://control.example',
        [MIRROR_TIMEOUT_ENV]: value,
      };
      const config = readMirrorConfig(env);
      // `Number('12ms')` is NaN and `NaN > 0` is false, so a check written the other way round
      // reads a malformed timeout as "not positive" and silently uses a default. The empty string
      // is the one arm that is legitimately "unset", and it takes the default.
      if (value === '') {
        expect(config.kind).toBe('configured');
        return;
      }
      expect(config.kind).toBe('invalid');
    },
  );

  it('treats whitespace as unset rather than as a value', () => {
    expect(readMirrorConfig({ [MIRROR_URL_ENV]: '   ' }).kind).toBe('absent');
  });
});
