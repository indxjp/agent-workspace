import { rm } from 'node:fs/promises';
import path from 'node:path';

import type { PublishPlatformOptions } from '@indx-workspace/cli/publish';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { runCli, tempDirectory, tempFile } from '../testing.js';

// These tests start a real child process (the project loader or the tool host): a second or more
// each on a shared CI runner, past vitest's 5 s default when several run.
vi.setConfig({ testTimeout: 30_000 });

interface Call {
  readonly tool: string;
  readonly args: readonly string[];
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
}

const GCLOUD_TOKEN = 'ya29.test-token';
const AZ_TOKEN = 'eyJ.test-az-token';
const FOUNDRY_PROJECT = 'https://acme.services.ai.azure.com/api/projects/support';

// The real executors run; only the process runner is faked.
const calls = vi.hoisted((): Call[] => []);
const fetches = vi.hoisted((): FetchCall[] => []);
vi.mock('@indx-workspace/cli/publish', async (importOriginal) => {
  const publish = await importOriginal<typeof import('@indx-workspace/cli/publish')>();
  return {
    ...publish,
    publishPlatform: (options: PublishPlatformOptions) =>
      publish.publishPlatform({
        ...options,
        runner: (invocation) => {
          calls.push({ tool: invocation.tool, args: invocation.args });
          const stdout =
            invocation.tool === 'az'
              ? invocation.args[0] === 'account'
                ? `${AZ_TOKEN}\n`
                : '{"azure-cli": "2.70.0"}\n'
              : invocation.tool === 'gcloud'
                ? invocation.args[0] === 'auth'
                  ? `${GCLOUD_TOKEN}\n`
                  : 'Google Cloud SDK 540.0.0\n'
                : invocation.args[0] === 'help'
                  ? 'Microsoft PowerPlatform CLI\nVersion: 2.4.1+g1\n'
                  : '';
          return Promise.resolve({ status: 0, stdout, stderr: '' });
        },
        fetch: (input, init) => {
          const url = input instanceof Request ? input.url : input.toString();
          fetches.push({
            url,
            method: init?.method ?? 'GET',
            authorization: new Headers(init?.headers).get('authorization'),
          });
          if (url.startsWith('https://acme.services.ai.azure.com/')) {
            return Promise.resolve(
              new Response('{"error":{"code":"NotFound"}}', {
                status: 404,
                headers: { 'content-type': 'application/json' },
              }),
            );
          }
          return Promise.resolve(
            url.endsWith('/.well-known/agent-card.json')
              ? new Response('{}', { status: 200 })
              : new Response('{"agents":[]}', {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }),
          );
        },
      }),
  };
});

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PROJECT = `apiVersion: agentworkspace.dev/v2
kind: Project
name: acme-ai
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
platforms:
  copilot-studio:
    enabled: true
    options:
      publisherPrefix: acme
`;

const GEMINI_PROJECT = `apiVersion: agentworkspace.dev/v2
kind: Project
name: acme-ai
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
platforms:
  gemini-enterprise:
    enabled: true
    options:
      projectId: acme-agents
      location: global
      engineId: acme-support-app
      publicBaseUrl: https://aw.example.com
`;

const FOUNDRY_PROJECT_YAML = `apiVersion: agentworkspace.dev/v2
kind: Project
name: acme-ai
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
platforms:
  microsoft-foundry:
    enabled: true
    options:
      modelDeployment: claude-sonnet-4-6
      projectEndpoint: ${FOUNDRY_PROJECT}
`;

const SUPPORT = `import { defineAgent } from '@indx-workspace/sdk/define';
export default defineAgent({
  name: 'support-desk',
  instructions: 'Answer support questions.',
  model: { connection: 'default', id: 'claude-sonnet-4-6' },
});
`;

beforeEach(() => {
  calls.length = 0;
  fetches.length = 0;
});

describe('aw platforms publish --platform copilot-studio', () => {
  it('plans with the compile options the export accepted', async () => {
    const root = await tempDirectory();
    directories.push(root);
    await tempFile(root, 'agent-workspace.yaml', PROJECT);
    await tempFile(root, 'agents/support-desk.ts', SUPPORT);

    const run = await runCli(['platforms', 'publish', '--platform', 'copilot-studio'], {
      cwd: root,
    });

    const directory = path.join(root, 'platforms', 'copilot-studio');
    expect(run.stdout).toContain('active pac auth profile');
    expect(run.stderr).toContain('next: pac uses the active pac auth profile');
    expect(run.code).toBe(EXIT_CODE.contract);
    expect(calls).toEqual([
      { tool: 'pac', args: ['help'] },
      {
        tool: 'pac',
        args: [
          'solution',
          'pack',
          '--zipfile',
          path.join(root, 'platforms', 'support_desk.zip'),
          '--folder',
          directory,
          '--packagetype',
          'Unmanaged',
        ],
      },
    ]);
  });
});

describe('aw platforms publish --platform gemini-enterprise', () => {
  it('plans the registration with the compile options the export accepted', async () => {
    const root = await tempDirectory();
    directories.push(root);
    await tempFile(root, 'agent-workspace.yaml', GEMINI_PROJECT);
    await tempFile(root, 'agents/support-desk.ts', SUPPORT);

    const run = await runCli(['platforms', 'publish', '--platform', 'gemini-enterprise'], {
      cwd: root,
    });

    const collection =
      'https://global-discoveryengine.googleapis.com/v1alpha/projects/acme-agents/locations/global/collections/default_collection/engines/acme-support-app/assistants/default_assistant/agents';
    expect(run.stdout).toContain(`POST ${collection}`);
    expect(run.code).toBe(EXIT_CODE.contract);
    expect(calls).toEqual([
      { tool: 'gcloud', args: ['--version'] },
      { tool: 'gcloud', args: ['auth', 'print-access-token'] },
    ]);
    expect(fetches).toEqual([
      {
        url: 'https://aw.example.com/api/a2a/agents/support-desk/.well-known/agent-card.json',
        method: 'GET',
        authorization: null,
      },
      { url: collection, method: 'GET', authorization: `Bearer ${GCLOUD_TOKEN}` },
    ]);
    expect(run.stdout).not.toContain(GCLOUD_TOKEN);
    expect(run.stderr).not.toContain(GCLOUD_TOKEN);
  });
});

describe('aw platforms publish --platform microsoft-foundry', () => {
  it('plans the agent versions with the compile options the export accepted', async () => {
    const root = await tempDirectory();
    directories.push(root);
    await tempFile(root, 'agent-workspace.yaml', FOUNDRY_PROJECT_YAML);
    await tempFile(root, 'agents/support-desk.ts', SUPPORT);

    const run = await runCli(['platforms', 'publish', '--platform', 'microsoft-foundry'], {
      cwd: root,
    });

    const agent = `${FOUNDRY_PROJECT}/agents/support-desk`;
    expect(run.code).toBe(EXIT_CODE.contract);
    expect(run.stdout).toContain(`POST ${agent}/versions?api-version=v1`);
    expect(calls.map((call) => [call.tool, call.args[0]])).toEqual([
      ['az', 'version'],
      ['az', 'account'],
    ]);
    expect(fetches).toEqual([
      { url: `${agent}?api-version=v1`, method: 'GET', authorization: `Bearer ${AZ_TOKEN}` },
    ]);
    expect(run.stdout).not.toContain(AZ_TOKEN);
    expect(run.stderr).not.toContain(AZ_TOKEN);
  });
});
