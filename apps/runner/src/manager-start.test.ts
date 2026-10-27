import { type RuntimeHandle } from '@agent-workspace/runtime/driver';
import { type KubernetesResourceClient } from '@agent-workspace/runtime/driver/kubernetes';
import { EngineImageConfigurationError } from '@agent-workspace/runtime/engine-images';
import { describe, expect, it, vi } from 'vitest';

import { RUNTIME_DRIVERS } from '@indx-workspace/contracts/runtimes';

import {
  acaSessionsDriverOptions,
  acaSessionsNetworkStatus,
  createShutdownSignalHandler,
  dockerDriverOptions,
  dockerRuntimeOrigin,
  engineImagesFor,
  KUBERNETES_FIELD_MANAGER,
  kubernetesDriverOptions,
  kubernetesRuntimeOrigin,
  managerDriverOptions,
  RuntimeDriverConfigurationError,
  SERVED_RUNTIME_DRIVERS,
  startRunnerManager,
  toolSandboxTimeoutSeconds,
} from './manager-start.js';
import { parseToolSandboxRequest, ToolSandboxUnavailableError } from './tool-sandbox.js';

const TOKEN = 'runner-manager-fixture-token-more-than-32-characters';

describe('runner manager ACA composition', () => {
  it('maps the Azure pool contract to a managed runtime whose every URL carries its identifier', () => {
    const options = acaSessionsDriverOptions({
      RUNTIME_DRIVER: 'aca-sessions',
      RUNNER_MANAGER_TOKEN: TOKEN,
      ACA_SESSION_POOL_ENDPOINT: 'https://pool.westeurope.azurecontainerapps.io/subscriptions/pool',
      ACA_SESSION_POOL_API_VERSION: '2025-02-02-preview',
      ACA_SESSION_POOL_NETWORK_STATUS: 'EgressEnabled',
    });
    const handle: RuntimeHandle = {
      id: 'handle-one',
      driver: 'aca-sessions',
      externalId: 'aw-1234567890abcdef',
      workspacePath: '/workspace',
      createdAt: new Date('2026-09-11T00:00:00.000Z'),
    };

    expect(options.expectedDriver).toBe('aca-sessions');
    expect(options.readinessPath).toBe('/ping');
    expect(options.configurationFingerprint).toContain('EgressEnabled');
    const url = new URL(options.runtimeRequestUrl!(handle, '/files?path=README.md'));
    expect(url.pathname.endsWith('/subscriptions/pool/files')).toBe(true);
    expect(url.searchParams.get('path')).toBe('README.md');
    expect(url.searchParams.get('identifier')).toBe(handle.externalId);
  });

  it('defaults the pool engine to claude-agent-sdk, as ADR-0073 D6 states', () => {
    const options = acaSessionsDriverOptions({
      RUNNER_MANAGER_TOKEN: TOKEN,
      ACA_SESSION_POOL_ENDPOINT: 'https://pool.westeurope.azurecontainerapps.io/subscriptions/pool',
    });
    expect(options.configurationFingerprint?.endsWith(':claude-agent-sdk')).toBe(true);
  });

  it('defaults to no egress and rejects unknown pool network states', () => {
    expect(acaSessionsNetworkStatus({})).toBe('EgressDisabled');
    expect(() => acaSessionsNetworkStatus({ ACA_SESSION_POOL_NETWORK_STATUS: 'open' })).toThrow(
      /must be EgressEnabled or EgressDisabled/u,
    );
  });
});

