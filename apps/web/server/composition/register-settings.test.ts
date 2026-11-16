import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsError } from '../settings';
import { register } from './register';

describe('register() and the web settings (refactoring part 03)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stops start-up on a malformed proxy count, before the database is opened', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('AW_TRUSTED_PROXY_HOPS', 'several');
    await expect(register()).rejects.toThrow('AW_TRUSTED_PROXY_HOPS is "several"');
  });

  it('stops start-up on an idle stop that leaves no time to interrupt a run', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('AW_CONTAINER_IDLE_STOP_SECONDS', '15');
    await expect(register()).rejects.toThrow('AW_CONTAINER_IDLE_STOP_SECONDS is "15"');
  });

  it('names every refused variable in one error, so one restart fixes them all', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('AW_DEPLOYMENT_POLICY', '{not json');
    vi.stubEnv('AW_DEPLOYMENT_FEATURES', 'triggers');
    vi.stubEnv('AW_TRUSTED_PROXY_HOPS', 'two');
    vi.stubEnv('AW_CONTAINER_IDLE_STOP_SECONDS', 'soon');
    const failure = await register().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SettingsError);
    const reasons = (failure as SettingsError).reasons;
    expect(reasons).toHaveLength(4);
    expect(reasons[0]).toBe('AW_DEPLOYMENT_POLICY is invalid: the value is not JSON');
    expect(reasons[1]).toMatch(/^AW_DEPLOYMENT_FEATURES is invalid: /u);
    expect(reasons[2]).toMatch(/^AW_TRUSTED_PROXY_HOPS is "two"/u);
    expect(reasons[3]).toMatch(/^AW_CONTAINER_IDLE_STOP_SECONDS is "soon"/u);
  });
});
