import { afterEach, describe, expect, it, vi } from 'vitest';

import { register } from './register';

describe('register() and AW_DEPLOYMENT_FEATURES (ADR-0160 D5)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stops start-up on an invalid value, before the database is opened', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('AW_DEPLOYMENT_FEATURES', 'triggers');
    await expect(register()).rejects.toThrow('AW_DEPLOYMENT_FEATURES is invalid: ');
  });
});
