import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  A11_CONDITIONAL_ENV_VARS,
  A11_UNCONDITIONAL_ENV_VARS,
  buildRuntimeEnvironment,
  CREDENTIAL_SECRET_NAME_SUFFIXES,
  type RuntimeEnvironmentInput,
} from './env.js';
import { baseInput } from './env.test-support.js';

describe('buildRuntimeEnvironment — the emitted key set equals the derived set, exactly', () => {
  it('emits exactly the five unconditional keys when no condition holds', () => {
    const env = buildRuntimeEnvironment(baseInput);
    expect(Object.keys(env).sort()).toEqual([...A11_UNCONDITIONAL_ENV_VARS].sort());
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: baseInput.gatewayBaseUrl,
      ANTHROPIC_AUTH_TOKEN: baseInput.authToken,
      CLAUDE_CONFIG_DIR: baseInput.configDir,
      AGENT_WORKSPACE_RUN_ID: baseInput.runId,
      AGENT_WORKSPACE_SESSION_ID: baseInput.sessionId,
    });
  });

  it('drives both branches of the Node version condition', () => {
    const sub24 = buildRuntimeEnvironment({ ...baseInput, nodeMajorVersion: 23 });
    expect(sub24['NODE_USE_ENV_PROXY']).toBeUndefined();

    const at24 = buildRuntimeEnvironment({ ...baseInput, nodeMajorVersion: 24 });
    expect(at24['NODE_USE_ENV_PROXY']).toBe('1');

    const above24 = buildRuntimeEnvironment({ ...baseInput, nodeMajorVersion: 25 });
    expect(above24['NODE_USE_ENV_PROXY']).toBe('1');
  });

  it("defaults nodeMajorVersion to this process's own — asserted against a real probe, not assumed", () => {
    // This task's plan cell records `node -v` → `v24.19.0` on the machine it was written on.
    // Rather than transcribe that number (ADR-0016), read it from the running process.
    // `Number.parseInt`, not `.split('.')` — see env.ts's `currentNodeMajorVersion` for why.
    const thisMajor = Number.parseInt(process.versions.node, 10);
    const { nodeMajorVersion: _drop, ...withoutVersion } = baseInput;
    void _drop;
    const env = buildRuntimeEnvironment(withoutVersion);
    expect(env['NODE_USE_ENV_PROXY']).toBe(thisMajor >= 24 ? '1' : undefined);
  });

  it('emits HTTP_PROXY and HTTPS_PROXY together, for restricted and open with a configured proxy', () => {
    // ADR-0117 decision 8: `open` is the public internet *through* the proxy, so it is proxied too.
    for (const networkPolicy of ['restricted', 'open'] as const) {
      const withProxy = buildRuntimeEnvironment({
        ...baseInput,
        networkPolicy,
        proxyUrl: 'http://proxy.internal.example:3128',
      });
      expect(withProxy['HTTP_PROXY']).toBe('http://proxy.internal.example:3128');
      expect(withProxy['HTTPS_PROXY']).toBe('http://proxy.internal.example:3128');

      const withoutProxy = buildRuntimeEnvironment({ ...baseInput, networkPolicy });
      expect(withoutProxy['HTTP_PROXY']).toBeUndefined();
      expect(withoutProxy['HTTPS_PROXY']).toBeUndefined();
    }

    // The condition is the policy, not merely "a proxyUrl was supplied": `none` must ignore one
    // even if a caller passed it, which an implementation keyed only on `proxyUrl` would not.
    const none = buildRuntimeEnvironment({
      ...baseInput,
      networkPolicy: 'none',
      proxyUrl: 'http://proxy.internal.example:3128',
    });
    expect(none['HTTP_PROXY']).toBeUndefined();
    expect(none['HTTPS_PROXY']).toBeUndefined();
  });

  it('emits OTEL_EXPORTER_OTLP_ENDPOINT only when a collector is configured', () => {
    const withCollector = buildRuntimeEnvironment({
      ...baseInput,
      otelExporterOtlpEndpoint: 'http://otel-collector.internal.example:4318',
    });
    expect(withCollector['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe(
      'http://otel-collector.internal.example:4318',
    );
    expect(buildRuntimeEnvironment(baseInput)['OTEL_EXPORTER_OTLP_ENDPOINT']).toBeUndefined();
  });

  it('emits exactly all nine derived keys when every condition holds', () => {
    const env = buildRuntimeEnvironment({
      ...baseInput,
      nodeMajorVersion: 24,
      networkPolicy: 'restricted',
      proxyUrl: 'http://proxy.internal.example:3128',
      otelExporterOtlpEndpoint: 'http://otel-collector.internal.example:4318',
    });
    expect(Object.keys(env).sort()).toEqual(
      [...A11_UNCONDITIONAL_ENV_VARS, ...A11_CONDITIONAL_ENV_VARS].sort(),
    );
  });

  it('ANTHROPIC_AUTH_TOKEN is run-scoped: two runs, two tokens, never a shared constant', () => {
    const runA = buildRuntimeEnvironment({ ...baseInput, runId: 'run-a', authToken: 'token-a' });
    const runB = buildRuntimeEnvironment({ ...baseInput, runId: 'run-b', authToken: 'token-b' });
    expect(runA['ANTHROPIC_AUTH_TOKEN']).toBe('token-a');
    expect(runB['ANTHROPIC_AUTH_TOKEN']).toBe('token-b');
    expect(runA['ANTHROPIC_AUTH_TOKEN']).not.toBe(runB['ANTHROPIC_AUTH_TOKEN']);
  });

  it('ANTHROPIC_API_KEY is asserted absent — never a key, under any input', () => {
    const env = buildRuntimeEnvironment(baseInput);
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
    // The attempted-smuggling path: a secret assigned to the agent that happens to be named the
    // provider master credential must be refused outright, not merged in.
    expect(() =>
      buildRuntimeEnvironment({ ...baseInput, secrets: { ANTHROPIC_API_KEY: 'sk-ant-stolen' } }),
    ).toThrow(/ANTHROPIC_API_KEY/);
    expect(() =>
      buildRuntimeEnvironment({ ...baseInput, secrets: { anthropic_api_key: 'sk-ant-stolen' } }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('refuses a credential-shaped agent secret name, which every engine would refuse to run', () => {
    for (const name of ['OPENAI_API_KEY', 'stripe_api_key', 'GITHUB_AUTH_TOKEN']) {
      expect(() =>
        buildRuntimeEnvironment({ ...baseInput, secrets: { [name]: 'a-real-secret' } }),
      ).toThrow(/spelled like a credential/);
    }
    // A secret that is not credential-shaped is still emitted unchanged.
    const env = buildRuntimeEnvironment({ ...baseInput, secrets: { GITHUB_TOKEN: 'ghp_x' } });
    expect(env['GITHUB_TOKEN']).toBe('ghp_x');
  });

  it("restates the engine port's credential suffixes exactly", () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../engine/src/sandbox-env.ts', import.meta.url)),
      'utf8',
    );
    const match = /CREDENTIAL_ENV_SUFFIXES = \[([^\]]*)\] as const/u.exec(source);
    expect(match).not.toBeNull();
    const suffixes = [...(match?.[1] ?? '').matchAll(/'([^']+)'/gu)].map((found) => found[1]);
    expect(suffixes).toEqual([...CREDENTIAL_SECRET_NAME_SUFFIXES]);
  });

  it('refuses a secret whose name collides with a reserved A.11 key', () => {
    expect(() =>
      buildRuntimeEnvironment({ ...baseInput, secrets: { CLAUDE_CONFIG_DIR: '/elsewhere' } }),
    ).toThrow(/reserved/);
    expect(() =>
      buildRuntimeEnvironment({ ...baseInput, secrets: { claude_config_dir: '/elsewhere' } }),
    ).toThrow(/reserved/);
  });

  it('refuses duplicate agent secret names under case-insensitive Windows semantics', () => {
    expect(() =>
      buildRuntimeEnvironment({
        ...baseInput,
        secrets: { GITHUB_TOKEN: 'first', github_token: 'second' },
      }),
    ).toThrow(/duplicate agent secret name/u);
  });

  it('emits an own __proto__ environment entry without prototype mutation', () => {
    const secrets = JSON.parse('{"__proto__":"prototype-secret"}') as Record<string, string>;
    const env = buildRuntimeEnvironment({ ...baseInput, secrets });
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(env, '__proto__')).toBe(true);
    expect(env['__proto__']).toBe('prototype-secret');

    const observed = execFileSync(
      process.execPath,
      [
        '-e',
        "const key=Object.keys(process.env).find((name)=>name==='__proto__'); process.stdout.write(JSON.stringify(key && process.env[key]));",
      ],
      { env, encoding: 'utf8' },
    );
    expect(JSON.parse(observed)).toBe('prototype-secret');
  });

  it('two agents, two different secrets: diffing the two emitted environments isolates exactly the secrets', () => {
    const agentA = buildRuntimeEnvironment({
      ...baseInput,
      secrets: { GITHUB_TOKEN: 'gh-a', JIRA_TOKEN: 'jira-a' },
    });
    const agentB = buildRuntimeEnvironment({
      ...baseInput,
      secrets: { STRIPE_KEY: 'sk-b' },
    });
    const onlyInA = Object.keys(agentA).filter((key) => !(key in agentB));
    const onlyInB = Object.keys(agentB).filter((key) => !(key in agentA));
    expect(onlyInA.sort()).toEqual(['GITHUB_TOKEN', 'JIRA_TOKEN']);
    expect(onlyInB.sort()).toEqual(['STRIPE_KEY']);
    // Everything else — the five unconditional keys — is identical between the two, because
    // nothing about which agent it is changes them.
    for (const key of A11_UNCONDITIONAL_ENV_VARS) {
      expect(agentA[key]).toBe(agentB[key]);
    }
  });

  it('rejects malformed input by name (ADR-0015): missing fields, bad networkPolicy', () => {
    expect(() => buildRuntimeEnvironment({ ...baseInput, gatewayBaseUrl: '' })).toThrow(
      /gatewayBaseUrl/,
    );
    expect(() =>
      buildRuntimeEnvironment({
        ...baseInput,
        networkPolicy: 'bogus' as unknown as RuntimeEnvironmentInput['networkPolicy'],
      }),
    ).toThrow(/networkPolicy/);
  });
});
