import { describe, expect, it } from 'vitest';

import {
  GatewaySettingsError,
  readGatewayServerSettings,
  readGatewaySettings,
  startFailureFields,
} from './settings.js';

const TOKEN_SECRET = 't'.repeat(32);
const PRICING = JSON.stringify({
  version: 'test-1',
  models: { 'anthropic:*': { inputUsdPerMillion: '3', outputUsdPerMillion: '15' } },
});
const VALID = { GATEWAY_TOKEN_SECRET: TOKEN_SECRET, GATEWAY_PRICING_JSON: PRICING };

function refusal(read: () => unknown): GatewaySettingsError {
  try {
    read();
  } catch (error) {
    if (error instanceof GatewaySettingsError) return error;
    throw error;
  }
  throw new Error('expected the settings to be refused');
}

describe('readGatewaySettings', () => {
  it('reads the required values and leaves every optional feature off when unset', () => {
    const settings = readGatewaySettings(VALID);
    expect(settings).toMatchObject({
      tokenSecret: TOKEN_SECRET,
      pricing: { version: 'test-1' },
      toolSandboxAuth: undefined,
      controlPlaneOrigin: undefined,
      vertexProjectId: undefined,
      runnerManagerToken: undefined,
      scriptedModelsDir: undefined,
    });
  });

  it('reads each optional value', () => {
    const settings = readGatewaySettings({
      ...VALID,
      GATEWAY_TOOL_SANDBOX_AUTH: ' google-id-token ',
      GATEWAY_CONTROL_PLANE_ORIGIN: 'https://console.example.com/',
      GATEWAY_VERTEX_PROJECT_ID: ' project-1 ',
      RUNNER_MANAGER_TOKEN: 'manager-token',
      AW_SCRIPTED_MODELS_DIR: '/scripts',
      AW_DEPLOYMENT_POSTURE: 'local',
      HOST: '127.0.0.1',
    });
    expect(settings).toMatchObject({
      toolSandboxAuth: 'google-id-token',
      controlPlaneOrigin: 'https://console.example.com',
      vertexProjectId: 'project-1',
      runnerManagerToken: 'manager-token',
      scriptedModelsDir: '/scripts',
    });
  });

  it('treats a blank project id and an empty manager token as unset', () => {
    const settings = readGatewaySettings({
      ...VALID,
      GATEWAY_VERTEX_PROJECT_ID: '   ',
      RUNNER_MANAGER_TOKEN: '',
    });
    expect(settings.vertexProjectId).toBeUndefined();
    expect(settings.runnerManagerToken).toBeUndefined();
  });

  it('keeps the token secret as given: it is a key, not trimmed', () => {
    const secret = ` ${'k'.repeat(31)} `;
    expect(readGatewaySettings({ ...VALID, GATEWAY_TOKEN_SECRET: secret }).tokenSecret).toBe(
      secret,
    );
  });

  it.each([
    [
      { GATEWAY_TOKEN_SECRET: undefined },
      'GATEWAY_TOKEN_SECRET must contain at least 32 characters.',
    ],
    [
      { GATEWAY_TOKEN_SECRET: 't'.repeat(31) },
      'GATEWAY_TOKEN_SECRET must contain at least 32 characters.',
    ],
    [{ GATEWAY_PRICING_JSON: undefined }, 'GATEWAY_PRICING_JSON is required'],
    [{ GATEWAY_PRICING_JSON: '{' }, 'GATEWAY_PRICING_JSON is not valid JSON'],
    [
      { GATEWAY_TOOL_SANDBOX_AUTH: 'iap' },
      "GATEWAY_TOOL_SANDBOX_AUTH must be unset or 'google-id-token'.",
    ],
    [
      { GATEWAY_CONTROL_PLANE_ORIGIN: 'https://console.example.com/api' },
      'GATEWAY_CONTROL_PLANE_ORIGIN must be an http(s) origin',
    ],
    [{ AW_SCRIPTED_MODELS_DIR: 'scripts' }, 'AW_SCRIPTED_MODELS_DIR must be an absolute path.'],
    [
      { AW_SCRIPTED_MODELS_DIR: '/scripts', NODE_ENV: 'production' },
      'AW_SCRIPTED_MODELS_DIR is a test tool',
    ],
  ])('refuses %j by name', (override, reason) => {
    const error = refusal(() => readGatewaySettings({ ...VALID, ...override }));
    expect(error.message).toContain('Gateway start-up stopped on invalid settings.');
    expect(error.message).toContain(reason);
  });

  it('names every refused variable at once', () => {
    const error = refusal(() =>
      readGatewaySettings({ GATEWAY_TOOL_SANDBOX_AUTH: 'iap', AW_SCRIPTED_MODELS_DIR: 'x' }),
    );
    for (const name of [
      'GATEWAY_TOKEN_SECRET',
      'GATEWAY_PRICING_JSON',
      'GATEWAY_TOOL_SANDBOX_AUTH',
      'AW_SCRIPTED_MODELS_DIR',
    ]) {
      expect(error.message).toContain(name);
    }
  });

  it('never repeats a refused value', () => {
    const error = refusal(() =>
      readGatewaySettings({
        ...VALID,
        GATEWAY_TOKEN_SECRET: 'short-secret-value',
        GATEWAY_CONTROL_PLANE_ORIGIN: 'https://user:hidden-password@example.com',
      }),
    );
    expect(error.message).not.toContain('short-secret-value');
    expect(error.message).not.toContain('hidden-password');
  });
});

