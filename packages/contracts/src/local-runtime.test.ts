import { describe, expect, it } from 'vitest';

import {
  LOCAL_RUNTIME_MESSAGE_TYPES,
  LOCAL_RUNTIME_WITHHELD_MAX_ENTRIES,
  LocalRuntimeChildMessageSchema,
  LocalRuntimeCredentialMessageSchema,
  LocalRuntimeFailedMessageSchema,
  LocalRuntimeMessageSchema,
  LocalRuntimeParentMessageSchema,
  LocalRuntimeReadyMessageSchema,
  LocalRuntimeStartMessageSchema,
} from './local-runtime.js';

const start = {
  type: 'start',
  projectDir: '/home/dev/my-project',
  environment: {
    port: 3000,
    runtimeDriver: 'sandbox-runtime',
    bootstrapAdmin: 'admin@localhost.test',
  },
} as const;

const ready = { type: 'ready', url: 'http://127.0.0.1:3000', contractsVersion: '0.2.1' } as const;

const credential = {
  type: 'credential',
  token: `ak_live_${'a'.repeat(22)}_${'B'.repeat(43)}`,
  expiresAt: '2026-10-02T12:00:00.000Z',
  workspaceId: '0b9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e',
  workspaceSlug: 'local',
} as const;

const failed = { type: 'failed', message: 'Port 3000 is already in use.' } as const;

