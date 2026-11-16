import { EngineImageConfigurationError } from '@agent-workspace/runtime/engine-images';
import { expect, it, vi } from 'vitest';
import { managerDriverOptions, toolSandboxTimeoutSeconds } from './manager-start.js';
import { parseToolSandboxRequest, ToolSandboxUnavailableError } from './tool-sandbox.js';
import { TOKEN, ORDER_TOOL, e2bProviderFixture } from './manager-start.fixture.test-support.js';

const BUILD_ID = '0b6f2f0e-5a52-4f6c-9d57-2c1f8d3a7e11';

const external = {
  RUNTIME_DRIVER: 'external',
  EXTERNAL_PROVIDER: 'e2b',
  GATEWAY_PUBLIC_URL: 'https://gateway.example.com',
  AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: `agent-runtime:${BUILD_ID}`,
};

it('runner manager external (E2B) composition (ADR-0120) > serves external with its own driver id and refuses tool sandboxes by name', () => {
  const options = managerDriverOptions(external);
  expect(options.expectedDriver).toBe('external');
  expect(options.configurationFingerprint).toBe(
    `external:e2b:hobby:claude-agent-sdk=agent-runtime:${BUILD_ID}`,
  );
  expect(options.toolSandboxes).toBeUndefined();
  expect(options.toolSandboxRefusal).toContain('LC5');
});

it('runner manager external (E2B) composition (ADR-0120) > starts tool sandboxes from the tool-host template, and says so in the fingerprint', () => {
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

it('runner manager external (E2B) composition (ADR-0120) > refuses a tool sandbox with a declared domain by name (LC4) before any provider call', async () => {
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
        tools: [ORDER_TOOL],
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

it('runner manager external (E2B) composition (ADR-0120) > ADR-0132: a fresh manager instance finds, replaces and closes the tool sandbox through E2B metadata', async () => {
  const PROVIDER_KEY = 'e2b_SENTINEL_provider_key_0123456789';
  const SECRET = 'sk-live-do-not-print-0123456789';
  const RUN_TOKEN = 'a-run-token-0123456789';
  const { running, created, renewed, provider } = e2bProviderFixture();
  vi.stubGlobal('fetch', provider);
  try {
    const { fresh, request, session } = statelessToolScenario(PROVIDER_KEY, SECRET, RUN_TOKEN);

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

it('runner manager external (E2B) composition (ADR-0120) > bounds a stateless session runtime to its idle limit, not the Pro plan maximum of 24 h', async () => {
  const { created, renewed, provider } = e2bProviderFixture();
  vi.stubGlobal('fetch', provider);
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

it('runner manager external (E2B) composition (ADR-0120) > bounds the tool sandbox backstop timeout', () => {
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

it('runner manager external (E2B) composition (ADR-0120) > LC2: production refuses a tool-host template that is not pinned to a build id', () => {
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

it('runner manager external (E2B) composition (ADR-0120) > keeps the refusal on cloudflare-sandbox and vercel-sandbox whatever the tool-host variable holds', () => {
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

it('runner manager external (E2B) composition (ADR-0120) > refuses a missing or unknown provider, and a non-https gateway URL', () => {
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

it('runner manager external (E2B) composition (ADR-0120) > LC2: production requires <template>:<build_id> pins, not digests', () => {
  expect(() => managerDriverOptions({ ...external, NODE_ENV: 'production' })).not.toThrow();
  expect(() =>
    managerDriverOptions({
      ...external,
      NODE_ENV: 'production',
      AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'agent-runtime:latest',
    }),
  ).toThrow(EngineImageConfigurationError);
});

it('runner manager external (E2B) composition (ADR-0120) > refuses the OCI digest a Cloudflare deploy used to hand an E2B manager, which exited 1 at start', () => {
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

function statelessToolScenario(providerKey: string, secret: string, runToken: string) {
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
        tools: [ORDER_TOOL],
        env: { ORDERS_API_KEY: secret },
      },
      allowedDomains: [],
      run: { runId: 'run_1', token: runToken },
    });
  const session = {
    key: 'profile-one:session-one',
    workspaceId: 'workspace-one',
    sessionId: 'session-one',
    workspacesRoot: '/srv/runtimes',
    providerCredential: providerKey,
    publicBase: 'https://manager.example.dev',
    timeoutSeconds: 3_600,
  };
  return { fresh, request, session };
}
