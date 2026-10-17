import type { LocalRuntimeStartMessage } from '@indx-workspace/contracts/local-runtime';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { RESERVED_SECRET_NAMES } from '@indx-workspace/contracts/secret-reference';
import { describe, expect, it } from 'vitest';

import { EMBEDDED_DATABASE_PORT } from './embedded-db.js';
import {
  applyLocalRuntimeEnvironment,
  derivedServicePorts,
  HAND_SET_POLICY_WARNING,
  LOCAL_DEPLOYMENT_DEFAULT_MODELS_JSON,
  LocalRuntimeEnvironmentError,
  localRuntimePorts,
  LocalRuntimePortsBusyError,
  type LocalRuntimeVariable,
  UNCONFIGURED_PRICING_JSON,
} from './local-environment.js';
import { applyLocalSecrets, type LocalSecrets } from './local-secrets.js';

const start: LocalRuntimeStartMessage = {
  type: 'start',
  projectDir: '/home/dev/project',
  environment: {
    port: 3100,
    runtimeDriver: 'sandbox-runtime',
    bootstrapAdmin: 'dev@localhost.test',
  },
};

const options = { migrationsDir: '/opt/runtime/dist/migrations' };

function refusal(env: Record<string, string | undefined>, message = start): unknown {
  try {
    applyLocalRuntimeEnvironment(env, message, options);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('applyLocalRuntimeEnvironment (C1)', () => {
  it('sets every C1 variable', () => {
    const env: Record<string, string | undefined> = {};
    expect(applyLocalRuntimeEnvironment(env, start, options)).toStrictEqual({ warnings: [] });
    expect(env).toStrictEqual({
      HOST: '127.0.0.1',
      AW_DEPLOYMENT_POSTURE: 'local',
      AW_LOCAL_SURFACE_SESSIONS: '1',
      PORT: '3100',
      GATEWAY_PORT: '4100',
      RUNNER_PORT: '8180',
      AW_DATABASE_PORT: '25532',
      BOOTSTRAP_ADMIN: 'dev@localhost.test',
      RUNTIME_DRIVER: 'sandbox-runtime',
      NODE_ENV: 'production',
      MIGRATIONS_DIR: '/opt/runtime/dist/migrations',
      GATEWAY_PRICING_JSON: UNCONFIGURED_PRICING_JSON,
      AW_DEPLOYMENT_DEFAULT_MODELS: LOCAL_DEPLOYMENT_DEFAULT_MODELS_JSON,
    });
  });

  it('defaults the deployment default models per provider (C7, #506)', () => {
    expect(JSON.parse(LOCAL_DEPLOYMENT_DEFAULT_MODELS_JSON)).toStrictEqual({
      anthropic: 'claude-sonnet-4-5',
      openai: 'gpt-5.1',
    });
    const env: Record<string, string | undefined> = {};
    applyLocalRuntimeEnvironment(env, start, options);
    expect(env['AW_DEPLOYMENT_DEFAULT_MODELS']).toBe(LOCAL_DEPLOYMENT_DEFAULT_MODELS_JSON);
  });

  it('keeps a deployment default models value the environment or .env sets, an empty one included', () => {
    const configured: Record<string, string | undefined> = {
      AW_DEPLOYMENT_DEFAULT_MODELS: '{"anthropic":"claude-opus-4-1"}',
    };
    applyLocalRuntimeEnvironment(configured, start, options);
    expect(configured['AW_DEPLOYMENT_DEFAULT_MODELS']).toBe('{"anthropic":"claude-opus-4-1"}');

    const disabled: Record<string, string | undefined> = { AW_DEPLOYMENT_DEFAULT_MODELS: '' };
    applyLocalRuntimeEnvironment(disabled, start, options);
    expect(disabled['AW_DEPLOYMENT_DEFAULT_MODELS']).toBe('');
  });

  it('defaults the gateway price catalogue to the unconfigured sentinel, and keeps a set one', () => {
    expect(JSON.parse(UNCONFIGURED_PRICING_JSON)).toStrictEqual({
      version: 'unconfigured',
      models: { 'disabled:unconfigured': { inputUsdPerMillion: '0', outputUsdPerMillion: '0' } },
    });
    const env: Record<string, string | undefined> = { GATEWAY_PRICING_JSON: '{"version":"v1"}' };
    applyLocalRuntimeEnvironment(env, start, options);
    expect(env['GATEWAY_PRICING_JSON']).toBe('{"version":"v1"}');
  });

  it('leaves RUNTIME_DRIVER to the runtime when start names none, and keeps a set MIGRATIONS_DIR', () => {
    const env: Record<string, string | undefined> = { MIGRATIONS_DIR: '/custom' };
    applyLocalRuntimeEnvironment(
      env,
      { ...start, environment: { port: 3100, bootstrapAdmin: 'dev@localhost.test' } },
      options,
    );
    expect(env['RUNTIME_DRIVER']).toBeUndefined();
    expect(env['MIGRATIONS_DIR']).toBe('/custom');
  });

  it('forces NODE_ENV=production, the one value it overrides', () => {
    const env: Record<string, string | undefined> = { NODE_ENV: 'development' };
    applyLocalRuntimeEnvironment(env, start, options);
    expect(env['NODE_ENV']).toBe('production');
  });

  it('accepts a pre-existing value equal to the required one', () => {
    const env: Record<string, string | undefined> = { HOST: '127.0.0.1', PORT: '3100' };
    expect(refusal(env)).toBeUndefined();
  });

  it('refuses HOST=0.0.0.0 as a non-loopback host', () => {
    const error = refusal({ HOST: '0.0.0.0' });
    expect(error).toBeInstanceOf(LocalRuntimeEnvironmentError);
    if (!(error instanceof LocalRuntimeEnvironmentError)) return;
    expect(error.code).toBe('non_loopback_host');
    expect(error.message).toContain('local posture needs a loopback HOST');
    expect(error.message).not.toContain('0.0.0.0');
  });

  it.each<[LocalRuntimeVariable, string]>([
    ['PORT', '4999'],
    ['BOOTSTRAP_ADMIN', 'someone-else@corp.example'],
    ['AW_DEPLOYMENT_POSTURE', 'production'],
    ['AW_LOCAL_SURFACE_SESSIONS', '0'],
    ['RUNTIME_DRIVER', 'docker'],
  ])('refuses a conflicting %s, naming the variable and not its value', (variable, value) => {
    const env: Record<string, string | undefined> = { [variable]: value };
    const error = refusal(env);
    expect(error).toBeInstanceOf(LocalRuntimeEnvironmentError);
    if (!(error instanceof LocalRuntimeEnvironmentError)) return;
    expect(error.code).toBe('conflicting_value');
    expect(error.variable).toBe(variable);
    expect(error.message).toContain(variable);
    expect(error.message).not.toContain(value);
  });
  it('says how to choose the web port when PORT conflicts (BH061-012)', () => {
    expect(String(refusal({ PORT: '4999' }))).toContain('aw dev --port <n>');
  });
  it.each(['localhost', '::1', '127.0.0.2'])(
    'refuses the loopback HOST=%s as a conflicting value, without calling it non-loopback',
    (host) => {
      const error = refusal({ HOST: host });
      expect(error).toBeInstanceOf(LocalRuntimeEnvironmentError);
      if (!(error instanceof LocalRuntimeEnvironmentError)) return;
      expect(error.code).toBe('conflicting_value');
      expect(error.variable).toBe('HOST');
      expect(error.message).not.toContain('loopback');
      expect(error.message).toContain('the local runtime binds 127.0.0.1');
    },
  );

  it.each(['Bad Slug', '-leading', 'UPPER', 'a'.repeat(64)])(
    'refuses WORKSPACE_SLUG=%s before anything starts, naming the variable and not its value',
    (slug) => {
      const error = refusal({ WORKSPACE_SLUG: slug });
      expect(error).toBeInstanceOf(LocalRuntimeEnvironmentError);
      if (!(error instanceof LocalRuntimeEnvironmentError)) return;
      expect(error.code).toBe('invalid_value');
      expect(error.variable).toBe('WORKSPACE_SLUG');
      expect(error.message).not.toContain(slug);
    },
  );

  it('accepts a valid or blank WORKSPACE_SLUG', () => {
    for (const slug of ['team-a', '', '  ']) {
      expect(refusal({ WORKSPACE_SLUG: slug })).toBeUndefined();
    }
  });

  /** The start message with the project's web port set to `port`. */
  function onPort(port: number): LocalRuntimeStartMessage {
    return { ...start, environment: { ...start.environment, port } };
  }

  it.each([
    [4000, 'gateway', 'GATEWAY_PORT'],
    [8080, 'runner', 'RUNNER_PORT'],
  ] as const)(
    'refuses PORT=%i, the %s port the runtime binds first, before anything starts (issue #560)',
    (port, service, variable) => {
      const error = refusal({ [variable]: String(port) }, onPort(port));
      expect(error).toBeInstanceOf(LocalRuntimeEnvironmentError);
      if (!(error instanceof LocalRuntimeEnvironmentError)) return;
      expect(error.code).toBe('reserved_port');
      expect(error.variable).toBe('PORT');
      expect(error.reserved).toStrictEqual({ port, service, variable: undefined });
      expect(error.message).toBe(
        `port ${String(port)} is the local runtime's ${service} port; choose another environments.local.port`,
      );
    },
  );

  it.each([
    ['GATEWAY_PORT', 'gateway'],
    ['RUNNER_PORT', 'runner'],
  ] as const)('refuses a port a .env %s moved its service to', (variable, service) => {
    const error = refusal({ [variable]: '5000' }, onPort(5000));
    expect(error).toBeInstanceOf(LocalRuntimeEnvironmentError);
    if (!(error instanceof LocalRuntimeEnvironmentError)) return;
    expect(error.code).toBe('reserved_port');
    expect(error.reserved).toStrictEqual({ port: 5000, service, variable });
    // The clash comes from .env, so the message names the variable, not only the project file.
    expect(error.message).toBe(
      `port 5000 is the local runtime's ${service} port (${variable} in the environment or .env); change ${variable} or choose another environments.local.port`,
    );
  });

  it.each(['', '  '])(
    'reads a blank RUNNER_PORT (%j) as the fixed runner port, as the runner does',
    (blank) => {
      const error = refusal({ RUNNER_PORT: blank }, onPort(8080));
      expect(error).toBeInstanceOf(LocalRuntimeEnvironmentError);
      if (!(error instanceof LocalRuntimeEnvironmentError)) return;
      expect(error.reserved).toStrictEqual({ port: 8080, service: 'runner', variable: undefined });
    },
  );

  it.each([
    ['RUNNER_PORT', 'eighty', 8080],
    ['GATEWAY_PORT', '', 4000],
    ['GATEWAY_PORT', ' 4000', 4000],
  ] as const)(
    'reserves nothing for a %s (%j) its service refuses to start with',
    (variable, value, port) => {
      expect(refusal({ [variable]: value }, onPort(port))).toBeUndefined();
    },
  );

  it('refuses the embedded PostgreSQL port the runtime binds first (issue #560)', () => {
    const error = refusal(
      { AW_DATABASE_PORT: String(EMBEDDED_DATABASE_PORT) },
      onPort(EMBEDDED_DATABASE_PORT),
    );
    expect(error).toBeInstanceOf(LocalRuntimeEnvironmentError);
    if (!(error instanceof LocalRuntimeEnvironmentError)) return;
    expect(error.code).toBe('reserved_port');
    expect(error.reserved).toStrictEqual({
      port: EMBEDDED_DATABASE_PORT,
      service: 'database',
      variable: undefined,
    });
    expect(error.message).toBe(
      `port ${String(EMBEDDED_DATABASE_PORT)} is the local runtime's database port; choose another environments.local.port`,
    );
  });

  it('accepts the embedded PostgreSQL port when DATABASE_URL names another database', () => {
    expect(
      refusal({ DATABASE_URL: 'postgres://db.invalid/aw' }, onPort(EMBEDDED_DATABASE_PORT)),
    ).toBeUndefined();
  });

  it.each([
    ['GATEWAY_PORT', 4000],
    ['RUNNER_PORT', 8080],
  ] as const)('accepts the fixed port once a .env %s moves its service away', (variable, port) => {
    expect(refusal({ [variable]: '5000' }, onPort(port))).toBeUndefined();
  });
});

describe('derived service ports (#664)', () => {
  it.each([
    [3000, { GATEWAY_PORT: 4000, RUNNER_PORT: 8080, AW_DATABASE_PORT: EMBEDDED_DATABASE_PORT }],
    [3070, { GATEWAY_PORT: 4070, RUNNER_PORT: 8150, AW_DATABASE_PORT: 25_502 }],
    [80, { GATEWAY_PORT: 1080, RUNNER_PORT: 5160, AW_DATABASE_PORT: 22_512 }],
    // A derived port past 49151 keeps its fixed port.
    [
      30_000,
      { GATEWAY_PORT: 31_000, RUNNER_PORT: 35_080, AW_DATABASE_PORT: EMBEDDED_DATABASE_PORT },
    ],
    [60_000, { GATEWAY_PORT: 4000, RUNNER_PORT: 8080, AW_DATABASE_PORT: EMBEDDED_DATABASE_PORT }],
  ] as const)('moves the services with web port %i', (port, expected) => {
    expect(derivedServicePorts(port)).toStrictEqual(expected);
  });

  it('gives two projects on different web ports disjoint ports with no setting', () => {
    const portsOf = (port: number): string[] => {
      const env: Record<string, string | undefined> = {};
      applyLocalRuntimeEnvironment(
        env,
        { ...start, environment: { ...start.environment, port } },
        options,
      );
      return localRuntimePorts(env, port).map((entry) => String(entry.port));
    };
    const first = portsOf(3000);
    const second = portsOf(3070);
    expect(first).toStrictEqual(['3000', '4000', '8080', String(EMBEDDED_DATABASE_PORT)]);
    expect(second).toStrictEqual(['3070', '4070', '8150', '25502']);
  });

  it('keeps a set value, a blank one included, over the derived port', () => {
    const env: Record<string, string | undefined> = {
      GATEWAY_PORT: '4500',
      RUNNER_PORT: '',
      AW_DATABASE_PORT: '26000',
    };
    applyLocalRuntimeEnvironment(env, start, options);
    expect([env['GATEWAY_PORT'], env['RUNNER_PORT'], env['AW_DATABASE_PORT']]).toStrictEqual([
      '4500',
      '',
      '26000',
    ]);
  });
});

const policy: ProjectPolicy = {
  permissions: { writeFiles: false, readFiles: true },
  limits: { maxTurns: 5, maxBudgetUsd: 2.5 },
  engines: ['pi', 'claude-agent-sdk'],
};

/** {@link policy} as canonical JSON: keys sorted at every depth, array order kept, no whitespace. */
const CANONICAL_POLICY =
  '{"engines":["pi","claude-agent-sdk"],"limits":{"maxBudgetUsd":2.5,"maxTurns":5},"permissions":{"readFiles":true,"writeFiles":false}}';

const withPolicy: LocalRuntimeStartMessage = {
  ...start,
  environment: { ...start.environment, policy },
};

function expectRefusal(
  error: unknown,
  code: LocalRuntimeEnvironmentError['code'],
  variable: string,
): LocalRuntimeEnvironmentError {
  expect(error).toBeInstanceOf(LocalRuntimeEnvironmentError);
  if (!(error instanceof LocalRuntimeEnvironmentError)) throw new Error('not refused');
  expect(error.code).toBe(code);
  expect(error.variable).toBe(variable);
  expect(error.message).toContain(variable);
  return error;
}

describe('applyLocalRuntimeEnvironment policy ceiling (C13, SD5, #534)', () => {
  it('writes start.environment.policy as canonical JSON, with no warning', () => {
    const env: Record<string, string | undefined> = {};
    expect(applyLocalRuntimeEnvironment(env, withPolicy, options)).toStrictEqual({ warnings: [] });
    expect(env['AW_DEPLOYMENT_POLICY']).toBe(CANONICAL_POLICY);
  });

  it('leaves AW_DEPLOYMENT_POLICY unset when neither start nor the environment sets it', () => {
    const env: Record<string, string | undefined> = {};
    expect(applyLocalRuntimeEnvironment(env, start, options)).toStrictEqual({ warnings: [] });
    expect('AW_DEPLOYMENT_POLICY' in env).toBe(false);
  });

  describe.each([
    ['without policy', start],
    ['with policy', withPolicy],
  ])('%s', (_label, message) => {
    it.each(['{', '{"network":"open"}', '{"limits":{"maxTurns":0}}', '', '   ', 'null', '[]'])(
      'refuses the hand-set value %j as invalid_value, naming the variable and not the value',
      (value) => {
        const error = expectRefusal(
          refusal({ AW_DEPLOYMENT_POLICY: value }, message),
          'invalid_value',
          'AW_DEPLOYMENT_POLICY',
        );
        expect(error.message).toContain('JSON policy ceiling');
        if (value.trim() !== '') expect(error.message).not.toContain(value);
        expect(error.message).not.toContain('open');
      },
    );
  });

  it('refuses a hand-set value that differs from policy as conflicting_value', () => {
    for (const value of [
      '{"limits":{"maxTurns":6}}',
      '{"engines":["claude-agent-sdk","pi"],"limits":{"maxBudgetUsd":2.5,"maxTurns":5},"permissions":{"readFiles":true,"writeFiles":false}}',
    ]) {
      const error = expectRefusal(
        refusal({ AW_DEPLOYMENT_POLICY: value }, withPolicy),
        'conflicting_value',
        'AW_DEPLOYMENT_POLICY',
      );
      expect(error.message).not.toContain(value);
    }
  });

  it('starts on a hand-set value equal to policy in another key order and whitespace', () => {
    const env: Record<string, string | undefined> = {
      AW_DEPLOYMENT_POLICY:
        ' { "permissions": { "readFiles": true, "writeFiles": false },\n "limits": { "maxTurns": 5, "maxBudgetUsd": 2.5 }, "engines": ["pi", "claude-agent-sdk"] } ',
    };
    expect(applyLocalRuntimeEnvironment(env, withPolicy, options)).toStrictEqual({ warnings: [] });
    expect(env['AW_DEPLOYMENT_POLICY']).toBe(CANONICAL_POLICY);
  });

  it('keeps a valid hand-set value byte for byte when start sends no policy, and warns', () => {
    const handSet = '{ "limits": { "maxTurns": 3 } }';
    const env: Record<string, string | undefined> = { AW_DEPLOYMENT_POLICY: handSet };
    expect(applyLocalRuntimeEnvironment(env, start, options)).toStrictEqual({
      warnings: [HAND_SET_POLICY_WARNING],
    });
    expect(env['AW_DEPLOYMENT_POLICY']).toBe(handSet);
    expect(HAND_SET_POLICY_WARNING).toBe(
      'warning: AW_DEPLOYMENT_POLICY is set in the environment or .env and agent-workspace.yaml has no policy; that ceiling applies',
    );
  });
});

describe('applyLocalRuntimeEnvironment withheld secret names (SD17, C10, #534)', () => {
  const withheld: LocalRuntimeStartMessage = {
    ...start,
    environment: { ...start.environment, withheld: ['GITHUB_TOKEN', 'SLACK_TOKEN'] },
  };
  const secretValue = 'ghp_example-value-123';

  it.each(['GITHUB_TOKEN', 'github_token', 'Github_Token'])(
    'refuses %s set in .env, naming the withheld name and not the value',
    (key) => {
      const error = expectRefusal(
        refusal({ [key]: secretValue }, withheld),
        'withheld_secret_set',
        'GITHUB_TOKEN',
      );
      expect(error.message).toBe(
        'GITHUB_TOKEN is named by secret() and is set in .env; the local runtime holds no secret: remove it from .env and start aw dev with GITHUB_TOKEN in its environment',
      );
      expect(error.message).toContain('remove it from .env');
      expect(error.message).not.toContain(secretValue);
    },
  );

  it('refuses a withheld name set to a blank value', () => {
    expectRefusal(refusal({ SLACK_TOKEN: '' }, withheld), 'withheld_secret_set', 'SLACK_TOKEN');
  });

  it('refuses a withheld name before any C1 check', () => {
    expectRefusal(
      refusal({ HOST: '0.0.0.0', GITHUB_TOKEN: secretValue }, withheld),
      'withheld_secret_set',
      'GITHUB_TOKEN',
    );
  });

  it('starts when no withheld name is set, or one is present only as undefined', () => {
    expect(refusal({ OTHER_TOKEN: 'x', GITHUB_TOKEN: undefined }, withheld)).toBeUndefined();
  });

  it('starts as before on a start message without withheld', () => {
    expect(refusal({ GITHUB_TOKEN: secretValue })).toBeUndefined();
  });
});

// Scope: the two functions S2-04a owns. `startWorkspace` (workspace.ts) also writes or reads
// RUNNER_WORKSPACE_ROOT, RUNNER_URL, MODEL_GATEWAY_URL, RUNNER_PORT and GATEWAY_PORT, which
// RESERVED_SECRET_NAMES does not list yet; reserving them is a contracts follow-up (declared gap).
describe('applyLocalRuntimeEnvironment model secret names (issue #661)', () => {
  it('writes start.environment.modelSecrets as a JSON array, and nothing without it', () => {
    const env: Record<string, string | undefined> = {};
    applyLocalRuntimeEnvironment(
      env,
      { ...start, environment: { ...start.environment, modelSecrets: ['MAIN_MODEL_KEY'] } },
      options,
    );
    expect(env['AW_LOCAL_MODEL_SECRETS']).toBe('["MAIN_MODEL_KEY"]');
    const without: Record<string, string | undefined> = {};
    applyLocalRuntimeEnvironment(without, start, options);
    expect(without['AW_LOCAL_MODEL_SECRETS']).toBeUndefined();
  });
});

describe('the names applyLocalRuntimeEnvironment and applyLocalSecrets write (drift, #534, #565)', () => {
  it('are all in RESERVED_SECRET_NAMES', () => {
    const secrets: LocalSecrets = {
      SESSION_SECRET: 'a'.repeat(64),
      MASTER_ENCRYPTION_KEY: 'b'.repeat(64),
      GATEWAY_TOKEN_SECRET: 'c'.repeat(64),
      BOOTSTRAP_ADMIN_PASSWORD: 'correct-horse-battery',
    };
    const env: Record<string, string | undefined> = {};
    applyLocalRuntimeEnvironment(
      env,
      { ...withPolicy, environment: { ...withPolicy.environment, modelSecrets: ['MODEL_KEY'] } },
      options,
    );
    applyLocalSecrets(env, secrets);
    const reserved: readonly string[] = RESERVED_SECRET_NAMES;
    const written = Object.keys(env);
    expect(written).toContain('AW_DEPLOYMENT_POLICY');
    expect(written).toContain('RUNTIME_DRIVER');
    expect(written).toContain('SESSION_SECRET');
    expect(written).toContain('AW_LOCAL_MODEL_SECRETS');
    expect(written.filter((name) => !reserved.includes(name))).toStrictEqual([]);
  });
});

describe('localRuntimePorts (#660)', () => {
  const ports = (env: Record<string, string | undefined>, webPort = 3000) =>
    localRuntimePorts(env, webPort).map(
      ({ port, role, setting }) => `${String(port)} ${role} ${setting}`,
    );

  it('lists the web port and the fixed gateway, runner and database ports by default', () => {
    expect(ports({})).toStrictEqual([
      '3000 web environments.local.port in agent-workspace.yaml',
      '4000 gateway GATEWAY_PORT in .env',
      '8080 runner RUNNER_PORT in .env',
      `${String(EMBEDDED_DATABASE_PORT)} embedded PostgreSQL AW_DATABASE_PORT in .env`,
    ]);
  });

  it('follows the variables that move the services, and drops the database DATABASE_URL replaces', () => {
    expect(
      ports(
        {
          GATEWAY_PORT: '4100',
          RUNNER_PORT: ' 8180 ',
          DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/db',
        },
        3100,
      ),
    ).toStrictEqual([
      '3100 web environments.local.port in agent-workspace.yaml',
      '4100 gateway GATEWAY_PORT in .env',
      '8180 runner RUNNER_PORT in .env',
    ]);
    expect(ports({ AW_DATABASE_PORT: '25500' }).at(-1)).toBe(
      '25500 embedded PostgreSQL AW_DATABASE_PORT in .env',
    );
  });

  it('leaves out a port its service refuses on its own, and a privileged port', () => {
    expect(ports({ GATEWAY_PORT: 'not-a-port', RUNNER_PORT: '70000' }, 80)).toStrictEqual([
      `${String(EMBEDDED_DATABASE_PORT)} embedded PostgreSQL AW_DATABASE_PORT in .env`,
    ]);
  });
});

describe('LocalRuntimePortsBusyError (#660)', () => {
  it('names every busy port in one message and carries the first as an EADDRINUSE port', () => {
    const error = new LocalRuntimePortsBusyError([
      {
        port: 3000,
        role: 'web',
        setting: 'environments.local.port in agent-workspace.yaml',
        state: 'listening',
      },
      { port: 4000, role: 'gateway', setting: 'GATEWAY_PORT in .env', state: 'listening' },
    ]);
    expect(error.code).toBe('EADDRINUSE');
    expect(error.port).toBe(3000);
    expect(error.message.split('\n')).toStrictEqual([
      'the local runtime cannot start; nothing was started. These ports are not free:',
      '  port 3000 (web) is already in use: stop the process that holds it, or set environments.local.port in agent-workspace.yaml to a free port below 49152',
      '  port 4000 (gateway) is already in use: stop the process that holds it, or set GATEWAY_PORT in .env to a free port below 49152',
    ]);
  });
});