describe('local-runtime messages', () => {
  it('lists the four message types', () => {
    expect(LOCAL_RUNTIME_MESSAGE_TYPES).toEqual(['start', 'ready', 'credential', 'failed']);
    expect(
      LocalRuntimeMessageSchema.options.map((option) => option.unwrap().shape.type.value),
    ).toEqual([...LOCAL_RUNTIME_MESSAGE_TYPES]);
  });

  it.each([
    ['start', LocalRuntimeStartMessageSchema, start],
    ['ready', LocalRuntimeReadyMessageSchema, ready],
    ['credential', LocalRuntimeCredentialMessageSchema, credential],
    ['failed', LocalRuntimeFailedMessageSchema, failed],
  ] as const)('accepts a valid %s message and refuses an unknown key', (_name, schema, example) => {
    expect(schema.safeParse(example).success).toBe(true);
    expect(LocalRuntimeMessageSchema.safeParse(example).success).toBe(true);
    const result = schema.safeParse({ ...example, extra: true });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      path: [],
      keys: ['extra'],
    });
  });

  it('accepts start without a runtime driver', () => {
    const environment = { port: 3000, bootstrapAdmin: 'admin@localhost.test' };
    expect(LocalRuntimeStartMessageSchema.safeParse({ ...start, environment }).success).toBe(true);
  });

  it('refuses an unknown key inside start.environment', () => {
    const result = LocalRuntimeStartMessageSchema.safeParse({
      ...start,
      environment: { ...start.environment, storage: 'compose' },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      path: ['environment'],
      keys: ['storage'],
    });
  });

  it.each([0, 70000, 3000.5])('refuses port %s', (port) => {
    const result = LocalRuntimeStartMessageSchema.safeParse({
      ...start,
      environment: { ...start.environment, port },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['environment', 'port']);
  });

  it('refuses an unknown runtime driver and a malformed bootstrap admin', () => {
    expect(
      LocalRuntimeStartMessageSchema.safeParse({
        ...start,
        environment: { ...start.environment, runtimeDriver: 'firecracker' },
      }).success,
    ).toBe(false);
    expect(
      LocalRuntimeStartMessageSchema.safeParse({
        ...start,
        environment: { ...start.environment, bootstrapAdmin: 'admin@localhost' },
      }).success,
    ).toBe(false);
  });

  it.each(['', '/home/dev/a\0b', 'x'.repeat(4097)])('refuses projectDir %j', (projectDir) => {
    expect(LocalRuntimeStartMessageSchema.safeParse({ ...start, projectDir }).success).toBe(false);
  });

  it('carries a token only on the credential message', () => {
    const withToken = LocalRuntimeMessageSchema.options
      .map((option) => option.unwrap().shape)
      .filter((shape) => Object.keys(shape).includes('token'))
      .map((shape) => shape.type.value);
    expect(withToken).toEqual(['credential']);
  });

  it.each(['http://127.0.0.1:3000', 'http://localhost:3000/', 'https://[::1]:8443'])(
    'accepts loopback ready url %s',
    (url) => {
      expect(LocalRuntimeReadyMessageSchema.safeParse({ ...ready, url }).success).toBe(true);
    },
  );

  it.each([
    'http://0.0.0.0:3000',
    'https://example.com',
    'http://127.0.0.1.example.com:3000',
    'ftp://127.0.0.1/',
    'file:///tmp/socket',
    'not a url',
  ])('refuses non-loopback ready url %s', (url) => {
    const result = LocalRuntimeReadyMessageSchema.safeParse({ ...ready, url });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['url']);
  });

  it.each(['0.2', 'v0.2.1', '0.2.1-beta', '00.2.1'])(
    'refuses contractsVersion %s',
    (contractsVersion) => {
      const result = LocalRuntimeReadyMessageSchema.safeParse({ ...ready, contractsVersion });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['contractsVersion']);
    },
  );

  it('accepts a whole workspace API key as the token', () => {
    const token = `ak_live_${'-_0aZ'.repeat(4)}xy_${'Q'.repeat(43)}`;
    expect(LocalRuntimeCredentialMessageSchema.safeParse({ ...credential, token }).success).toBe(
      true,
    );
  });

  it.each([
    'ak_live_x',
    `ak_live_${'a'.repeat(22)}`,
    `ak_live_${'a'.repeat(21)}_${'B'.repeat(43)}`,
    `ak_live_${'a'.repeat(22)}_${'B'.repeat(42)}`,
    `ak_live_${'a'.repeat(22)}_${'B'.repeat(42)}=`,
    ` ak_live_${'a'.repeat(22)}_${'B'.repeat(43)}`,
    `awu_live_${'a'.repeat(22)}_${'B'.repeat(43)}`,
    `awt_live_${'a'.repeat(22)}_${'B'.repeat(43)}`,
    '',
  ])('refuses a token that is not a workspace API key: %j', (token) => {
    const result = LocalRuntimeCredentialMessageSchema.safeParse({ ...credential, token });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['token']);
  });

  it('refuses an empty or overlong failure message', () => {
    expect(LocalRuntimeFailedMessageSchema.safeParse({ ...failed, message: '' }).success).toBe(
      false,
    );
    expect(
      LocalRuntimeFailedMessageSchema.safeParse({ ...failed, message: 'x'.repeat(4097) }).success,
    ).toBe(false);
  });

  it('refuses a message travelling the wrong way', () => {
    expect(LocalRuntimeParentMessageSchema.safeParse(start).success).toBe(true);
    expect(LocalRuntimeParentMessageSchema.safeParse(ready).success).toBe(false);
    expect(LocalRuntimeParentMessageSchema.safeParse(credential).success).toBe(false);
    expect(LocalRuntimeChildMessageSchema.safeParse(start).success).toBe(false);
    for (const message of [ready, credential, failed]) {
      expect(LocalRuntimeChildMessageSchema.safeParse(message).success).toBe(true);
    }
  });
});

