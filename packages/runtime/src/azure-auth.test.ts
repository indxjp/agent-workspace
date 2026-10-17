import { describe, expect, it, vi } from 'vitest';

import { ACA_SESSIONS_TOKEN_SCOPE, createAcaSessionsAccessTokenProvider } from './azure-auth.js';

describe('ACA sessions Azure authentication', () => {
  it('requests only the dynamic sessions data-plane scope', async () => {
    const getToken = vi.fn(() => Promise.resolve({ token: 'session-token' }));
    const provider = createAcaSessionsAccessTokenProvider({ getToken });

    await expect(provider()).resolves.toBe('session-token');
    expect(getToken).toHaveBeenCalledOnce();
    expect(getToken).toHaveBeenCalledWith(ACA_SESSIONS_TOKEN_SCOPE);
  });

  it('rejects a credential result that contains no usable token', async () => {
    const provider = createAcaSessionsAccessTokenProvider({
      getToken: () => Promise.resolve(null),
    });
    await expect(provider()).rejects.toThrow(/returned no access token/u);
  });
});
