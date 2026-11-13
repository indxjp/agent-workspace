import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect } from 'vitest';

import { PLATFORM_IMAGE_VERSION } from '../release-images.js';
import { databaseUrl, project, type Respond } from './deploy.test-support.js';
import type { ToolInvocation } from './runner.js';

export const token = 'vcp_secret_token_value_0123456789';

export const manifest = (name: string, dependencies: Record<string, string> = {}) =>
  JSON.stringify({ name, dependencies });

/** A platform checkout: `apps/web`, at the release the project's images were resolved for. */
function createPlatformCheckout(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-platform-'));
  const directories = [
    ['apps', 'web', 'node_modules', 'next'],
    ['packages', 'cli', 'src'],
    ['apps', 'runner', 'src', 'api'],
    ['packages', 'gateway', 'src', 'api'],
    ['.git'],
    ['.nx', 'cache'],
  ];
  for (const directory of directories)
    mkdirSync(path.join(root, ...directory), { recursive: true });
  const files: readonly (readonly [readonly string[], string])[] = [
    [['package.json'], manifest('platform')],
    [['pnpm-workspace.yaml'], 'packages:\n  - apps/*\n'],
    [['.git', 'HEAD'], 'ref: refs/heads/main\n'],
    [['.nx', 'cache', 'entry'], 'cached'],
    [['apps', 'web', 'node_modules', 'next', 'index.js'], ''],
    [
      ['apps', 'web', 'package.json'],
      manifest('@agent-workspace/web', { '@agent-workspace/gateway': 'workspace:*' }),
    ],
    [['apps', 'runner', 'package.json'], manifest('runner')],
    [['packages', 'gateway', 'package.json'], manifest('@agent-workspace/gateway')],
    [['packages', 'gateway', 'src', 'index.ts'], ''],
    [['packages', 'gateway', 'src', 'api', 'index.ts'], ''],
    [['apps', 'runner', 'src', 'api', 'index.ts'], ''],
    [
      ['packages', 'cli', 'src', 'release-images.json'],
      JSON.stringify({ version: PLATFORM_IMAGE_VERSION }),
    ],
  ];
  for (const [segments, content] of files) writeFileSync(path.join(root, ...segments), content);
  return root;
}

export const platform = createPlatformCheckout();
afterAll(() => {
  rmSync(platform, { recursive: true, force: true });
});

export const vercelEnvironment = {
  VERCEL_TOKEN: token,
  VERCEL_TEAM_ID: 'team_acme',
  AGENT_WORKSPACE_SOURCE: platform,
};

/** Set one `.env` line of a project, replacing the line it already has. */
export async function setEnv(target: string, name: string, value: string): Promise<void> {
  const file = path.join(target, '.env');
  const lines = (await readFile(file, 'utf8'))
    .split('\n')
    .filter((line) => !line.startsWith(`${name}=`));
  await writeFile(file, `${lines.join('\n').replace(/\n*$/u, '\n')}${name}=${value}\n`);
}

export const vcrImage = `acme/acme-ai-manager/agent-workspace-runtime@sha256:${'a'.repeat(64)}`;

/** A Vercel project whose `.env` carries the `DATABASE_URL` a Neon integration would set remotely. */
export async function vercelProject(databaseValue = databaseUrl): Promise<string> {
  const target = await project('vercel');
  const file = path.join(target, '.env');
  const text = await readFile(file, 'utf8');
  expect(text).toContain('\nDATABASE_URL=\n');
  await writeFile(
    file,
    `${text
      .replace('\nDATABASE_URL=\n', `\nDATABASE_URL=${databaseValue}\n`)
      .replace(/^OBJECT_STORAGE_ACCESS_KEY_ID=.*$/mu, 'OBJECT_STORAGE_ACCESS_KEY_ID=object-key')
      .replace(
        /^OBJECT_STORAGE_SECRET_ACCESS_KEY=.*$/mu,
        'OBJECT_STORAGE_SECRET_ACCESS_KEY=object-secret',
      )}VERCEL_SANDBOX_RUNTIME_IMAGE=${vcrImage}\n`,
  );
  return target;
}

/** `project inspect` and `env ls` answers: the project is absent, or present with `listed` names. */
export const vercelResponder =
  (exists: boolean, listed: readonly string[] = [], echo = ''): Respond =>
  ({ args }) => {
    if (args[1] === 'inspect') {
      return exists
        ? { stdout: `Name acme-ai ${echo}` }
        : { status: 1, stderr: `Error: Project not found ${echo}` };
    }
    if (args[0] === 'env' && args[1] === 'ls') {
      return { stdout: listed.map((name) => `${name}  Encrypted  Production\n`).join('') };
    }
    return { stdout: echo, stderr: echo };
  };

export const changesOf = (calls: readonly ToolInvocation[]) =>
  calls.filter(({ args }) => args[1] === 'add');

/** Each project's variables, by what `vercel env add` was given on stdin. */
export const variablesByProject = (calls: readonly ToolInvocation[]) => {
  const byProject = new Map<string, Map<string, string>>();
  for (const call of calls.filter(({ args }) => args[0] === 'env' && args[1] === 'add')) {
    const project = call.env['VERCEL_PROJECT_ID'] ?? '';
    const variables = byProject.get(project) ?? new Map<string, string>();
    variables.set(call.args[2] ?? '', call.input ?? '');
    byProject.set(project, variables);
  }
  return byProject;
};

export const controlPlaneAdds = (calls: readonly ToolInvocation[]) =>
  changesOf(calls)
    .filter(({ env }) => env['VERCEL_PROJECT_ID'] === 'acme-ai')
    .map(({ args }) => args[2]);
