import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, vi } from 'vitest';

import { createWorkspace, DEFAULT_ANSWERS } from '../create.js';
import { parseEnvironment, type DeploymentImages } from '../deployment.js';
import type { DeploymentCloud } from '../profile.js';
import type { ToolInvocation, ToolResult, ToolRunner } from './runner.js';

const created: string[] = [];
export const toolHostTemplate = 'aw-tool-host:223e4567-e89b-42d3-a456-426614174111';
export const databaseUrl = 'postgres://neondb_owner:np_secret_pw@db.neon.example/aw';
export const runtimeImageKey = 'AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK';
export const digest = (character: string) => `sha256:${character.repeat(64)}`;
const platformImages: DeploymentImages = {
  web: `registry.example/web@${digest('1')}`,
  gateway: `registry.example/gateway@${digest('2')}`,
  runner: `registry.example/runner@${digest('3')}`,
  runtime: `registry.example/runtime@${digest('4')}`,
};
const composeImages: DeploymentImages = {
  ...platformImages,
  postgres: `registry.example/postgres@${digest('5')}`,
  seaweedfs: `registry.example/seaweedfs@${digest('6')}`,
};
/** No `AW_*_IMAGE` override: every image comes from the project's own `.env` pins. */
export const environment = {};

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

export async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

export async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-deploy-test-'));
  created.push(directory);
  return directory;
}

/** A project's `web/`, which a frontend is built from. */
export async function frontend(): Promise<string> {
  const directory = path.join(await temporaryDirectory(), 'web');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), '{}');
  return directory;
}

export async function project(cloud: DeploymentCloud): Promise<string> {
  const target = path.join(await temporaryDirectory(), 'acme-ai');
  await createWorkspace(target, cloud === 'local' ? DEFAULT_ANSWERS : null, {
    cloud,
    images: cloud === 'local' ? composeImages : platformImages,
  });
  return target;
}

/** An `infra/` with an initialised module for each cloud and the chart's directory. */
export async function infra(): Promise<string> {
  const directory = await temporaryDirectory();
  for (const module of ['gcp-cloudrun', 'azure-container-apps']) {
    await mkdir(path.join(directory, 'terraform', module, '.terraform'), { recursive: true });
  }
  await mkdir(path.join(directory, 'helm', 'agent-workspace'), { recursive: true });
  return directory;
}

/** The `.env` credentials a tool could echo, which no output may contain. */
export async function secretsOf(target: string): Promise<readonly string[]> {
  const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
  const secrets = [
    env['SESSION_SECRET'],
    env['GATEWAY_TOKEN_SECRET'],
    env['RUNNER_MANAGER_TOKEN'],
    env['BOOTSTRAP_ADMIN_PASSWORD'],
    env['DATABASE_URL'],
    env['POSTGRES_PASSWORD'],
  ].filter((value): value is string => value !== undefined && value.length >= 4);
  expect(secrets.length).toBeGreaterThanOrEqual(3);
  return secrets;
}

export type Respond = (invocation: ToolInvocation) => Partial<ToolResult>;

/** A runner that records every invocation and answers from `respond`; nothing real is spawned. */
export function stubRunner(respond: Respond): { runner: ToolRunner; calls: ToolInvocation[] } {
  const calls: ToolInvocation[] = [];
  const runner: ToolRunner = (invocation) => {
    calls.push(invocation);
    return Promise.resolve({ status: 0, stdout: '', stderr: '', ...respond(invocation) });
  };
  return { runner, calls };
}

/** Everything written to stdout and stderr while `run` ran. */
export async function captured<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  const written: string[] = [];
  const capture = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  try {
    return { result: await run(), output: written.join('') };
  } finally {
    vi.restoreAllMocks();
  }
}

export async function capturedFailure(
  run: () => Promise<unknown>,
): Promise<{ message: string; output: string }> {
  let message = '';
  const { output } = await captured(async () => {
    try {
      await run();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
  });
  expect(message).not.toBe('');
  return { message, output };
}

/** Replace every object store location line of a project's `.env` with `lines` (`NAME=value`). */
export async function setStorage(target: string, lines: readonly string[]): Promise<void> {
  const file = path.join(target, '.env');
  const kept = (await readFile(file, 'utf8'))
    .split('\n')
    .filter(
      (line) =>
        !/^(OBJECT_STORAGE_(BACKEND|ENDPOINT|BUCKET|FORCE_PATH_STYLE)|AW_(FILE|SKILL)_STORAGE_ROOT|AW_SESSION_TRANSCRIPT_ROOT|AW_STORAGE_URL)=/u.test(
          line,
        ),
    );
  await writeFile(file, `${kept.join('\n').replace(/\n*$/u, '\n')}${lines.join('\n')}\n`);
}

/** Old location lines a `.env` may still carry, with a value that must never be echoed. */
export const oldStorageLines = (secret: string): readonly string[] => [
  'OBJECT_STORAGE_BACKEND=s3',
  `OBJECT_STORAGE_BUCKET=${secret}`,
  `OBJECT_STORAGE_ENDPOINT=https://${secret}.example.com`,
];

/** `docker compose up`, `helm upgrade` or `terraform apply`: a call that changes a deployment. */
export function isApply({ tool, args }: ToolInvocation): boolean {
  if (tool === 'docker') return args[0] === 'compose' && args[1] === 'up';
  if (tool === 'helm') return args[0] === 'upgrade';
  return args[1] === 'apply';
}

/** Docker answers for a project whose `web` service is out of date. */
export const composeResponder =
  (changed: boolean, echo = ''): Respond =>
  ({ args }) => {
    if (args.includes('--hash')) return { stdout: 'postgres aaa\nweb bbb\n' };
    if (args[0] === 'ps') {
      return {
        stdout: `postgres\taaa\trunning\nweb\t${changed ? 'old' : 'bbb'}\trunning\n`,
      };
    }
    return { stdout: echo, stderr: echo };
  };

const planJson = (changed: boolean): string =>
  JSON.stringify({
    format_version: '1.2',
    terraform_version: '1.16.7',
    resource_changes: [
      {
        address: 'azurerm_resource_group.main',
        type: 'azurerm_resource_group',
        name: 'main',
        change: { actions: [changed ? 'create' : 'no-op'] },
      },
    ],
    applyable: changed,
    complete: true,
    errored: false,
  });

/** Terraform, whose plan exits `planStatus` (2 with changes, 0 without, unless a wrapper says 0). */
export const terraformResponder =
  (changed: boolean, echo = '', planStatus = changed ? 2 : 0): Respond =>
  ({ args }) => {
    if (args.includes('plan'))
      return { status: planStatus, stdout: `Plan: ${echo}\n`, stderr: echo };
    if (args.includes('show')) return { stdout: planJson(changed) };
    return { stdout: `Apply complete! ${echo}\n` };
  };

export const helmResponder =
  (withDiff: boolean, echo = ''): Respond =>
  ({ args }) => {
    if (args[0] === 'plugin') {
      return { stdout: `NAME\tVERSION\tDESCRIPTION\n${withDiff ? 'diff\t3.9.0\tPreview\n' : ''}` };
    }
    if (args[0] === 'diff') return { status: 2, stdout: `+ image ${echo}\n` };
    if (args[0] === 'template') {
      return {
        stdout:
          '---\n# Source: c/templates/web.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n' +
          `---\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\n  annotations:\n    x: ${echo}\n`,
      };
    }
    return { stdout: `Release upgraded ${echo}\n` };
  };
