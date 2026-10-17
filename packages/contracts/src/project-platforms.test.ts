import { describe, expect, it } from 'vitest';

import { PLATFORM_IDS } from './platform-ids.js';
import { PROJECT_API_VERSION, ProjectDocumentSchema } from './project-file.js';
import { ProjectPlatformsSchema } from './project-platforms.js';

const minimal = {
  apiVersion: PROJECT_API_VERSION,
  kind: 'Project',
  name: 'demo',
  environments: { local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } } },
};

const MESSAGE_SECRET = 'must be a secret reference { secret: NAME }, never a value (C10)';
const MESSAGE_URL =
  'must not carry a credential; name it as a secret reference { secret: NAME } (C10)';

/** Every refusal of a project whose `platforms` is `platforms`, as `[path, message]` (an unrecognised key is pushed onto its path). */
function refusal(platforms: unknown): readonly [readonly PropertyKey[], string][] {
  const result = ProjectDocumentSchema.safeParse({ ...minimal, platforms });
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((issue) => [
    issue.code === 'unrecognized_keys' ? [...issue.path, ...issue.keys] : issue.path,
    issue.message,
  ]);
}

const copilot = (binding: unknown) => ({ 'copilot-studio': binding });

/** An object holding an own `__proto__` key, as a YAML reader builds it. */
function withOwnProto(value: unknown): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  Object.defineProperty(record, '__proto__', {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return record;
}

describe('ProjectPlatformsSchema', () => {
  it('names exactly the platform ids, in order', () => {
    expect(Object.keys(ProjectPlatformsSchema.unwrap().shape)).toEqual([...PLATFORM_IDS]);
  });

  it('accepts the documented example and an empty block', () => {
    const example = {
      'claude-managed-agents': { enabled: true },
      'copilot-studio': {
        enabled: true,
        options: {
          environmentUrl: 'https://contoso.crm.dynamics.com',
          clientSecret: { secret: 'COPILOT_CLIENT_SECRET' },
        },
        environments: {
          production: { environmentUrl: 'https://contoso-prod.crm.dynamics.com' },
        },
      },
    };
    const parsed = ProjectDocumentSchema.parse({ ...minimal, platforms: example });
    expect(parsed.platforms).toEqual(example);
    expect(ProjectDocumentSchema.safeParse({ ...minimal, platforms: {} }).success).toBe(true);
  });

  it('parses a document without platforms exactly as before', () => {
    const parsed = ProjectDocumentSchema.parse(minimal);
    expect('platforms' in parsed).toBe(false);
  });

  it('refuses a key that is not a platform, listing the ids', () => {
    expect(refusal({ copilot: { enabled: true } })).toEqual([
      [['platforms', 'copilot'], `is not a platform; use one of ${PLATFORM_IDS.join(', ')}`],
    ]);
  });

  it('refuses an own __proto__ directly under platforms as an unrecognised key', () => {
    expect(refusal(withOwnProto({ enabled: true }))).toEqual([
      [['platforms', '__proto__'], `is not a platform; use one of ${PLATFORM_IDS.join(', ')}`],
    ]);
  });

  it('requires enabled', () => {
    expect(refusal(copilot({ options: {} }))).toEqual([
      [['platforms', 'copilot-studio', 'enabled'], 'is required: true or false'],
    ]);
  });

  it('refuses a credential value at its full path without echoing it', () => {
    const result = refusal(copilot({ enabled: true, options: { clientSecret: 'abc123' } }));
    expect(result).toEqual([
      [['platforms', 'copilot-studio', 'options', 'clientSecret'], MESSAGE_SECRET],
    ]);
    expect(JSON.stringify(result)).not.toContain('abc123');
  });

  it('refuses a nested credential value', () => {
    expect(refusal(copilot({ enabled: true, options: { auth: { accessToken: 'abc' } } }))).toEqual([
      [['platforms', 'copilot-studio', 'options', 'auth', 'accessToken'], MESSAGE_SECRET],
    ]);
  });

  it('refuses a credential value inside an array, at its index', () => {
    expect(refusal(copilot({ enabled: true, options: { headers: [{ apiKey: 'x' }] } }))).toEqual([
      [['platforms', 'copilot-studio', 'options', 'headers', 0, 'apiKey'], MESSAGE_SECRET],
    ]);
  });

  it('refuses a credential value under an environment override', () => {
    expect(refusal(copilot({ enabled: true, environments: { local: { password: 'x' } } }))).toEqual(
      [[['platforms', 'copilot-studio', 'environments', 'local', 'password'], MESSAGE_SECRET]],
    );
  });

  it('accepts a key that only mentions a credential word (tokenUrl)', () => {
    const platforms = copilot({
      enabled: true,
      options: { tokenUrl: 'https://login.example/token' },
    });
    expect(ProjectDocumentSchema.safeParse({ ...minimal, platforms }).success).toBe(true);
  });

  it('refuses a reserved secret name at the reference path', () => {
    const result = refusal(
      copilot({ enabled: true, options: { clientSecret: { secret: 'PATH' } } }),
    );
    expect(result).toEqual([
      [
        ['platforms', 'copilot-studio', 'options', 'clientSecret', 'secret'],
        'PATH is a variable the local runtime uses; name the secret something else',
      ],
    ]);
  });

  it('refuses an environment other than local and production', () => {
    expect(refusal(copilot({ enabled: true, environments: { staging: {} } }))).toEqual([
      [['platforms', 'copilot-studio', 'environments', 'staging'], expect.any(String)],
    ]);
  });

  it('refuses a URL that carries a credential without echoing it', () => {
    const result = refusal(
      copilot({ enabled: true, options: { endpoint: 'https://u:p4ss@x.example' } }),
    );
    expect(result).toEqual([[['platforms', 'copilot-studio', 'options', 'endpoint'], MESSAGE_URL]]);
    expect(JSON.stringify(result)).not.toContain('p4ss');
  });

  it.each([
    ['options', { enabled: true, options: withOwnProto({ x: 1 }) }, ['options', '__proto__']],
    [
      'environments.production',
      { enabled: true, environments: { production: withOwnProto({ x: 1 }) } },
      ['environments', 'production', '__proto__'],
    ],
  ])('refuses an own __proto__ key inside %s', (_name, binding, path) => {
    expect(refusal(copilot(binding))).toEqual([
      [['platforms', 'copilot-studio', ...path], 'is a reserved key'],
    ]);
  });
});