describe('local-runtime review regressions (#439)', () => {
  it.each([
    'http://user:pw@127.0.0.1:3000',
    'http://u@localhost:1/',
    'http:\\localhost',
    'http://LOCALHOST:3000',
    'http://0x7f000001/',
    'http://127.1',
    'http://localhost:3000/?',
    'http://localhost:3000/#x',
    'http://localhost:3000/?a=1',
  ])('refuses the non-canonical or credentialed ready url %j', (url) => {
    expect(LocalRuntimeReadyMessageSchema.safeParse({ ...ready, url }).success).toBe(false);
  });

  it.each(['http://127.0.0.1:3000/', 'http://localhost:3000/base', 'https://[::1]'])(
    'still accepts the canonical ready url %j',
    (url) => {
      expect(LocalRuntimeReadyMessageSchema.safeParse({ ...ready, url }).success).toBe(true);
    },
  );

  it.each(['\u001b]52;c;ZXZpbA==\u0007boom', '\u001b[2Jboom', 'a\rb', 'a\u0085b', 'a\u0000b'])(
    'refuses a failure message with a control character: %j',
    (message) => {
      expect(LocalRuntimeFailedMessageSchema.safeParse({ ...failed, message }).success).toBe(false);
    },
  );

  it('accepts a failure message with a line feed and a tab', () => {
    const message = 'Port 3000 is in use.\n\tStop the other process.';
    expect(LocalRuntimeFailedMessageSchema.safeParse({ ...failed, message }).success).toBe(true);
  });

  it.each(['../../x', ' ', '\u001b[2J', 'Local', '-local', 'local-', '', 'a'.repeat(64)])(
    'refuses the workspace slug %j',
    (workspaceSlug) => {
      expect(
        LocalRuntimeCredentialMessageSchema.safeParse({ ...credential, workspaceSlug }).success,
      ).toBe(false);
    },
  );

  it.each(['a', 'my-team-1', 'a'.repeat(63)])('accepts the workspace slug %j', (workspaceSlug) => {
    expect(
      LocalRuntimeCredentialMessageSchema.safeParse({ ...credential, workspaceSlug }).success,
    ).toBe(true);
  });

  it.each([
    'aws-ecs',
    'external',
    'vercel-sandbox',
    'cloudflare-sandbox',
    'gke-agent-sandbox',
    'aws-agentcore',
    'cloud-run-sandbox',
  ])('refuses the unimplemented runtime driver %s in start', (runtimeDriver) => {
    const message = { ...start, environment: { ...start.environment, runtimeDriver } };
    expect(LocalRuntimeStartMessageSchema.safeParse(message).success).toBe(false);
  });
});

describe('start.environment.policy (C13, issue #524)', () => {
  it('parses a start message with no policy, as before', () => {
    expect(LocalRuntimeStartMessageSchema.parse(start)).toEqual(start);
  });

  it('parses a start message carrying the project policy', () => {
    const policy = {
      permissions: { runCommands: false },
      engines: ['claude-agent-sdk'],
      tools: [],
    };
    const message = { ...start, environment: { ...start.environment, policy } };
    expect(LocalRuntimeStartMessageSchema.parse(message)).toEqual(message);
  });

  it.each<[string, Record<string, unknown>, (string | number)[]]>([
    [
      'a null limit',
      { limits: { maxTurns: null } },
      ['environment', 'policy', 'limits', 'maxTurns'],
    ],
    ['a key not built yet', { network: 'open' }, ['environment', 'policy', 'network']],
    ['connections', { connections: [] }, ['environment', 'policy']],
  ])('refuses a policy with %s under environment.policy', (_name, policy, path) => {
    const message = { ...start, environment: { ...start.environment, policy } };
    const result = LocalRuntimeStartMessageSchema.safeParse(message);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([path]);
  });
});

describe('start.environment.features (ADR-0160 D5, issue #1495)', () => {
  it('parses a start message with no features, as before', () => {
    expect(LocalRuntimeStartMessageSchema.parse(start)).toEqual(start);
  });

  it('parses a start message carrying the project features, in order', () => {
    const message = {
      ...start,
      environment: { ...start.environment, features: ['files', 'chat'] },
    };
    expect(LocalRuntimeStartMessageSchema.parse(message)).toEqual(message);
  });

  it.each<[string, unknown]>([
    ['an empty list', []],
    ['a repeated feature', ['chat', 'chat']],
    ['a feature without its dependency', ['surfaces']],
    ['an unknown feature', ['nope']],
    ['a comma-separated string', 'chat,files'],
  ])('refuses %s under environment.features', (_name, features) => {
    const message = { ...start, environment: { ...start.environment, features } };
    const result = LocalRuntimeStartMessageSchema.safeParse(message);
    expect(result.success).toBe(false);
    for (const issue of result.error?.issues ?? []) {
      expect(issue.path.slice(0, 2)).toEqual(['environment', 'features']);
    }
  });
});