describe('Docker runner manager addressing', () => {
  it('uses the driver-assigned DNS name instead of the non-routable full container ID', () => {
    const handle: RuntimeHandle = {
      id: 'c9fc61d1-6597-454b-9200-06179e4a1d6e',
      driver: 'docker',
      externalId: 'a'.repeat(64),
      workspacePath: '/workspace',
      createdAt: new Date('2026-09-15T00:00:00Z'),
    };

    expect(dockerRuntimeOrigin(handle)).toBe(
      'http://agent-workspace-c9fc61d1-6597-454b-9200-06179e4a1d6e:8080',
    );
    expect(dockerRuntimeOrigin(handle)).not.toContain(handle.externalId);
  });

  it('addresses a sandbox at its published loopback port under RUNTIME_PUBLISH=loopback (#786)', async () => {
    const calls: (readonly string[])[] = [];
    const options = dockerDriverOptions(
      { RUNTIME_IMAGE: 'agent-workspace/runtime:dev', RUNTIME_PUBLISH: 'loopback' },
      (args) => {
        calls.push(args);
        if (args[0] === 'run') return Promise.resolve({ exitCode: 0, stdout: 'c1\n', stderr: '' });
        if (args[0] === 'port') {
          return Promise.resolve({ exitCode: 0, stdout: '127.0.0.1:41234\n', stderr: '' });
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
    );
    const handle = await options.driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/unused',
      runSpec: {
        runtimeProfileId: 'rp',
        driver: 'docker',
        networkPolicy: 'open',
        filesystem: 'read-write',
      },
    });
    expect(calls[0]).toContain('--publish');
    expect(options.runtimeOrigin?.(handle)).toBe('http://127.0.0.1:41234');
  });

  it('listens on a port the OS picks for PORT=0, as the embedded local runtime asks', async () => {
    const manager = await startRunnerManager({
      RUNNER_MANAGER_TOKEN: TOKEN,
      RUNTIME_IMAGE: 'agent-workspace/runtime:dev',
      HOST: '127.0.0.1',
      PORT: '0',
    });
    try {
      expect(manager.address.port).toBeGreaterThan(0);
      const health = await fetch(`http://127.0.0.1:${String(manager.address.port)}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      await expect(manager.shutdown()).resolves.toBe('clean');
    }
  });

  it('refuses a RUNTIME_PUBLISH it does not know', () => {
    expect(() =>
      dockerDriverOptions({ RUNTIME_IMAGE: 'agent-workspace/runtime:dev', RUNTIME_PUBLISH: 'lan' }),
    ).toThrow(/RUNTIME_PUBLISH must be loopback/u);
  });
});

describe('runner manager engine images', () => {
  it('refuses to start when no runtime image is configured at all, naming no value', () => {
    let caught: unknown;
    try {
      engineImagesFor({ NODE_ENV: 'production' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineImageConfigurationError);
    const refusal = caught as EngineImageConfigurationError;
    expect(refusal.message).toMatch(/no engine runtime image is configured/u);
    expect(refusal.keys).toEqual([]);
  });

  it('refuses a tag-only image in production, which the control plane admits (ADR-0073 D5)', () => {
    let caught: unknown;
    try {
      engineImagesFor({
        NODE_ENV: 'production',
        AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'agent-workspace/runtime:dev',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineImageConfigurationError);
    const refusal = caught as EngineImageConfigurationError;
    expect(refusal.keys).toEqual(['claude-agent-sdk']);
    expect(refusal.message).toMatch(/sha256 digest/u);
    expect(refusal.message).not.toContain('agent-workspace/runtime:dev');
  });

  it('starts from a tag outside production, as compose.yaml runs it', () => {
    expect([
      ...engineImagesFor({
        NODE_ENV: 'development',
        AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'agent-workspace/runtime:dev',
      }),
    ]).toEqual([['claude-agent-sdk', 'agent-workspace/runtime:dev']]);
  });

  it('starts from the legacy RUNTIME_IMAGE alone', () => {
    const image = `registry.example/runtime@sha256:${'a'.repeat(64)}`;
    const images = engineImagesFor({ NODE_ENV: 'production', RUNTIME_IMAGE: image });
    expect([...images]).toEqual([['claude-agent-sdk', image]]);
  });
});

describe('runner manager driver selection (#818)', () => {
  const images = { AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'alpine:3.20' };

  it.each(['sandbox-runtime', 'local', 'dockr'])(
    'refuses RUNTIME_DRIVER=%s instead of running Docker under that label',
    (driver) => {
      let caught: unknown;
      try {
        managerDriverOptions({ ...images, RUNTIME_DRIVER: driver });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RuntimeDriverConfigurationError);
      const refusal = caught as RuntimeDriverConfigurationError;
      expect(refusal.driver).toBe(driver);
      expect(refusal.message).toContain(
        'docker, cloud-run-service, aca-sessions, external, vercel-sandbox, cloudflare-sandbox, kubernetes',
      );
      expect(refusal.message).not.toContain(driver);
    },
  );

  it.each([undefined, '', '  ', 'docker', ' docker\r'])(
    'serves Docker for RUNTIME_DRIVER=%j',
    (driver) => {
      const options = managerDriverOptions({ ...images, RUNTIME_DRIVER: driver });
      expect(options.configurationFingerprint).toMatch(/^docker:/u);
    },
  );

  it('still serves aca-sessions', () => {
    const options = managerDriverOptions({
      RUNTIME_DRIVER: 'aca-sessions',
      RUNNER_MANAGER_TOKEN: TOKEN,
      ACA_SESSION_POOL_ENDPOINT: 'https://pool.westeurope.azurecontainerapps.io/subscriptions/pool',
    });
    expect(options.expectedDriver).toBe('aca-sessions');
  });
});

describe('runner manager external (E2B) composition (ADR-0120)', () => {
  const BUILD_ID = '0b6f2f0e-5a52-4f6c-9d57-2c1f8d3a7e11';
  const external = {
    RUNTIME_DRIVER: 'external',
    EXTERNAL_PROVIDER: 'e2b',
    GATEWAY_PUBLIC_URL: 'https://gateway.example.com',
    AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: `agent-runtime:${BUILD_ID}`,
  };

  it('serves external with its own driver id and refuses tool sandboxes by name', () => {
    const options = managerDriverOptions(external);
    expect(options.expectedDriver).toBe('external');
    expect(options.configurationFingerprint).toBe(
      `external:e2b:hobby:claude-agent-sdk=agent-runtime:${BUILD_ID}`,
    );
    expect(options.toolSandboxes).toBeUndefined();
    expect(options.toolSandboxRefusal).toContain('LC5');
  });

  it('starts tool sandboxes from the tool-host template, and says so in the fingerprint', () => {
    const options = managerDriverOptions({
      ...external,
      AGENT_WORKSPACE_TOOL_HOST_IMAGE: `aw-tool-host:${BUILD_ID}`,
    });
    expect(options.toolSandboxes).toBeDefined();
    expect(options.toolSandboxes?.upstream).toBeDefined();
    expect(options.toolSandboxRefusal).toBeUndefined();
    expect(options.configurationFingerprint).toBe(
      `external:e2b:hobby:claude-agent-sdk=agent-runtime:${BUILD_ID}+tools=aw-tool-host:${BUILD_ID}`,
    );
  });

  it('refuses a tool sandbox with a declared domain by name (LC4) before any provider call', async () => {
    const PROVIDER_KEY = 'e2b_SENTINEL_provider_key_0123456789';
    const provider = vi.fn<typeof fetch>(() => Promise.resolve(Response.json([])));
    vi.stubGlobal('fetch', provider);
    try {
      const options = managerDriverOptions({
        ...external,
        AGENT_WORKSPACE_TOOL_HOST_IMAGE: `aw-tool-host:${BUILD_ID}`,
      });
      const request = parseToolSandboxRequest({
        key: 'tools-1',
        manifest: {
          tools: [
            {
              name: 'get_order',
              description: 'Looks up an order.',
              inputSchema: { type: 'object' },
              timeoutMs: 5_000,
              digest: 'a'.repeat(64),
              bundleBase64: Buffer.from('export default () => 1;').toString('base64'),
            },
          ],
          env: {},
        },
        allowedDomains: ['api.example.com'],
        run: { runId: 'run_1', token: 'a-run-token-0123456789' },
      });
      const opened = options.toolSandboxes?.open(
        {
          key: 'profile-one:session-one',
          workspaceId: 'workspace-one',
          sessionId: 'session-one',
          workspacesRoot: '/srv/runtimes',
          providerCredential: PROVIDER_KEY,
          publicBase: 'https://manager.example.dev',
        },
        request,
      );
      const error: unknown = await opened?.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ToolSandboxUnavailableError);
      expect((error as Error).message).toContain('LC4');
      expect((error as Error).message).not.toContain(PROVIDER_KEY);
      expect(provider).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ADR-0132: a fresh manager instance finds, replaces and closes the tool sandbox through E2B metadata', async () => {
    const PROVIDER_KEY = 'e2b_SENTINEL_provider_key_0123456789';
    const SECRET = 'sk-live-do-not-print-0123456789';
    const RUN_TOKEN = 'a-run-token-0123456789';
    // A stand-in for E2B's API and envd that keeps its sandboxes across manager instances.
    const running = new Map<string, { metadata: Record<string, string>; endAt: number }>();
    const created: { timeout: number; metadata: Record<string, string> }[] = [];
    const renewed: number[] = [];
    let count = 0;
    const sandboxBody = (id: string) => ({
      sandboxID: id,
      domain: 'e2b.test',
      trafficAccessToken: 'traffic-token',
      envdAccessToken: 'envd-token',
    });
    const respond = (input: Parameters<typeof fetch>[0], init?: RequestInit): Response => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      if (url.pathname === '/v2/sandboxes' && method === 'POST') {
        const { timeout, metadata } = body as (typeof created)[number];
        count += 1;
        const id = `sbx${String(count)}`;
        created.push({ timeout, metadata });
        running.set(id, { metadata, endAt: Date.now() + timeout * 1_000 });
        return Response.json(sandboxBody(id), { status: 201 });
      }
      if (url.pathname === '/v2/sandboxes') {
        const wanted = [...new URLSearchParams(url.searchParams.get('metadata') ?? '')];
        return Response.json(
          [...running]
            .filter(([, entry]) => wanted.every(([k, v]) => entry.metadata[k] === v))
            .map(([id, entry]) => ({ sandboxID: id, endAt: new Date(entry.endAt).toISOString() })),
        );
      }
      const connect = /^\/sandboxes\/([^/]+)\/connect$/u.exec(url.pathname);
      if (connect !== null) {
        renewed.push((body as { timeout: number }).timeout);
        return Response.json(sandboxBody(connect[1] ?? ''));
      }
      const kill = /^\/sandboxes\/([^/]+)$/u.exec(url.pathname);
      if (kill !== null && method === 'DELETE') {
        running.delete(kill[1] ?? '');
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/process.Process/Start') {
        const payload = Buffer.from(JSON.stringify({ event: { start: { pid: 7 } } }));
        const header = Buffer.alloc(5);
        header.writeUInt32BE(payload.length, 1);
        return new Response(Buffer.concat([header, payload]));
      }
      if (url.pathname === '/files') return Response.json([{ name: 'ok' }]);
      // The tool host's own answer to the readiness probe: it refuses a call with no run token.
      return new Response(null, { status: 401 });
    };
    const provider = vi.fn<typeof fetch>((input, init) => Promise.resolve(respond(input, init)));
    vi.stubGlobal('fetch', provider);
    try {
      const env = {
        ...external,
        AGENT_WORKSPACE_TOOL_HOST_IMAGE: `aw-tool-host:${BUILD_ID}`,
        RUNNER_MANAGER_STATELESS: 'true',
        RUNNER_MANAGER_TOKEN: TOKEN,
      };
      const fresh = () => {
        const sandboxes = managerDriverOptions(env).toolSandboxes;
        if (sandboxes === undefined) throw new Error('no tool sandboxes');
        return sandboxes;
      };
      const request = (key: string) =>
        parseToolSandboxRequest({
          key,
          manifest: {
            tools: [
              {
                name: 'get_order',
                description: 'Looks up an order.',
                inputSchema: { type: 'object' },
                timeoutMs: 5_000,
                digest: 'a'.repeat(64),
                bundleBase64: Buffer.from('export default () => 1;').toString('base64'),
              },
            ],
            env: { ORDERS_API_KEY: SECRET },
          },
          allowedDomains: [],
          run: { runId: 'run_1', token: RUN_TOKEN },
        });
      const session = {
        key: 'profile-one:session-one',
        workspaceId: 'workspace-one',
        sessionId: 'session-one',
        workspacesRoot: '/srv/runtimes',
        providerCredential: PROVIDER_KEY,
        publicBase: 'https://manager.example.dev',
        timeoutSeconds: 3_600,
      };

      await fresh().open(session, request('tools-1'));
      // The backstop caps the lifetime (15 minutes by default, plus two past it), and the tags,
      // the run that started the sandbox among them, hold no secret.
      expect(created[0]?.timeout).toBe(1_020);
      expect(created[0]?.metadata).toMatchObject({
        awWorkspace: 'workspace-one',
        awSession: 'session-one',
        awSessionKey: 'profile-one:session-one',
        awTools: 'tools-1',
        awRun: 'run_1',
      });
      for (const secret of [SECRET, RUN_TOKEN, PROVIDER_KEY, TOKEN]) {
        expect(JSON.stringify(created)).not.toContain(secret);
      }

      // Another invocation reuses it and renews its deadline (the idle timeout).
      renewed.length = 0;
      await fresh().open(session, request('tools-1'));
      expect(created).toHaveLength(1);
      expect(renewed[0]).toBe(1_020);

      // A new tool set: the old sandbox, with the old secrets, is killed before the new one starts.
      await fresh().open(session, request('tools-2'));
      expect(created).toHaveLength(2);
      expect([...running.keys()]).toEqual(['sbx2']);

      // A fresh instance that knows only the workspace and session closes it.
      await fresh().close(
        { key: '', workspaceId: 'workspace-one', sessionId: 'session-one' },
        PROVIDER_KEY,
      );
      expect(running.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bounds a stateless session runtime to its idle limit, not the Pro plan maximum of 24 h', async () => {
    const created: { timeout: number }[] = [];
    const renewed: number[] = [];
    const respond = (input: Parameters<typeof fetch>[0], init?: RequestInit): Response => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const sandbox = {
        sandboxID: 'sbx1',
        domain: 'e2b.test',
        trafficAccessToken: 'traffic-token',
        envdAccessToken: 'envd-token',
      };
      if (url.pathname === '/v2/sandboxes' && method === 'POST') {
        created.push(body as { timeout: number });
        return Response.json(sandbox, { status: 201 });
      }
      if (url.pathname === '/v2/sandboxes') {
        return Response.json([
          { sandboxID: 'sbx1', endAt: new Date(Date.now() + 60_000).toISOString() },
        ]);
      }
      if (/^\/sandboxes\/[^/]+\/connect$/u.test(url.pathname)) {
        renewed.push((body as { timeout: number }).timeout);
        return Response.json(sandbox);
      }
      if (url.pathname === '/process.Process/Start') {
        const payload = Buffer.from(JSON.stringify({ event: { start: { pid: 7 } } }));
        const header = Buffer.alloc(5);
        header.writeUInt32BE(payload.length, 1);
        return new Response(Buffer.concat([header, payload]));
      }
      if (url.pathname === '/files') return Response.json([{ name: 'ok' }]);
      return new Response(null, { status: 401 });
    };
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input, init) => Promise.resolve(respond(input, init))),
    );
    try {
      const { driver } = managerDriverOptions({
        ...external,
        RUNNER_MANAGER_STATELESS: 'true',
        RUNNER_MANAGER_TOKEN: TOKEN,
        E2B_PLAN_TIER: 'pro',
      });
      const config = {
        engine: 'claude-agent-sdk',
        sessionId: 'session-one',
        workspacePath: '/ws/session-one',
        runtimeProfileId: 'profile-one',
      };
      await driver.create(config, 'e2b_key');
      expect(created.map((request) => request.timeout)).toEqual([1_020]);
      await driver.find?.(config, 'e2b_key');
      expect(renewed).toEqual([1_020]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bounds the tool sandbox backstop timeout', () => {
    expect(toolSandboxTimeoutSeconds({})).toBe(900);
    expect(toolSandboxTimeoutSeconds({ AGENT_WORKSPACE_TOOL_SANDBOX_TIMEOUT_SECONDS: '300' })).toBe(
      300,
    );
    for (const value of ['59', '3601', '15m', '-1']) {
      expect(() =>
        toolSandboxTimeoutSeconds({ AGENT_WORKSPACE_TOOL_SANDBOX_TIMEOUT_SECONDS: value }),
      ).toThrow('from 60 through 3600');
    }
  });

  it('LC2: production refuses a tool-host template that is not pinned to a build id', () => {
    const production = { ...external, NODE_ENV: 'production' };
    expect(() =>
      managerDriverOptions({
        ...production,
        AGENT_WORKSPACE_TOOL_HOST_IMAGE: 'aw-tool-host:latest',
      }),
    ).toThrow(EngineImageConfigurationError);
    expect(() =>
      managerDriverOptions({
        ...production,
        AGENT_WORKSPACE_TOOL_HOST_IMAGE: `aw-tool-host:${BUILD_ID}`,
      }),
    ).not.toThrow();
  });

  it('keeps the refusal on cloudflare-sandbox and vercel-sandbox whatever the tool-host variable holds', () => {
    const toolHost = { AGENT_WORKSPACE_TOOL_HOST_IMAGE: `aw-tool-host:${BUILD_ID}` };
    const options = managerDriverOptions({
      RUNTIME_DRIVER: 'cloudflare-sandbox',
      CLOUDFLARE_SANDBOX_BRIDGE_URL: 'https://bridge.example.workers.dev',
      GATEWAY_PUBLIC_URL: 'https://gateway.example.com',
      AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: `registry.example.com/agent-runtime@sha256:${'a'.repeat(64)}`,
      ...toolHost,
    });
    expect(options.toolSandboxes).toBeUndefined();
    expect(options.toolSandboxRefusal).toContain('LC5');
  });

  it('refuses a missing or unknown provider, and a non-https gateway URL', () => {
    expect(() => managerDriverOptions({ ...external, EXTERNAL_PROVIDER: undefined })).toThrow(
      /EXTERNAL_PROVIDER/u,
    );
    expect(() => managerDriverOptions({ ...external, EXTERNAL_PROVIDER: 'vercel' })).toThrow(
      /EXTERNAL_PROVIDER/u,
    );
    expect(() =>
      managerDriverOptions({ ...external, GATEWAY_PUBLIC_URL: 'http://gateway.example.com' }),
    ).toThrow(/https/u);
    expect(() => managerDriverOptions({ ...external, E2B_PLAN_TIER: 'free' })).toThrow(
      /E2B_PLAN_TIER/u,
    );
  });

  it('LC2: production requires <template>:<build_id> pins, not digests', () => {
    expect(() => managerDriverOptions({ ...external, NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      managerDriverOptions({
        ...external,
        NODE_ENV: 'production',
        AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'agent-runtime:latest',
      }),
    ).toThrow(EngineImageConfigurationError);
  });

  it('refuses the OCI digest a Cloudflare deploy used to hand an E2B manager, which exited 1 at start', () => {
    const digest = `registry.cloudflare.com/acct/agent-workspace-runtime@sha256:${'a'.repeat(64)}`;
    const cloudflare = {
      ...external,
      NODE_ENV: 'production',
      RUNNER_MANAGER_STATELESS: 'true',
      RUNNER_MANAGER_TOKEN: 't'.repeat(32),
      AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: digest,
    };
    expect(() => managerDriverOptions(cloudflare)).toThrow(EngineImageConfigurationError);
    expect(() => managerDriverOptions(cloudflare)).toThrow(/<template>:<build_id>/u);
    expect(() =>
      managerDriverOptions({
        ...cloudflare,
        AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: `agent-runtime:${BUILD_ID}`,
      }),
    ).not.toThrow();
  });
});

describe('runner manager cloudflare-sandbox composition (ADR-0120)', () => {
  const digest = `registry.example.com/agent-runtime@sha256:${'a'.repeat(64)}`;
  const cloudflare = {
    RUNTIME_DRIVER: 'cloudflare-sandbox',
    CLOUDFLARE_SANDBOX_BRIDGE_URL: 'https://bridge.example.workers.dev',
    GATEWAY_PUBLIC_URL: 'https://gateway.example.com',
    AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: digest,
  };

  it('serves cloudflare-sandbox with its own driver id and refuses tool sandboxes by name', () => {
    const options = managerDriverOptions(cloudflare);
    expect(options.expectedDriver).toBe('cloudflare-sandbox');
    expect(options.configurationFingerprint).toBe(`cloudflare-sandbox:claude-agent-sdk=${digest}`);
    expect(options.toolSandboxes).toBeUndefined();
    expect(options.toolSandboxRefusal).toContain('LC5');
  });

  it('refuses a missing or non-https bridge URL, and a missing or non-https gateway URL', () => {
    for (const url of [undefined, '', 'http://bridge.example.workers.dev']) {
      expect(() =>
        managerDriverOptions({ ...cloudflare, CLOUDFLARE_SANDBOX_BRIDGE_URL: url }),
      ).toThrow(/CLOUDFLARE_SANDBOX_BRIDGE_URL/u);
    }
    for (const url of [undefined, 'http://gateway.example.com']) {
      expect(() => managerDriverOptions({ ...cloudflare, GATEWAY_PUBLIC_URL: url })).toThrow(
        /gatewayUrl/u,
      );
    }
  });

  it('LC2: production keeps the image digest pin', () => {
    expect(() => managerDriverOptions({ ...cloudflare, NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      managerDriverOptions({
        ...cloudflare,
        NODE_ENV: 'production',
        AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'registry.example.com/agent-runtime:latest',
      }),
    ).toThrow(EngineImageConfigurationError);
  });
});

describe('runner manager vercel-sandbox composition (ADR-0120)', () => {
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const IMAGE = `registry.example.com/agent-runtime@${DIGEST}`;
  const vercel = {
    RUNTIME_DRIVER: 'vercel-sandbox',
    VERCEL_TEAM_ID: 'team_abc123',
    VERCEL_PROJECT_ID: 'prj_abc123',
    GATEWAY_PUBLIC_URL: 'https://gateway.example.com',
    AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: IMAGE,
  };

  it('serves vercel-sandbox with its own driver id and refuses tool sandboxes by name', () => {
    const options = managerDriverOptions(vercel);
    expect(options.expectedDriver).toBe('vercel-sandbox');
    expect(options.configurationFingerprint).toBe(
      `vercel-sandbox:hobby:team_abc123:prj_abc123:claude-agent-sdk=${IMAGE}`,
    );
    expect(options.toolSandboxes).toBeUndefined();
    expect(options.toolSandboxRefusal).toContain('LC5');
    expect(options.toolSandboxRefusal).toContain('vercel-sandbox');
  });

  it('refuses a missing team or project, an unknown tier and a non-https gateway URL', () => {
    expect(() => managerDriverOptions({ ...vercel, VERCEL_TEAM_ID: undefined })).toThrow(
      /VERCEL_TEAM_ID/u,
    );
    expect(() => managerDriverOptions({ ...vercel, VERCEL_PROJECT_ID: 'a b' })).toThrow(
      /VERCEL_PROJECT_ID/u,
    );
    expect(() => managerDriverOptions({ ...vercel, VERCEL_PLAN_TIER: 'free' })).toThrow(
      /VERCEL_PLAN_TIER/u,
    );
    expect(() =>
      managerDriverOptions({ ...vercel, GATEWAY_PUBLIC_URL: 'http://gateway.example.com' }),
    ).toThrow(/https/u);
    expect(
      managerDriverOptions({ ...vercel, VERCEL_PLAN_TIER: 'pro' }).configurationFingerprint,
    ).toMatch(/^vercel-sandbox:pro:/u);
  });

  it('LC2: production requires a digest-pinned image', () => {
    expect(() => managerDriverOptions({ ...vercel, NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      managerDriverOptions({
        ...vercel,
        NODE_ENV: 'production',
        AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'registry.example.com/agent-runtime:latest',
      }),
    ).toThrow(EngineImageConfigurationError);
  });
});

describe('runner manager kubernetes composition (#854)', () => {
  const kubernetes = {
    RUNTIME_DRIVER: 'kubernetes',
    RUNTIME_KUBERNETES_NAMESPACE: 'release',
    RUNTIME_GATEWAY_SERVICE: 'agent-workspace-gateway',
    KUBERNETES_SERVICE_HOST: '10.96.0.1',
    AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'agent-runtime:dev',
  };
  const client = {
    create: (item: { metadata: { name: string } }) => Promise.resolve({ ...item, spec: {} }),
    delete: () => Promise.resolve(),
    read: (item: { metadata: { name: string } }) =>
      Promise.resolve({ ...item, spec: { clusterIP: '10.96.0.9' } }),
  } as unknown as KubernetesResourceClient;

  it('builds the kubernetes driver for RUNTIME_DRIVER=kubernetes, not a Docker one', () => {
    const options = managerDriverOptions(kubernetes);
    expect(options.expectedDriver).toBe('kubernetes');
    expect(options.configurationFingerprint).toBe(
      'kubernetes:release:claude-agent-sdk=agent-runtime:dev',
    );
    expect(options.toolSandboxRefusal).toContain('kubernetes');
  });

  it('puts the egress proxy image in the fingerprint so Test Runtime approval follows it', () => {
    const options = kubernetesDriverOptions(
      { ...kubernetes, AGENT_WORKSPACE_EGRESS_PROXY_IMAGE: 'egress-proxy:dev' },
      client,
    );
    expect(options.configurationFingerprint).toContain('+proxy=egress-proxy:dev');
  });

  it('allocates in the release namespace under the manager field manager', async () => {
    const created: Array<{ kind: string; ns: string | undefined; manager: string | undefined }> =
      [];
    const options = kubernetesDriverOptions(kubernetes, {
      ...client,
      create: (item, manager) => {
        created.push({ kind: item.kind ?? '', ns: item.metadata.namespace, manager });
        return Promise.resolve(item);
      },
    });
    const handle = await options.driver.create({
      engine: 'claude-agent-sdk',
      sessionId: 'session',
      workspacePath: '/workspace/a',
    });
    expect(handle.externalId).toMatch(/^release\/runtime-/u);
    expect(created.map((item) => item.ns)).toEqual(created.map(() => 'release'));
    expect(created.map((item) => item.manager)).toEqual(
      created.map(() => KUBERNETES_FIELD_MANAGER),
    );
    expect(options.runtimeOrigin?.(handle)).toBe(
      `http://${handle.externalId.split('/')[1]}.release.svc:8080`,
    );
  });

  it('addresses a sandbox through the Service named after its pod', () => {
    const handle: RuntimeHandle = {
      id: 'one',
      driver: 'kubernetes',
      externalId: 'ns/runtime-abc',
      workspacePath: '/workspace',
      createdAt: new Date(),
    };
    expect(kubernetesRuntimeOrigin(handle)).toBe('http://runtime-abc.ns.svc:8080');
    expect(() => kubernetesRuntimeOrigin({ ...handle, externalId: 'runtime-abc' })).toThrow(
      /namespace and a pod/u,
    );
  });

  it('refuses to start outside a cluster rather than fall back to a kubeconfig', () => {
    expect(() =>
      managerDriverOptions({ ...kubernetes, KUBERNETES_SERVICE_HOST: undefined }),
    ).toThrow(/in-cluster ServiceAccount/u);
  });

  it.each(['RUNTIME_KUBERNETES_NAMESPACE', 'RUNTIME_GATEWAY_SERVICE'])(
    'refuses to start without %s',
    (name) => {
      expect(() => managerDriverOptions({ ...kubernetes, [name]: ' ' })).toThrow(
        new RegExp(`${name} must be set`, 'u'),
      );
    },
  );

  it('requires a digest-pinned runtime image in production', () => {
    expect(() =>
      kubernetesDriverOptions({ ...kubernetes, NODE_ENV: 'production' }, client),
    ).toThrow(EngineImageConfigurationError);
  });
});

describe('SERVED_RUNTIME_DRIVERS', () => {
  it('names only drivers in the contracts catalogue', () => {
    const catalogue = new Set<string>(RUNTIME_DRIVERS);
    expect(SERVED_RUNTIME_DRIVERS.filter((driver) => !catalogue.has(driver))).toEqual([]);
  });
});

describe('createShutdownSignalHandler', () => {
  function harness(shutdown: () => Promise<'clean' | 'sandboxes-left'>) {
    const written: string[] = [];
    const exits: number[] = [];
    const handler = createShutdownSignalHandler(
      shutdown,
      (code) => {
        exits.push(code);
      },
      { write: (chunk: string | Uint8Array) => written.push(String(chunk)) > 0 },
    );
    return { handler, written, exits };
  }

  it('exits 2 and names the failure when the shutdown rejects', async () => {
    const { handler, written, exits } = harness(() => Promise.reject(new Error('gate exploded')));
    handler('SIGTERM');
    await vi.waitFor(() => {
      expect(exits).toEqual([2]);
    });
    expect(written.join('')).toContain('runner manager: shutdown failed: gate exploded');
  });

  it.each([
    ['clean', 0],
    ['sandboxes-left', 2],
  ] as const)('exits with the %s outcome', async (outcome, code) => {
    const { handler, exits } = harness(() => Promise.resolve(outcome));
    handler('SIGINT');
    await vi.waitFor(() => {
      expect(exits).toEqual([code]);
    });
  });

  it('leaves at once on a second signal without running the shutdown again', () => {
    const shutdown = vi.fn(() => new Promise<'clean'>(() => undefined));
    const { handler, exits } = harness(shutdown);
    handler('SIGTERM');
    handler('SIGTERM');
    expect(exits).toEqual([2]);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
