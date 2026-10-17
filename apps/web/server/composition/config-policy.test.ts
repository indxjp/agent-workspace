import { describe, expect, it } from 'vitest';

import { readDeploymentPolicy } from './config';

describe('readDeploymentPolicy (issue #535)', () => {
  it('reads an absent or blank value as no ceiling', () => {
    expect(readDeploymentPolicy({})).toBeNull();
    expect(readDeploymentPolicy({ AW_DEPLOYMENT_POLICY: '  ' })).toBeNull();
  });

  it('parses a valid ceiling', () => {
    expect(
      readDeploymentPolicy({
        AW_DEPLOYMENT_POLICY: JSON.stringify({
          permissions: { runCommands: false },
          models: ['claude-sonnet-4-5'],
        }),
      }),
    ).toEqual({ permissions: { runCommands: false }, models: ['claude-sonnet-4-5'] });
  });

  it('refuses a value that is not JSON, naming the variable', () => {
    expect(() => readDeploymentPolicy({ AW_DEPLOYMENT_POLICY: '{nope' })).toThrow(
      /^AW_DEPLOYMENT_POLICY is invalid: the value is not JSON$/u,
    );
  });

  it('refuses a connections key and a not-built network key', () => {
    expect(() =>
      readDeploymentPolicy({ AW_DEPLOYMENT_POLICY: JSON.stringify({ connections: ['x'] }) }),
    ).toThrow(/AW_DEPLOYMENT_POLICY is invalid: \(root\): .*connections/u);
    expect(() =>
      readDeploymentPolicy({ AW_DEPLOYMENT_POLICY: JSON.stringify({ network: 'none' }) }),
    ).toThrow(/AW_DEPLOYMENT_POLICY is invalid: network: network is not built yet/u);
  });

  it('never echoes the value it refused', () => {
    const secret = 'sk-ant-do-not-print';
    for (const raw of [`{"models":["${secret}\\u0001"]}`, `{"models":"${secret}"}`, `${secret}`]) {
      let message = '';
      try {
        readDeploymentPolicy({ AW_DEPLOYMENT_POLICY: raw });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/^AW_DEPLOYMENT_POLICY is invalid: /u);
      expect(message).not.toContain(secret);
    }
  });
});