describe('start.environment.modelSecrets (issue #661)', () => {
  const withSecrets = (modelSecrets: unknown): Record<string, unknown> => ({
    ...start,
    environment: { ...start.environment, modelSecrets },
  });

  it('parses the names, and a start message without them as before', () => {
    expect(LocalRuntimeStartMessageSchema.parse(start).environment.modelSecrets).toBeUndefined();
    expect(
      LocalRuntimeStartMessageSchema.parse(withSecrets(['MAIN_MODEL_KEY'])).environment
        .modelSecrets,
    ).toEqual(['MAIN_MODEL_KEY']);
  });

  it('refuses a reserved name, a pasted value and a repeat', () => {
    const pasted = 'sk-ant-test-SENTINEL';
    for (const names of [['PATH'], [pasted], ['KEY', 'KEY']]) {
      const result = LocalRuntimeStartMessageSchema.safeParse(withSecrets(names));
      expect(result.success).toBe(false);
      expect(result.error?.message).not.toContain(pasted);
    }
  });
});

describe('start.environment.withheld (issue #564)', () => {
  function withWithheld(withheld: unknown): Record<string, unknown> {
    return { ...start, environment: { ...start.environment, withheld } };
  }

  it('parses a start message with no withheld, as before', () => {
    expect(LocalRuntimeStartMessageSchema.parse(start).environment.withheld).toBeUndefined();
  });

  it('parses withheld names and freezes the list', () => {
    const parsed = LocalRuntimeStartMessageSchema.parse(
      withWithheld(['GITHUB_TOKEN', 'ORDERS_TOKEN']),
    );
    expect(parsed.environment.withheld).toEqual(['GITHUB_TOKEN', 'ORDERS_TOKEN']);
    expect(Object.isFrozen(parsed.environment.withheld)).toBe(true);
  });

  const pasted = 'sk-live-0123456789abcdefSECRETVALUE';

  it.each<[string, unknown]>([
    ['a lower-case name', 'github_token'],
    ['a pasted value', pasted],
    ['a reserved name', 'PATH'],
    ['a number', 42],
  ])('refuses %s at its index', (_name, entry) => {
    const result = LocalRuntimeStartMessageSchema.safeParse(withWithheld([entry]));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ['environment', 'withheld', 0],
    ]);
    expect(result.error?.message).not.toContain(pasted);
  });

  it('names a reserved entry with the reserved message', () => {
    const result = LocalRuntimeStartMessageSchema.safeParse(withWithheld(['GITHUB_TOKEN', 'path']));
    expect(result.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [
        ['environment', 'withheld', 1],
        'PATH is a variable the local runtime uses; name the secret something else',
      ],
    ]);
  });

  it('refuses a repeated name', () => {
    const result = LocalRuntimeStartMessageSchema.safeParse(withWithheld(['TOKEN', 'TOKEN']));
    expect(result.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [['environment', 'withheld'], 'must not repeat a name'],
    ]);
  });

  it('bounds the list', () => {
    const names = Array.from(
      { length: LOCAL_RUNTIME_WITHHELD_MAX_ENTRIES + 1 },
      (_, i) => `TOKEN_${String(i)}`,
    );
    const atBound = withWithheld(names.slice(0, LOCAL_RUNTIME_WITHHELD_MAX_ENTRIES));
    expect(LocalRuntimeStartMessageSchema.safeParse(atBound).success).toBe(true);
    const result = LocalRuntimeStartMessageSchema.safeParse(withWithheld(names));
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['environment', 'withheld']]);
  });

  it('is a parent-direction message only', () => {
    const message = withWithheld(['GITHUB_TOKEN']);
    expect(LocalRuntimeParentMessageSchema.safeParse(message).success).toBe(true);
    expect(LocalRuntimeChildMessageSchema.safeParse(message).success).toBe(false);
  });
});