describe('readGatewayServerSettings', () => {
  it('listens on 0.0.0.0:4000 when HOST and PORT are unset', () => {
    expect(readGatewayServerSettings(VALID).listen).toEqual({ host: '0.0.0.0', port: 4000 });
  });

  it('reads HOST and PORT', () => {
    expect(readGatewayServerSettings({ ...VALID, HOST: '127.0.0.1', PORT: '4100' }).listen).toEqual(
      {
        host: '127.0.0.1',
        port: 4100,
      },
    );
  });

  it.each(['0', '65536', '4000garbage', '12.5', ' 4000', '4000 ', '', '-1'])(
    'refuses PORT %j',
    (port) => {
      expect(refusal(() => readGatewayServerSettings({ ...VALID, PORT: port })).message).toContain(
        'PORT must be an integer from 1 through 65535.',
      );
    },
  );

  it.each(['1', '65535'])('accepts PORT %s', (port) => {
    expect(readGatewayServerSettings({ ...VALID, PORT: port }).listen.port).toBe(Number(port));
  });

  it('names a bad PORT and a bad gateway setting in one error', () => {
    const error = refusal(() =>
      readGatewayServerSettings({ ...VALID, PORT: 'x', GATEWAY_TOOL_SANDBOX_AUTH: 'iap' }),
    );
    expect(error.message).toContain('PORT must be');
    expect(error.message).toContain('GATEWAY_TOOL_SANDBOX_AUTH');
    expect(error.message.match(/Gateway start-up stopped/gu)).toHaveLength(1);
  });
});

describe('startFailureFields', () => {
  it('logs every refused variable in its own field, so none is cut off', () => {
    const error = refusal(() =>
      readGatewayServerSettings({
        PORT: 'abc',
        GATEWAY_TOKEN_SECRET: 'short',
        GATEWAY_CONTROL_PLANE_ORIGIN: 'not a url',
      }),
    );
    // The joined message is past the 200 characters the logger keeps of one string field.
    expect(error.message.length).toBeGreaterThan(200);
    const fields = startFailureFields(error);
    expect(fields).toEqual({ refused: error.reasons });
    expect(error.reasons.some((reason) => reason.startsWith('PORT '))).toBe(true);
    expect(error.reasons.some((reason) => reason.startsWith('GATEWAY_TOKEN_SECRET '))).toBe(true);
    expect(error.reasons.some((reason) => reason.startsWith('GATEWAY_CONTROL_PLANE_ORIGIN '))).toBe(
      true,
    );
    for (const reason of error.reasons) expect(reason.length).toBeLessThanOrEqual(200);
  });

  it('logs any other failure as the error', () => {
    const error = new Error('database unreachable');
    expect(startFailureFields(error)).toEqual({ error });
  });
});
