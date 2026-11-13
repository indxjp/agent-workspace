import { describe, expect, it } from 'vitest';

import { readRunnerManagerOptions, RunnerManagerSettingsError } from './manager-settings.js';

/**
 * A driver setting the runtime package also checks is refused by its variable name, not by the
 * runtime's option name (`project`, `poolManagementEndpoint`, `networkName`), which an operator
 * cannot map back to what they set.
 */

const TOKEN = 'm'.repeat(32);
const IMAGES = {
  AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'alpine:3.20',
  RUNNER_MANAGER_TOKEN: TOKEN,
};
const CLOUD_RUN = {
  ...IMAGES,
  RUNTIME_DRIVER: 'cloud-run-service',
  RUNTIME_NETWORK: 'net',
  RUNTIME_SUBNETWORK: 'subnet',
  GCP_PROJECT: 'project',
  GCP_REGION: 'asia-northeast1',
  RUNTIME_SERVICE_ACCOUNT: 'runtime@project.iam.gserviceaccount.com',
};
const ACA = {
  RUNTIME_DRIVER: 'aca-sessions',
  RUNNER_MANAGER_TOKEN: TOKEN,
  ACA_SESSION_POOL_ENDPOINT: 'https://pool.example.net',
};

function reasons(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  try {
    readRunnerManagerOptions(env);
  } catch (error) {
    if (error instanceof RunnerManagerSettingsError) return error.reasons;
    throw error;
  }
  throw new Error('expected the settings to be refused');
}

describe('cloud-run-service driver settings', () => {
  it('accepts a complete configuration', () => {
    expect(() => readRunnerManagerOptions(CLOUD_RUN)).not.toThrow();
  });

  for (const name of ['GCP_PROJECT', 'GCP_REGION', 'RUNTIME_SERVICE_ACCOUNT'] as const) {
    it(`refuses ${name} unset or blank, by name`, () => {
      for (const value of [undefined, '', '   ']) {
        expect(reasons({ ...CLOUD_RUN, [name]: value })).toEqual([
          `runner manager: ${name} must be set when RUNTIME_DRIVER is cloud-run-service.`,
        ]);
      }
    });
  }

  it('still reports a missing network before the project, as it did', () => {
    const [reason] = reasons({ ...CLOUD_RUN, RUNTIME_NETWORK: undefined, GCP_PROJECT: undefined });
    expect(reason).toMatch(/needs RUNTIME_NETWORK and RUNTIME_SUBNETWORK/u);
  });
});

describe('aca-sessions driver settings', () => {
  it('accepts a complete configuration', () => {
    expect(() => readRunnerManagerOptions(ACA)).not.toThrow();
  });

  it('refuses ACA_SESSION_POOL_ENDPOINT unset or blank, by name', () => {
    for (const value of [undefined, '', '  ']) {
      expect(reasons({ ...ACA, ACA_SESSION_POOL_ENDPOINT: value })).toEqual([
        'runner manager: ACA_SESSION_POOL_ENDPOINT must be set when RUNTIME_DRIVER is aca-sessions.',
      ]);
    }
  });

  it('names ACA_SESSION_POOL_ENDPOINT when the runtime refuses its value', () => {
    for (const value of ['not a url', 'http://pool.example.net', 'https://u:p@pool.example.net']) {
      const [reason] = reasons({ ...ACA, ACA_SESSION_POOL_ENDPOINT: value });
      expect(reason).toMatch(/^runner manager: ACA_SESSION_POOL_ENDPOINT is refused\. /u);
      expect(reason).not.toContain(value);
    }
  });

  for (const name of ['ACA_SESSION_POOL_API_VERSION', 'ACA_SESSION_API_VERSION'] as const) {
    it(`refuses a blank ${name} by name, and keeps the default when it is unset`, () => {
      expect(reasons({ ...ACA, [name]: ' ' })).toEqual([
        `runner manager: ${name} is blank; unset it or give it a value when RUNTIME_DRIVER is aca-sessions.`,
      ]);
      expect(() => readRunnerManagerOptions({ ...ACA, [name]: undefined })).not.toThrow();
    });
  }
});

describe('docker driver settings', () => {
  it('refuses a blank RUNTIME_NETWORK by name, and keeps the default when it is unset', () => {
    expect(reasons({ ...IMAGES, RUNTIME_NETWORK: '' })).toEqual([
      'runner manager: RUNTIME_NETWORK is blank; unset it or give it a value when RUNTIME_DRIVER is docker.',
    ]);
    expect(() => readRunnerManagerOptions(IMAGES)).not.toThrow();
  });

  it('refuses a blank AGENT_WORKSPACE_TOOL_NETWORK by name when a tool sandbox is configured', () => {
    const tools = { ...IMAGES, AGENT_WORKSPACE_TOOL_HOST_IMAGE: 'tool-host:1' };
    expect(reasons({ ...tools, AGENT_WORKSPACE_TOOL_NETWORK: ' ' })).toEqual([
      'runner manager: AGENT_WORKSPACE_TOOL_NETWORK is blank; unset it or give it a value when RUNTIME_DRIVER is docker.',
    ]);
    expect(() => readRunnerManagerOptions(tools)).not.toThrow();
  });
});
