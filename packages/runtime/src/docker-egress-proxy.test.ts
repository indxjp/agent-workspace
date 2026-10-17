/**
 * ADR-0117 on the docker driver (#784): `restricted` and `open` go through one proxy container per
 * session. Neither the sandbox nor the proxy is ever attached to Docker's `bridge`.
 *
 * Every Docker call goes through a fake `DockerCommand`; nothing here reaches a daemon. The live
 * proof is the isolation lane (`infra/tests/isolation`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDockerDriver,
  DOCKER_PROXIED_RUNTIME_CAPABILITIES,
  DOCKER_REAP_INTERVAL_MS,
  DOCKER_RUNTIME_CAPABILITIES,
  dockerEgressNetworkName,
  dockerEgressOutNetworkName,
  dockerEgressProxyName,
  dockerRuntimeName,
} from './docker.js';
import type { DockerCommand, DockerCommandResult } from './docker.js';
import type { RuntimeRunSpec } from './driver.js';

const PROXY_IMAGE = 'agent-workspace/egress-proxy:dev';

function result(exitCode: number, stdout = '', stderr = ''): DockerCommandResult {
  return { exitCode, stdout, stderr };
}

function inspected(name: string): DockerCommandResult {
  return result(
    0,
    JSON.stringify([
      {
        Name: name,
        Driver: 'bridge',
        Internal: true,
        Labels: { 'agent-workspace.runtime': 'docker-network' },
      },
    ]),
  );
}

function hasPair(args: readonly string[], flag: string, value: string): boolean {
  return args.some((arg, index) => arg === flag && args[index + 1] === value);
}

function fakeDocker(
  fail: (args: readonly string[]) => DockerCommandResult | undefined = () => undefined,
  listedNetworks: readonly string[] = [],
) {
  const calls: string[][] = [];
  let next = 0;
  const docker: DockerCommand = (args) => {
    calls.push([...args]);
    const failure = fail(args);
    if (failure !== undefined) return Promise.resolve(failure);
    if (args[0] === 'network' && args[1] === 'inspect')
      return Promise.resolve(inspected(args[2] ?? ''));
    if (args[0] === 'network' && args[1] === 'ls')
      return Promise.resolve(result(0, listedNetworks.join('\n')));
    if (args[0] === 'run') return Promise.resolve(result(0, `container-${String(++next)}\n`));
    if (args[0] === 'ps') return Promise.resolve(result(0, ''));
    return Promise.resolve(result(0));
  };
  return { docker, calls };
}

function spec(overrides: Partial<RuntimeRunSpec> = {}): RuntimeRunSpec {
  return {
    runtimeProfileId: 'profile-1',
    driver: 'docker',
    networkPolicy: 'restricted',
    filesystem: 'read-write',
    ...overrides,
  };
}

function driverFor(
  docker: DockerCommand,
  extra: Partial<Parameters<typeof createDockerDriver<never, never>>[0]> = {},
  withProxy = true,
) {
  return createDockerDriver<never, never>({
    images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
    startAgent: () => {
      throw new Error('not used');
    },
    docker,
    workspaceStorage: 'anonymous-volume',
    ...(withProxy ? { egressProxyImage: PROXY_IMAGE, proxyBypass: ['gateway'] } : {}),
    ...extra,
  });
}

const config = (runSpec: RuntimeRunSpec) => ({
  sessionId: 'session-1',
  engine: 'claude-agent-sdk',
  workspacePath: '/ws/s',
  runSpec,
});

const verbs = (calls: readonly string[][]) => calls.map((call) => call.slice(0, 2).join(' '));

describe('docker driver egress proxy (ADR-0117, #784)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a hardened proxy on a per-session internal network for restricted', async () => {
    const { docker, calls } = fakeDocker();
    const handle = await driverFor(docker).create(
      config(spec({ allowedDomains: ['api.example.com', '*.example.org'] })),
    );
    const proxyName = dockerEgressProxyName(handle.id);
    const network = dockerEgressNetworkName(handle.id);
    const outNetwork = dockerEgressOutNetworkName(handle.id);

    expect(verbs(calls)).toEqual([
      'network inspect',
      'network create',
      'network create',
      'run --detach',
      'network connect',
      'run --detach',
      'network connect',
    ]);
    const [, create, createOut, proxy, attachProxy, sandbox, attachSandbox] = calls as [
      string[],
      string[],
      string[],
      string[],
      string[],
      string[],
      string[],
    ];
    expect(create).toContain('--internal');
    expect(create.at(-1)).toBe(network);
    expect(createOut).not.toContain('--internal');
    expect(createOut.at(-1)).toBe(outNetwork);
    expect(hasPair(proxy, '--name', proxyName)).toBe(true);
    expect(hasPair(proxy, '--cap-drop', 'ALL')).toBe(true);
    expect(hasPair(proxy, '--security-opt', 'no-new-privileges')).toBe(true);
    expect(proxy).toContain('--read-only');
    expect(hasPair(proxy, '--user', '1000:1000')).toBe(true);
    expect(hasPair(proxy, '--env', 'EGRESS_SESSION_ID=session-1')).toBe(true);
    expect(hasPair(proxy, '--env', 'EGRESS_ALLOWLIST=api.example.com,*.example.org')).toBe(true);
    expect(proxy.at(-1)).toBe(PROXY_IMAGE);
    expect(attachProxy).toEqual(['network', 'connect', network, proxyName]);
    // The proxy's networks are its own session's two, never the host-wide default bridge.
    const proxyNetworks = [
      ...proxy.flatMap((arg, index) => (arg === '--network' ? [proxy[index + 1]] : [])),
      ...calls
        .filter((call) => call[1] === 'connect' && call[3] === proxyName)
        .map((call) => call[2]),
    ];
    expect(proxyNetworks).toEqual([outNetwork, network]);
    expect(proxy).not.toContain('bridge');

    expect(hasPair(sandbox, '--name', dockerRuntimeName(handle.id))).toBe(true);
    expect(hasPair(sandbox, '--network', 'agent-egress')).toBe(true);
    expect(sandbox).not.toContain('bridge');
    const proxyUrl = `http://${proxyName}:3128`;
    expect(hasPair(sandbox, '--env', `HTTP_PROXY=${proxyUrl}`)).toBe(true);
    expect(hasPair(sandbox, '--env', `HTTPS_PROXY=${proxyUrl}`)).toBe(true);
    expect(hasPair(sandbox, '--env', 'NO_PROXY=localhost,127.0.0.1,gateway')).toBe(true);
    expect(attachSandbox).toEqual(['network', 'connect', network, dockerRuntimeName(handle.id)]);
  });

  it('routes open through the proxy with the allowlist * and never on bridge', async () => {
    const { docker, calls } = fakeDocker();
    await driverFor(docker).create(config(spec({ networkPolicy: 'open' })));
    const [proxy, sandbox] = calls.filter((call) => call[0] === 'run') as [string[], string[]];
    expect(hasPair(proxy, '--env', 'EGRESS_ALLOWLIST=*')).toBe(true);
    expect(hasPair(sandbox, '--network', 'agent-egress')).toBe(true);
    expect(sandbox).not.toContain('bridge');
    expect(calls.some((call) => call[0] === 'network' && call[1] === 'inspect')).toBe(true);
  });

  it('starts no proxy for none, or for restricted with nothing allowed', async () => {
    for (const runSpec of [spec({ networkPolicy: 'none' }), spec({ allowedDomains: [] })]) {
      const { docker, calls } = fakeDocker();
      await driverFor(docker).create(config(runSpec));
      expect(calls.filter((call) => call[0] === 'run')).toHaveLength(1);
      expect(calls.some((call) => call[0] === 'network' && call[1] === 'create')).toBe(false);
      const sandbox = calls.find((call) => call[0] === 'run') ?? [];
      expect(sandbox.some((arg) => arg.startsWith('HTTP_PROXY='))).toBe(false);
    }
  });

  it('keeps refusing restricted and allowedDomains, and open on bridge, without a proxy image', async () => {
    for (const runSpec of [
      spec(),
      spec({ networkPolicy: 'none', allowedDomains: ['api.example.com'] }),
    ]) {
      const { docker, calls } = fakeDocker();
      const refusal = driverFor(docker, {}, false).create(config(runSpec));
      await expect(refusal).rejects.toThrow(/egressProxyImage/u);
      // BH061-030: a typed refusal, which the runner manager answers 422, not a nameless 500.
      await expect(refusal).rejects.toMatchObject({
        name: 'RuntimeRefusalError',
        code: 'network_policy_unsupported',
      });
      expect(calls).toEqual([]);
    }
    const { docker, calls } = fakeDocker();
    await driverFor(docker, {}, false).create(config(spec({ networkPolicy: 'open' })));
    expect(calls.filter((call) => call[0] === 'run')).toHaveLength(1);
    expect(hasPair(calls.find((call) => call[0] === 'run') ?? [], '--network', 'bridge')).toBe(
      true,
    );
  });

  it.each([
    ['a comma', { allowedDomains: ['a.example.com,b.example.com'] }],
    ['whitespace', { allowedDomains: ['a.example.com b'] }],
    ['an equals sign', { allowedDomains: ['A=b'] }],
    ['the wildcard that would widen restricted to open', { allowedDomains: ['*'] }],
    ['domains on open', { networkPolicy: 'open' as const, allowedDomains: ['a.example.com'] }],
  ])('refuses allowedDomains with %s before any docker command', async (_case, overrides) => {
    const { docker, calls } = fakeDocker();
    await expect(driverFor(docker).create(config(spec(overrides)))).rejects.toThrow(
      /allowedDomains/u,
    );
    expect(calls).toEqual([]);
  });

  it('claims allowlist enforcement only when a proxy image is configured', () => {
    const { docker } = fakeDocker();
    expect(driverFor(docker).capabilities).toBe(DOCKER_PROXIED_RUNTIME_CAPABILITIES);
    expect(driverFor(docker).capabilities.networkPolicies).toContain('allowlist');
    expect(driverFor(docker).capabilities.networkPolicyEnforcement.open).toBe('proxy');
    expect(driverFor(docker, {}, false).capabilities).toBe(DOCKER_RUNTIME_CAPABILITIES);
  });

  it('requires the proxy image to be pinned by digest in production', () => {
    const { docker } = fakeDocker();
    expect(() =>
      driverFor(docker, {
        requireDigest: true,
        images: new Map([['claude-agent-sdk', `alpine@sha256:${'a'.repeat(64)}`]]),
      }),
    ).toThrow(/egressProxyImage is not/u);
  });

  it('rolls back the network and the proxy when the proxy cannot start', async () => {
    const { docker, calls } = fakeDocker((args) =>
      args[0] === 'run' && args.includes(PROXY_IMAGE) ? result(1, '', 'no such image') : undefined,
    );
    await expect(
      driverFor(docker).create(config(spec({ allowedDomains: ['api.example.com'] }))),
    ).rejects.toThrow(/start egress proxy failed: no such image/u);
    expect(calls.filter((call) => call[0] === 'run')).toHaveLength(1);
    expect(calls.filter((call) => call[0] === 'rm')).toHaveLength(1);
    expect(calls.slice(-2)).toEqual([
      ['network', 'rm', expect.stringMatching(/^aw-egress-[^o]/u)],
      ['network', 'rm', expect.stringMatching(/^aw-egress-out-/u)],
    ]);
  });

  it('removes the sandbox, the proxy and the network when the sandbox cannot attach', async () => {
    const { docker, calls } = fakeDocker((args) =>
      args[0] === 'network' && args[1] === 'connect' && args.at(-1)?.endsWith('-egress') === false
        ? result(1, '', 'attach failed')
        : undefined,
    );
    await expect(driverFor(docker).create(config(spec({ networkPolicy: 'open' })))).rejects.toThrow(
      /attach sandbox to the egress network failed/u,
    );
    const removed = calls.filter((call) => call[0] === 'rm').map((call) => call.at(-1));
    expect(removed).toHaveLength(2);
    expect(removed.every((name) => name?.startsWith('agent-workspace-'))).toBe(true);
    expect(calls.slice(-2).map((call) => call.slice(0, 2))).toEqual([
      ['network', 'rm'],
      ['network', 'rm'],
    ]);
  });

  it('warns about the resources a failed rollback leaves behind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { docker } = fakeDocker((args) => {
      if (args[0] === 'run' && args.includes(PROXY_IMAGE)) return result(1, '', 'no such image');
      if (args[0] === 'rm') return result(1, '', 'daemon busy');
      if (args[0] === 'network' && args[1] === 'rm') return result(1, '', 'network in use');
      return undefined;
    });
    try {
      await expect(
        driverFor(docker).create(config(spec({ allowedDomains: ['api.example.com'] }))),
      ).rejects.toThrow(/start egress proxy failed: no such image/u);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toMatch(
        /rollback of egress session .*daemon busy.*network in use/u,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('destroy removes the sandbox, then its proxy, then the network', async () => {
    const { docker, calls } = fakeDocker();
    const driver = driverFor(docker);
    const handle = await driver.create(config(spec({ networkPolicy: 'open' })));
    calls.length = 0;
    await driver.destroy(handle);
    expect(calls).toEqual([
      ['rm', '--force', '--volumes', handle.externalId],
      ['rm', '--force', '--volumes', dockerEgressProxyName(handle.id)],
      ['network', 'rm', dockerEgressNetworkName(handle.id)],
      ['network', 'rm', dockerEgressOutNetworkName(handle.id)],
    ]);
  });

  it('keeps the handle live when the network cannot be removed, so destroy can be retried', async () => {
    let networkRemovals = 0;
    const { docker } = fakeDocker((args) =>
      args[0] === 'network' && args[1] === 'rm' && (networkRemovals += 1) === 1
        ? result(1, '', 'network has active endpoints')
        : undefined,
    );
    const driver = driverFor(docker);
    const handle = await driver.create(config(spec({ networkPolicy: 'open' })));
    await expect(driver.destroy(handle)).rejects.toThrow(/active endpoints/u);
    await expect(driver.destroy(handle)).resolves.toBeUndefined();
  });

  it('the deadline reaper removes the proxy and the network with the sandbox', async () => {
    vi.useFakeTimers();
    const { docker, calls } = fakeDocker();
    const driver = driverFor(docker);
    const handle = await driver.create(config(spec({ networkPolicy: 'open', timeoutSeconds: 60 })));
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(60_000 + DOCKER_REAP_INTERVAL_MS);
    expect(calls.filter((call) => call[0] === 'rm').map((call) => call.at(-1))).toEqual(
      expect.arrayContaining([handle.externalId, dockerEgressProxyName(handle.id)]),
    );
    expect(calls).toContainEqual(['network', 'rm', dockerEgressNetworkName(handle.id)]);
    expect(calls).toContainEqual(['network', 'rm', dockerEgressOutNetworkName(handle.id)]);
    expect(await driver.isLive(handle)).toBe(false);
    await driver.destroy(handle);
  });

  it('reapAll removes held proxies and networks and the project networks found by label', async () => {
    const { docker, calls } = fakeDocker(undefined, ['orphan-network-id']);
    const driver = driverFor(docker, { composeProject: 'aw' });
    const handle = await driver.create(config(spec({ networkPolicy: 'open' })));
    calls.length = 0;
    const report = await driver.reapAll();
    expect(report.failed).toEqual([]);
    expect(report.removed).toEqual(
      expect.arrayContaining([handle.externalId, dockerEgressProxyName(handle.id)]),
    );
    expect(calls).toContainEqual(['network', 'rm', dockerEgressNetworkName(handle.id)]);
    expect(calls).toContainEqual(['network', 'rm', dockerEgressOutNetworkName(handle.id)]);
    expect(calls).toContainEqual(['network', 'rm', 'orphan-network-id']);
  });
});
