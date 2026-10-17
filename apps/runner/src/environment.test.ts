import { describe, expect, it } from 'vitest';

import { runnerBaseEnvironment, runnerEnvironmentFor } from './environment.js';

const POSIX = process.platform !== 'win32';

describe('runner environment boundary', () => {
  it('gives a run only what the operating system needs to start a program', () => {
    const base = runnerBaseEnvironment({
      PATH: '/container/bin',
      HOME: '/home/runner',
      USERPROFILE: 'C:\\Users\\runner',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      RUNNER_ONLY_DECOY: 'must-not-cross',
      PROVIDER_MASTER_KEY: 'must-not-cross-either',
    });
    const insideRun = runnerEnvironmentFor(
      {
        ANTHROPIC_BASE_URL: 'http://gateway:4000',
        ANTHROPIC_AUTH_TOKEN: 'run-token',
        NODE_USE_ENV_PROXY: '1',
      },
      base,
    );

    expect(base).toEqual(
      POSIX
        ? { PATH: '/container/bin', HOME: '/home/runner' }
        : {
            PATH: '/container/bin',
            USERPROFILE: 'C:\\Users\\runner',
            SystemRoot: 'C:\\Windows',
            TEMP: 'C:\\Temp',
          },
    );
    expect(insideRun).not.toHaveProperty('RUNNER_ONLY_DECOY');
    expect(insideRun).not.toHaveProperty('PROVIDER_MASTER_KEY');
    expect(insideRun).toMatchObject({
      PATH: '/container/bin',
      ANTHROPIC_BASE_URL: 'http://gateway:4000',
      ANTHROPIC_AUTH_TOKEN: 'run-token',
      NODE_USE_ENV_PROXY: '1',
    });
  });

  it('omits a key the container does not define and lets the request win', () => {
    expect(runnerBaseEnvironment({ PATH: '', HOME: undefined })).toEqual({});
    expect(runnerEnvironmentFor({ PATH: '/request/bin' }, { PATH: '/container/bin' })).toEqual({
      PATH: '/request/bin',
    });
  });
});
