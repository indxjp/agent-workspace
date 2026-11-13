import { afterEach, describe, expect, it } from 'vitest';

import {
  clearClientIdentity,
  clientIdentityFromEnvironment,
  installClientIdentity,
  installedClientIdentity,
  NO_CLIENT_IDENTITY,
} from './client-identity';

const SECRET = 'a-secure-test-secret-with-at-least-32-characters';

describe('client identity (refactoring part 03, step 2)', () => {
  afterEach(() => {
    clearClientIdentity();
  });

  it('is not configured until the composition root installs it, and again once cleared', () => {
    expect(installedClientIdentity()).toEqual(NO_CLIENT_IDENTITY);
    installClientIdentity({ trustedProxyHops: 2, sessionSecret: SECRET });
    expect(installedClientIdentity()).toEqual({ trustedProxyHops: 2, sessionSecret: SECRET });
    clearClientIdentity();
    expect(installedClientIdentity()).toEqual(NO_CLIENT_IDENTITY);
  });

  it('reads an environment the way start-up does, failing closed', () => {
    expect(
      clientIdentityFromEnvironment({ AW_TRUSTED_PROXY_HOPS: '1', SESSION_SECRET: SECRET }),
    ).toEqual({ trustedProxyHops: 1, sessionSecret: SECRET });
    expect(
      clientIdentityFromEnvironment({ AW_TRUSTED_PROXY_HOPS: '0', SESSION_SECRET: SECRET }),
    ).toEqual({ trustedProxyHops: null, sessionSecret: SECRET });
    expect(
      clientIdentityFromEnvironment({ AW_TRUSTED_PROXY_HOPS: 'several', SESSION_SECRET: SECRET }),
    ).toEqual({ trustedProxyHops: null, sessionSecret: SECRET });
    expect(
      clientIdentityFromEnvironment({ AW_TRUSTED_PROXY_HOPS: '1', SESSION_SECRET: 'short' }),
    ).toEqual({ trustedProxyHops: 1, sessionSecret: null });
    expect(clientIdentityFromEnvironment({})).toEqual(NO_CLIENT_IDENTITY);
  });
});
