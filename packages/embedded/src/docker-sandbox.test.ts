/**
 * `aw dev --sandbox docker` (#786): the embedded workspace's docker runner manager.
 *
 * The live lane follows `packages/runtime/src/docker.test.ts`: it skips only without a Docker
 * daemon, and `ci.yml` runs it. It starts the sandbox exactly as `startWorkspace` does, over a
 * fixture image that serves the runtime contract's readiness and echo routes and, on `/run`,
 * reports what its own process sees. The run must report uid 1000, a read-only root filesystem and
 * a marker written in its `/workspace` that does not exist on this host: the process that served
 * the run was in the container, not this one.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { runDockerCommand, type DockerCommandResult } from '@agent-workspace/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_DOCKER_RUNTIME_IMAGE,
  devComposeProject,
  dockerGatewayHost,
  dockerManagerEnvironment,
  DockerSandboxError,
  startDockerSandbox,
  type DockerSandbox,
} from './docker-sandbox.js';

const dockerDaemonAvailable = await runDockerCommand(['info']).then(
  (result) => result.exitCode === 0,
  () => false,
);

const answer = (exitCode: number, stdout = ''): Promise<DockerCommandResult> =>
  Promise.resolve({ exitCode, stdout, stderr: '' });

describe('dockerManagerEnvironment', () => {
  it('passes the engine image variables and nothing else of the environment', () => {
    const token = 'k'.repeat(64);
    expect(
      dockerManagerEnvironment(
        {
          PATH: '/usr/bin',
          ANTHROPIC_API_KEY: 'sk-ant-secret',
          DATABASE_URL: 'postgresql://secret',
          AGENT_WORKSPACE_RUNTIME_IMAGE_PI: ' runtime-pi:dev ',
          AGENT_WORKSPACE_RUNTIME_IMAGE_MASTRA: '  ',
        },
        token,
        '/home/me/My Agent',
      ),
    ).toStrictEqual({
      RUNTIME_IMAGE: DEFAULT_DOCKER_RUNTIME_IMAGE,
      AGENT_WORKSPACE_RUNTIME_IMAGE_PI: 'runtime-pi:dev',
      RUNTIME_DRIVER: 'docker',
      RUNTIME_PUBLISH: 'loopback',
      COMPOSE_PROJECT_NAME: devComposeProject('/home/me/My Agent'),
      RUNNER_MANAGER_TOKEN: token,
      HOST: '127.0.0.1',
      PORT: '0',
      NODE_ENV: 'development',
    });
  });

  it('keeps a RUNTIME_IMAGE the environment sets', () => {
    expect(dockerManagerEnvironment({ RUNTIME_IMAGE: 'mine:1' }, 'k'.repeat(64))).toMatchObject({
      RUNTIME_IMAGE: 'mine:1',
    });
  });

  it('labels the sandboxes by project, one label per project path (BH061-079)', () => {
    const label = devComposeProject('/home/me/My Agent');
    expect(label).toMatch(/^aw-dev-my-agent-[0-9a-f]{8}$/u);
    expect(devComposeProject('/srv/My Agent')).not.toBe(label);
    expect(devComposeProject('/')).toMatch(/^aw-dev-project-[0-9a-f]{8}$/u);
  });
});

describe('dockerGatewayHost', () => {
  it('keeps loopback where Docker Desktop forwards host.docker.internal to it', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      await expect(dockerGatewayHost(platform, () => answer(1))).resolves.toBe('127.0.0.1');
    }
  });

  it("binds the default bridge's gateway on Linux", async () => {
    await expect(dockerGatewayHost('linux', () => answer(0, '172.17.0.1\n'))).resolves.toBe(
      '172.17.0.1',
    );
  });

  it('refuses with one message when the bridge cannot be read', async () => {
    for (const docker of [() => answer(1), () => answer(0, 'not-an-address\n')]) {
      await expect(dockerGatewayHost('linux', docker)).rejects.toBeInstanceOf(DockerSandboxError);
    }
    await expect(
      dockerGatewayHost('linux', () => Promise.reject(new Error('spawn docker ENOENT'))),
    ).rejects.toThrow(/default bridge network/u);
  });
});

describe('startDockerSandbox', () => {
  it('fails with one message, leaving nothing running, when it cannot start a container', async () => {
    // No Docker, or no such image: the manager's verification fails either way.
    await expect(
      startDockerSandbox({ RUNTIME_IMAGE: `agent-workspace/absent-${randomUUID()}:never` }),
    ).rejects.toThrow(/the docker sandbox could not start and verify a container/u);
  }, 120_000);
});

/** A runtime-contract stand-in: readiness, echo, and a `/run` that reports what its process sees. */
const FIXTURE_SERVER = `
const http = require('node:http');
const fs = require('node:fs');
http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/healthz') return response.end('{"status":"ok"}');
    if (request.url === '/verify/echo') return response.end(body);
    if (request.url !== '/run') { response.statusCode = 404; return response.end('{}'); }
    const marker = '/workspace/' + JSON.parse(body).marker;
    fs.writeFileSync(marker, 'written inside the sandbox');
    let rootWritable = true;
    try { fs.writeFileSync('/probe', 'x'); } catch { rootWritable = false; }
    response.end(JSON.stringify({
      uid: process.getuid(), rootWritable, cwd: process.cwd(), markerWritten: fs.existsSync(marker),
    }));
  });
}).listen(8080, '0.0.0.0');
`;

