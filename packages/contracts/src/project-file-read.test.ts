import { identity, storage } from './project-file.fixture.test-support.js';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { LocalRuntimeStartMessageSchema } from './local-runtime.js';

import {
  BOOTSTRAP_ADMIN_MAX_LENGTH,
  BootstrapAdminSchema,
  DEFAULT_LOCAL_PORT,
  DEPLOYMENT_V1_API_VERSION,
  IMPLEMENTED_RUNTIME_DRIVERS,
  PROJECT_API_VERSION,
  ProjectDocumentSchema,
  readProjectDocument,
} from './project-file.js';

import { minimal, v1, without, refusedPaths } from './project-file.fixture.test-support.js';

it('reads a v2 document as written, lifted: false', () => {
  const result = readProjectDocument(minimal);
  expect(result).toEqual({ success: true, data: { lifted: false, project: minimal } });
});

it('lifts a v1 local profile to environments.local, keeping its storage', () => {
  const result = readProjectDocument(v1('local'));
  expect(result).toEqual({
    success: true,
    data: {
      lifted: true,
      project: {
        apiVersion: PROJECT_API_VERSION,
        kind: 'Project',
        environments: {
          local: {
            cloud: 'local',
            storage,
            runtime: { default: 'docker' },
            identity: { bootstrapAdmin: 'owner@example.com', oidc: 'https://issuer.example.com' },
          },
        },
      },
    },
  });
});

it.each(['aws', 'gcp', 'azure'] as const)(
  'lifts a v1 %s profile to environments.production',
  (cloud) => {
    const result = readProjectDocument(v1(cloud));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.lifted).toBe(true);
    expect(result.data.project.environments).toEqual({
      production: {
        cloud,
        storage,
        runtime: { default: 'docker' },
        identity: { bootstrapAdmin: 'owner@example.com', oidc: 'https://issuer.example.com' },
      },
    });
    expect('name' in result.data.project).toBe(false);
  },
);

it('lifts a v1 profile with no envelope and writes no absent oidc key', () => {
  const bare = without(v1('local'), 'apiVersion', 'kind');
  const result = readProjectDocument({ ...bare, identity: { bootstrapAdmin: 'o@example.com' } });
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data.lifted).toBe(true);
  const environment =
    'local' in result.data.project.environments
      ? result.data.project.environments.local
      : undefined;
  expect(environment?.identity).toEqual({ bootstrapAdmin: 'o@example.com' });
  expect(Object.keys(environment?.identity ?? {})).toEqual(['bootstrapAdmin']);
});

it('refuses an unknown apiVersion at apiVersion, naming both versions', () => {
  const result = readProjectDocument({ ...minimal, apiVersion: 'agentworkspace.dev/v3' });
  expect(refusedPaths(result)).toEqual([['apiVersion']]);
  const message = result.success ? '' : (result.error.issues[0]?.message ?? '');
  expect(message).toContain(PROJECT_API_VERSION);
  expect(message).toContain(DEPLOYMENT_V1_API_VERSION);
});

it('refuses a kind that contradicts its apiVersion at kind', () => {
  expect(refusedPaths(readProjectDocument({ ...v1('aws'), kind: 'Project' }))).toEqual([['kind']]);
  expect(refusedPaths(readProjectDocument({ ...minimal, kind: 'Deployment' }))).toEqual([['kind']]);
});

it('reads kind Project without an apiVersion as v2 and refuses it there', () => {
  expect(refusedPaths(readProjectDocument(without(minimal, 'apiVersion')))).toEqual([
    ['apiVersion'],
  ]);
});

it('refuses the v2 document refusals through the reader too', () => {
  const document = { ...minimal, environments: { local: { cloud: 'local', identity, storage } } };
  expect(refusedPaths(readProjectDocument(document))).toEqual([
    ['environments', 'local', 'storage'],
  ]);
});

it.each([null, 'text', 42, []])('refuses %j without throwing', (value) => {
  expect(readProjectDocument(value).success).toBe(false);
});

function withAdmin(bootstrapAdmin: string): Record<string, unknown> {
  return {
    ...minimal,
    environments: { local: { cloud: 'local', identity: { bootstrapAdmin } } },
  };
}

function startWith(bootstrapAdmin: string): Record<string, unknown> {
  return {
    type: 'start',
    projectDir: '/home/dev/demo',
    environment: { port: DEFAULT_LOCAL_PORT, bootstrapAdmin },
  };
}

it('accepts a bootstrap admin at the length bound in both the project file and start', () => {
  const atBound = `${'a'.repeat(BOOTSTRAP_ADMIN_MAX_LENGTH - '@example.com'.length)}@example.com`;
  expect(atBound).toHaveLength(BOOTSTRAP_ADMIN_MAX_LENGTH);
  expect(ProjectDocumentSchema.safeParse(withAdmin(atBound)).success).toBe(true);
  expect(LocalRuntimeStartMessageSchema.safeParse(startWith(atBound)).success).toBe(true);
});

it('refuses a bootstrap admin over the bound, as start does', () => {
  const over = `${'a'.repeat(BOOTSTRAP_ADMIN_MAX_LENGTH - '@example.com'.length + 1)}@example.com`;
  expect(refusedPaths(ProjectDocumentSchema.safeParse(withAdmin(over)))).toEqual([
    ['environments', 'local', 'identity', 'bootstrapAdmin'],
  ]);
  expect(LocalRuntimeStartMessageSchema.safeParse(startWith(over)).success).toBe(false);
});

it('refuses a very long bootstrap admin without running the pattern over it', () => {
  const hostile = `a@${'.'.repeat(160_000)}@`;
  const started = performance.now();
  const result = readProjectDocument(withAdmin(hostile));
  expect(performance.now() - started).toBeLessThan(250);
  expect(result.success).toBe(false);
  expect(result.success ? [] : result.error.issues.map((issue) => issue.code)).toEqual(['too_big']);
});

const CONTROL_CHARACTERS = [
  ['NUL', '\u0000'],
  ['ESC', '\u001b'],
  ['US', '\u001f'],
  ['DEL', '\u007f'],
  ['PAD', '\u0080'],
  ['NEL', '\u0085'],
  ['APC', '\u009f'],
] as const;

function issueMessages(result: {
  readonly success: boolean;
  readonly error?: z.ZodError;
}): string[] {
  return result.error?.issues.map((issue) => issue.message) ?? [];
}

it.each(CONTROL_CHARACTERS)(
  'refuses a bootstrap admin holding %s in the schema, the project file and start',
  (_name, control) => {
    const value = `ow${control}ner@example.com`;
    const message = ['must not contain a control character'];
    expect(issueMessages(BootstrapAdminSchema.safeParse(value))).toEqual(message);
    const project = ProjectDocumentSchema.safeParse(withAdmin(value));
    expect(refusedPaths(project)).toEqual([
      ['environments', 'local', 'identity', 'bootstrapAdmin'],
    ]);
    expect(issueMessages(project)).toEqual(message);
    expect(issueMessages(LocalRuntimeStartMessageSchema.safeParse(startWith(value)))).toEqual(
      message,
    );
  },
);

it('accepts a bootstrap admin holding a printable non-ASCII character, which is not Cc', () => {
  const value = 'ren\u00e9@example.com';
  expect(BootstrapAdminSchema.safeParse(value).success).toBe(true);
  expect(ProjectDocumentSchema.safeParse(withAdmin(value)).success).toBe(true);
  expect(LocalRuntimeStartMessageSchema.safeParse(startWith(value)).success).toBe(true);
});

it('lets U+00A0 past the control check, leaving it to the email pattern', () => {
  const result = BootstrapAdminSchema.safeParse('ow\u00a0ner@example.com');
  expect(issueMessages(result)).not.toContain('must not contain a control character');
});

it('still accepts a plain bootstrap admin address', () => {
  expect(BootstrapAdminSchema.safeParse('owner@example.com').success).toBe(true);
});

it('refuses a v1 profile with apiVersion and no kind, as the CLI does', () => {
  expect(refusedPaths(readProjectDocument(without(v1('local'), 'kind')))).toEqual([['kind']]);
});

it('still lifts a v1 profile with no envelope at all', () => {
  const result = readProjectDocument(without(v1('local'), 'apiVersion', 'kind'));
  expect(result.success && result.data.lifted).toBe(true);
});

it('refuses a padded v1 text value the CLI would trim (documented difference)', () => {
  const padded = { ...v1('local'), identity: { bootstrapAdmin: ' admin@localhost.test ' } };
  expect(refusedPaths(readProjectDocument(padded))).toEqual([['identity', 'bootstrapAdmin']]);
});

it.each([
  'aws-ecs',
  'external',
  'vercel-sandbox',
  'cloudflare-sandbox',
  'gke-agent-sandbox',
  'aws-agentcore',
  'cloud-run-sandbox',
])('refuses the unimplemented runtime driver %s in v2 and in a v1 lift', (driver) => {
  const v2 = {
    ...minimal,
    environments: { local: { cloud: 'local', runtime: { default: driver }, identity } },
  };
  expect(refusedPaths(ProjectDocumentSchema.safeParse(v2))).toEqual([
    ['environments', 'local', 'runtime', 'default'],
  ]);
  const lifted = { ...v1('aws'), runtime: { default: driver } };
  expect(refusedPaths(readProjectDocument(lifted))).toEqual([['runtime', 'default']]);
});

it('accepts every implemented runtime driver', () => {
  for (const driver of IMPLEMENTED_RUNTIME_DRIVERS) {
    const v2 = {
      ...minimal,
      environments: { local: { cloud: 'local', runtime: { default: driver }, identity } },
    };
    expect(ProjectDocumentSchema.safeParse(v2).success).toBe(true);
  }
});

it('freezes a lifted v1 document throughout, as a parsed v2 document is', () => {
  const result = readProjectDocument(v1('local'));
  expect(result.success).toBe(true);
  if (!result.success) return;
  const { project } = result.data;
  expect(Object.isFrozen(project)).toBe(true);
  expect(Object.isFrozen(project.environments)).toBe(true);
  expect(Object.isFrozen(project.environments.local)).toBe(true);
});