/** `runtime.Dockerfile`'s pinned Node base, so the lane pulls nothing the release does not. */
const NODE_IMAGE =
  'node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6';

const RunReport = z
  .object({
    uid: z.number(),
    rootWritable: z.boolean(),
    cwd: z.string(),
    markerWritten: z.boolean(),
  })
  .strict();
const Allocation = z.looseObject({ runnerUrl: z.string() });

describe.skipIf(!dockerDaemonAvailable)('a run under the docker sandbox, on a real daemon', () => {
  const image = `agent-workspace/sandbox-fixture:${randomUUID().slice(0, 8)}`;
  let sandbox: DockerSandbox | undefined;

  beforeAll(async () => {
    const built = spawnSync('docker', ['build', '--tag', image, '-'], {
      input: `FROM ${NODE_IMAGE}\nCMD ${JSON.stringify(['/usr/local/bin/node', '-e', FIXTURE_SERVER])}\n`,
      encoding: 'utf8',
      timeout: 300_000,
    });
    expect(built.status, built.stderr).toBe(0);
    sandbox = await startDockerSandbox({ RUNTIME_IMAGE: image });
  }, 360_000);

  afterAll(async () => {
    await sandbox?.close();
    await runDockerCommand(['image', 'rm', '--force', image]);
  }, 120_000);

  it('runs in a container: uid 1000, a read-only root, and a /workspace this host does not have', async () => {
    if (sandbox === undefined) throw new Error('the sandbox did not start');
    const headers = {
      authorization: `Bearer ${sandbox.token}`,
      'content-type': 'application/json',
    };
    const allocated = await fetch(`${sandbox.url}/runtimes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspaceId: 'local',
        sessionId: `session-${randomUUID()}`,
        engine: 'claude-agent-sdk',
        // The launcher's `docker` profile, as the web resolves it into a run spec.
        runSpec: {
          runtimeProfileId: 'docker',
          driver: 'docker',
          networkPolicy: 'open',
          filesystem: 'read-write',
          diskMb: 1024,
        },
      }),
    });
    expect(allocated.status).toBe(201);
    const { runnerUrl } = Allocation.parse(await allocated.json());
    expect(runnerUrl.startsWith(`${sandbox.url}/runtimes/`)).toBe(true);

    const marker = `aw-sandbox-${randomUUID()}`;
    const ran = await fetch(`${runnerUrl}/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ marker }),
    });
    expect(ran.status).toBe(200);
    expect(RunReport.parse(await ran.json())).toStrictEqual({
      uid: 1000,
      rootWritable: false,
      cwd: '/workspace',
      markerWritten: true,
    });
    expect(existsSync(path.join('/workspace', marker))).toBe(false);

    const removed = await fetch(runnerUrl, { method: 'DELETE', headers });
    expect(removed.status).toBe(204);
  }, 120_000);
});
