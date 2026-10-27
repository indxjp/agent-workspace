import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertHonestReport, runA12ConformanceSuite } from '../../../tests/conformance/harness.js';
import type {
  A12AgentAction,
  A12AgentOutcome,
  A12Probe,
} from '../../../tests/conformance/types.js';
import {
  buildDockerRunArgs,
  createDockerDriver,
  DOCKER_DEFAULT_WORKSPACE_MB,
  DOCKER_REAP_INTERVAL_MS,
  DOCKER_RUNTIME_CAPABILITIES,
  runDockerCommand,
} from './docker.js';
import type { DockerCommand, DockerCommandResult } from './docker.js';
import type { RuntimeRunSpec } from './driver.js';

type ProbeEvent = Readonly<{
  markers: readonly string[];
  interrupted?: boolean;
  network?: A12AgentOutcome['network'];
  readPath?: A12AgentOutcome['readPath'];
  writePath?: A12AgentOutcome['writePath'];
  config?: A12AgentOutcome['config'];
}>;

function commandResult(exitCode: number, stdout = '', stderr = ''): DockerCommandResult {
  return { exitCode, stdout, stderr };
}

// No Docker CLI at all (the self-hosted dgx pool) means no daemon either: skip, not fail (#429).
const dockerDaemonAvailable = await runDockerCommand(['info']).then(
  (result) => result.exitCode === 0,
  () => false,
);

function networkInspection(
  name: string,
  overrides: Readonly<Record<string, unknown>> = {},
): DockerCommandResult {
  return commandResult(
    0,
    JSON.stringify([
      {
        Name: name,
        Driver: 'bridge',
        Internal: true,
        Labels: { 'agent-workspace.runtime': 'docker-network' },
        ...overrides,
      },
    ]),
  );
}

function includesSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  return haystack.some((_, index) =>
    needle.every((value, offset) => haystack[index + offset] === value),
  );
}

describe('Docker command construction', () => {
  it('contains every hardened option transcribed from the section 14.4 command', async () => {
    const spec = await readFile(path.resolve('docs/spec.md'), 'utf8');
    const block = spec.match(/### `docker`[\s\S]*?```bash\s*([\s\S]*?)```/u)?.[1];
    expect(block, 'the section 14.4 docker command must remain present').toBeDefined();

    const specTokens = (block ?? '')
      .split(/\r?\n/u)
      .map((line) => line.trim().replace(/\\$/u, '').trim())
      .filter((line) => line.startsWith('--'))
      .flatMap((line) => line.split(/\s+/u));
    const args = buildDockerRunArgs({
      name: 'probe',
      image: 'agent-workspace/runtime:digest',
      workspacePath: '/srv/workspaces/session',
      networkPolicy: 'none',
      networkName: 'agent-egress',
    });

    for (let index = 0; index < specTokens.length; index += 2) {
      expect(
        includesSequence(args, specTokens.slice(index, index + 2)),
        `missing section 14.4 option ${specTokens.slice(index, index + 2).join(' ')}`,
      ).toBe(true);
    }
  });

  it('keeps gateway reachability for none and never emits Docker network none', () => {
    for (const policy of ['none', 'restricted', 'open'] as const) {
      const args = buildDockerRunArgs({
        name: `probe-${policy}`,
        image: 'alpine:3.20',
        workspacePath: '/workspace',
        networkPolicy: policy,
        networkName: 'agent-egress',
      });
      expect(includesSequence(args, ['--network', 'none'])).toBe(false);
      expect(
        includesSequence(args, ['--network', policy === 'open' ? 'bridge' : 'agent-egress']),
      ).toBe(true);
    }
    expect(DOCKER_RUNTIME_CAPABILITIES.networkPolicyEnforcement.none).toBe('network');
    expect(DOCKER_RUNTIME_CAPABILITIES.networkPolicies).not.toContain('allowlist');
  });

  it('requires immutable production images and applies resolved resource/filesystem constraints', () => {
    expect(() =>
      createDockerDriver({
        images: new Map([['claude-agent-sdk', 'agent-workspace/runtime:latest']]),
        requireDigest: true,
        startAgent: () => {
          throw new Error('not used');
        },
      }),
    ).toThrow(/pinned by sha256 digest/u);

    const args = buildDockerRunArgs({
      name: 'constrained',
      image: `agent-workspace/runtime@sha256:${'a'.repeat(64)}`,
      workspacePath: '/srv/session',
      networkPolicy: 'none',
      networkName: 'agent-egress',
      runtimeId: 'runtime-1',
      sessionId: 'session-1',
      cpu: 2,
      memoryMb: 2048,
      filesystem: 'read-only',
    });
    expect(includesSequence(args, ['--cpus', '2'])).toBe(true);
    expect(includesSequence(args, ['--memory', '2048m'])).toBe(true);
    expect(args).toContain('type=bind,src=/srv/session,dst=/workspace,readonly');
    expect(includesSequence(args, ['--label', 'agent-workspace.runtime-id=runtime-1'])).toBe(true);
    expect(includesSequence(args, ['--label', 'agent-workspace.session-id=session-1'])).toBe(true);
  });

  it('starts exactly one container per handle and removes that container on destroy', async () => {
    const calls: string[][] = [];
    let nextContainer = 0;
    const docker: DockerCommand = (args) => {
      calls.push([...args]);
      if (args[0] === 'network' && args[1] === 'inspect')
        return Promise.resolve(networkInspection('agent-egress'));
      if (args[0] === 'run')
        return Promise.resolve(commandResult(0, `container-${String(++nextContainer)}\n`));
      if (args[0] === 'rm') return Promise.resolve(commandResult(0));
      if (args[0] === 'inspect') return Promise.resolve(commandResult(0, 'true\n'));
      return Promise.resolve(commandResult(1, '', 'unexpected command'));
    };
    const root = await mkdtemp(path.join(tmpdir(), 'w3-docker-unit-'));
    const driver = createDockerDriver<never, never>({
      images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
      startAgent: () => {
        throw new Error('not used');
      },
      docker,
    });
    try {
      const first = await driver.create({
        sessionId: 'one',
        engine: 'claude-agent-sdk',
        workspacePath: path.join(root, 'one'),
      });
      const second = await driver.create({
        sessionId: 'two',
        engine: 'claude-agent-sdk',
        workspacePath: path.join(root, 'two'),
      });
      expect(calls.filter((call) => call[0] === 'run')).toHaveLength(2);
      expect(first.externalId).not.toBe(second.externalId);
      expect(await driver.isLive(first)).toBe(true);
      await driver.destroy(first);
      await driver.destroy(second);
      expect(calls.filter((call) => call[0] === 'rm')).toEqual([
        ['rm', '--force', '--volumes', 'container-1'],
        ['rm', '--force', '--volumes', 'container-2'],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("publish: 'loopback' (#786)", () => {
    const openSpec: RuntimeRunSpec = {
      runtimeProfileId: 'rp-docker',
      driver: 'docker',
      networkPolicy: 'open',
      filesystem: 'read-write',
      diskMb: 1024,
    };
    function publishingDriver(port: DockerCommandResult) {
      const calls: string[][] = [];
      const docker: DockerCommand = (args) => {
        calls.push([...args]);
        if (args[0] === 'run') return Promise.resolve(commandResult(0, 'container-p\n'));
        if (args[0] === 'port') return Promise.resolve(port);
        if (args[0] === 'rm') return Promise.resolve(commandResult(0));
        return Promise.resolve(commandResult(1, '', 'unexpected command'));
      };
      const driver = createDockerDriver<never, never>({
        images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
        workspaceStorage: 'anonymous-volume',
        publish: 'loopback',
        startAgent: () => {
          throw new Error('not used');
        },
        docker,
      });
      return { calls, driver };
    }
    const config = { sessionId: 's', engine: 'claude-agent-sdk', workspacePath: '/unused' };

    it('publishes the runtime port on 127.0.0.1 and answers where docker put it', async () => {
      const { calls, driver } = publishingDriver(commandResult(0, '127.0.0.1:49153\n'));
      const handle = await driver.create({ ...config, runSpec: openSpec });
      const run = calls.find((call) => call[0] === 'run') ?? [];
      expect(includesSequence(run, ['--publish', '127.0.0.1::8080/tcp'])).toBe(true);
      expect(includesSequence(run, ['--add-host', 'host.docker.internal:host-gateway'])).toBe(true);
      expect(includesSequence(run, ['--network', 'bridge'])).toBe(true);
      // No environment crosses into the sandbox: a run's gateway URL and token come in its request.
      expect(run.filter((arg) => arg === '-e' || arg.startsWith('--env'))).toEqual([]);
      expect(calls).toContainEqual(['port', 'container-p', '8080/tcp']);
      expect(driver.publishedOrigin(handle)).toBe('http://127.0.0.1:49153');
      await driver.destroy(handle);
      expect(() => driver.publishedOrigin(handle)).toThrow(/no longer live/u);
    });

    it('removes the sandbox and fails the create when the published port cannot be read', async () => {
      const { calls, driver } = publishingDriver(commandResult(1, '', 'no public port'));
      await expect(driver.create({ ...config, runSpec: openSpec })).rejects.toThrow(
        /published runtime port failed: no public port/u,
      );
      expect(calls).toContainEqual(['rm', '--force', '--volumes', 'container-p']);
    });

    it('refuses a policy whose internal network publishes nothing, before starting anything', async () => {
      const { calls, driver } = publishingDriver(commandResult(0, '127.0.0.1:49153\n'));
      await expect(
        driver.create({ ...config, runSpec: { ...openSpec, networkPolicy: 'none' } }),
      ).rejects.toThrow(/needs network policy open/u);
      expect(calls).toEqual([]);
    });

    it('has no published origin without the option', () => {
      const { driver } = publishingDriver(commandResult(0));
      const plain = buildDockerRunArgs({
        name: 'n',
        image: 'i',
        workspacePath: '/w',
        networkPolicy: 'open',
        networkName: 'agent-egress',
      });
      expect(plain).not.toContain('--publish');
      expect(() =>
        driver.publishedOrigin({
          id: 'x',
          driver: 'docker',
          externalId: 'y',
          workspacePath: '/w',
          createdAt: new Date(),
        }),
      ).toThrow(/no longer live/u);
    });
  });

  it.each([
    ['non-internal', networkInspection('agent-egress', { Internal: false }), /not internal/u],
    ['wrong-driver', networkInspection('agent-egress', { Driver: 'overlay' }), /bridge/u],
    ['unowned', networkInspection('agent-egress', { Labels: {} }), /ownership label/u],
    ['wrong-name', networkInspection('other-network'), /name does not match/u],
    ['malformed', commandResult(0, '{not-json'), /malformed JSON/u],
    ['empty-result', commandResult(0, '[]'), /exactly one network/u],
  ])(
    'refuses an existing %s network before starting a container',
    async (_case, inspection, error) => {
      const calls: string[][] = [];
      const docker: DockerCommand = (args) => {
        calls.push([...args]);
        if (args[0] === 'network' && args[1] === 'inspect') return Promise.resolve(inspection);
        return Promise.resolve(commandResult(1, '', 'must not be called'));
      };
      const root = await mkdtemp(path.join(tmpdir(), 'w3-docker-invalid-network-'));
      const driver = createDockerDriver<never, never>({
        images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
        startAgent: () => {
          throw new Error('not used');
        },
        docker,
      });
      try {
        await expect(
          driver.create({
            engine: 'claude-agent-sdk',
            sessionId: 'network-check',
            workspacePath: root,
          }),
        ).rejects.toThrow(error);
        expect(calls.some((call) => call[0] === 'run')).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('validates the winner of a network create race before trusting it', async () => {
    const calls: string[][] = [];
    let inspectCount = 0;
    const docker: DockerCommand = (args) => {
      calls.push([...args]);
      if (args[0] === 'network' && args[1] === 'inspect') {
        inspectCount += 1;
        return Promise.resolve(
          inspectCount === 1
            ? commandResult(1, '', 'not found')
            : networkInspection('agent-egress'),
        );
      }
      if (args[0] === 'network' && args[1] === 'create') {
        return Promise.resolve(commandResult(1, '', 'already exists'));
      }
      if (args[0] === 'run') return Promise.resolve(commandResult(0, 'container-race-winner\n'));
      return Promise.resolve(commandResult(1, '', 'unexpected command'));
    };
    const root = await mkdtemp(path.join(tmpdir(), 'w3-docker-network-race-'));
    const driver = createDockerDriver<never, never>({
      images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
      startAgent: () => {
        throw new Error('not used');
      },
      docker,
    });
    try {
      await expect(
        driver.create({ engine: 'claude-agent-sdk', sessionId: 'race', workspacePath: root }),
      ).resolves.toMatchObject({
        externalId: 'container-race-winner',
      });
      expect(calls.filter((call) => call.slice(0, 2).join(' ') === 'network inspect')).toHaveLength(
        2,
      );
      expect(calls.find((call) => call.slice(0, 2).join(' ') === 'network create')).toEqual([
        'network',
        'create',
        '--driver',
        'bridge',
        '--internal',
        '--label',
        'agent-workspace.runtime=docker-network',
        'agent-egress',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!dockerDaemonAvailable)('real Docker isolation and A.12 conformance', () => {
  const suffix = randomUUID().slice(0, 8);
  const networkName = `w3-agent-egress-${suffix}`;
  const gatewayName = `w3-gateway-${suffix}`;
  const liveContainers = new Set<string>();
  const sessionMarkers = new Map<string, readonly string[]>();

  async function docker(args: readonly string[]): Promise<DockerCommandResult> {
    const result = await runDockerCommand(args);
    if (args[0] === 'run' && result.exitCode === 0) liveContainers.add(result.stdout.trim());
    if (args[0] === 'rm' && result.exitCode === 0) liveContainers.delete(args.at(-1) ?? '');
    return result;
  }

  async function mustDocker(args: readonly string[]): Promise<DockerCommandResult> {
    const result = await docker(args);
    expect(result.exitCode, `${args.join(' ')}\n${result.stderr}`).toBe(0);
    return result;
  }

  beforeAll(async () => {
    await mustDocker([
      'network',
      'create',
      '--driver',
      'bridge',
      '--internal',
      '--label',
      'agent-workspace.runtime=docker-network',
      networkName,
    ]);
    await mustDocker([
      'run',
      '--detach',
      '--name',
      gatewayName,
      '--network',
      networkName,
      '--network-alias',
      'gateway.internal.a12-fixture',
      'nginx:alpine',
    ]);
    await waitForGateway();
  }, 120_000);

  /**
   * `docker run --detach` returns as soon as the container starts, not when nginx listens: the
   * image's entrypoint scripts can take several seconds before the socket is open, so a probe
   * issued straight away sees `Connection refused` and would fail an isolation proof for a
   * reason unrelated to isolation. Poll the gateway from inside its own container until it
   * serves, or fail the fixture with the last error rather than letting a test misreport it.
   */
  async function waitForGateway(): Promise<void> {
    const deadline = Date.now() + 60_000;
    let last: DockerCommandResult = commandResult(1, '', 'gateway probe never ran');
    while (Date.now() < deadline) {
      last = await docker([
        'exec',
        gatewayName,
        'wget',
        '-q',
        '-T',
        '2',
        '-O',
        '/dev/null',
        'http://127.0.0.1/',
      ]);
      if (last.exitCode === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`gateway ${gatewayName} never became ready: ${last.stderr}`);
  }

  afterAll(async () => {
    for (const container of liveContainers) {
      await runDockerCommand(['rm', '--force', '--volumes', container]);
    }
    await runDockerCommand(['network', 'rm', networkName]);
  }, 120_000);

  function probeConnection(runtimeId: string, action: A12AgentAction, event: ProbeEvent) {
    let releaseInterrupt: (() => void) | undefined;
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const events: AsyncIterable<ProbeEvent> = {
      async *[Symbol.asyncIterator]() {
        if (action.kind === 'long-running') {
          yield { markers: [action.marker], config: event.config };
          await interrupted;
          yield { markers: [action.marker], interrupted: true, config: event.config };
          return;
        }
        yield event;
      },
    };
    return {
      events,
      sessionId: Promise.resolve(runtimeId),
      async interrupt() {
        releaseInterrupt?.();
        await Promise.resolve();
      },
    };
  }

  const driver = createDockerDriver<A12AgentAction, ProbeEvent>({
    images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
    networkName,
    networkPolicy: 'none',
    command: ['sleep', '600'],
    docker,
    async startAgent(runtime, action) {
      const config = { claudeConfigDir: `/tmp/.claude-${runtime.id}`, settingSources: [] as const };
      if (action.kind === 'trivial') {
        await mustDocker(['exec', runtime.externalId, 'printf', '%s', action.marker]);
        sessionMarkers.set(runtime.id, [action.marker]);
        return probeConnection(runtime.id, action, { markers: [action.marker], config });
      }
      if (action.kind === 'resume') {
        await mustDocker(['exec', runtime.externalId, 'printf', '%s', action.marker]);
        const markers = [...(sessionMarkers.get(action.priorSessionId) ?? []), action.marker];
        sessionMarkers.set(action.priorSessionId, markers);
        return {
          ...probeConnection(action.priorSessionId, action, { markers, config }),
          sessionId: Promise.resolve(action.priorSessionId),
        };
      }
      if (action.kind === 'network-probe') {
        const allowed = await docker([
          'exec',
          runtime.externalId,
          'wget',
          '-q',
          '-T',
          '3',
          '-O-',
          `http://${action.allowedHost}/`,
        ]);
        const blocked = await docker([
          'exec',
          runtime.externalId,
          'wget',
          '-q',
          '-T',
          '3',
          '-O-',
          `http://${action.blockedHost}/`,
        ]);
        return probeConnection(runtime.id, action, {
          markers: [],
          network: {
            allowedReachable: allowed.exitCode === 0,
            blockedReachable: blocked.exitCode === 0,
          },
          config,
        });
      }
      if (action.kind === 'read-path') {
        const ownWorkspace =
          action.target.locus === 'workspace' && action.target.handle.id === runtime.id;
        const safeRelative =
          ownWorkspace &&
          !path.posix.isAbsolute(action.target.relativePath) &&
          !action.target.relativePath.split('/').includes('..');
        const result = safeRelative
          ? await docker([
              'exec',
              runtime.externalId,
              'cat',
              `/workspace/${action.target.relativePath}`,
            ])
          : commandResult(1);
        return probeConnection(runtime.id, action, {
          markers: [],
          readPath: {
            succeeded: result.exitCode === 0,
            ...(result.exitCode === 0 ? { content: result.stdout } : {}),
          },
          config,
        });
      }
      if (action.kind === 'write-path') {
        const ownWorkspace =
          action.target.locus === 'workspace' && action.target.handle.id === runtime.id;
        const safeRelative =
          ownWorkspace &&
          !path.posix.isAbsolute(action.target.relativePath) &&
          !action.target.relativePath.split('/').includes('..');
        const result = safeRelative
          ? await docker([
              'exec',
              runtime.externalId,
              'sh',
              '-c',
              'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"',
              'sh',
              `/workspace/${action.target.relativePath}`,
              action.content,
            ])
          : commandResult(1);
        return probeConnection(runtime.id, action, {
          markers: [],
          writePath: { succeeded: result.exitCode === 0 },
          config,
        });
      }
      return probeConnection(runtime.id, action, { markers: [action.marker], config });
    },
  });

  const probe: A12Probe<A12AgentAction, ProbeEvent> = {
    agent: {
      buildRequest: (action) => action,
      interpretEvents(events) {
        const markers = events.flatMap((event) => event.markers);
        const last = events.at(-1);
        const outcome: A12AgentOutcome = {
          containsMarker: (marker) => markers.includes(marker),
          wasInterrupted: events.some((event) => event.interrupted === true),
          ...(last?.network === undefined ? {} : { network: last.network }),
          ...(last?.readPath === undefined ? {} : { readPath: last.readPath }),
          ...(last?.writePath === undefined ? {} : { writePath: last.writePath }),
          ...(last?.config === undefined ? {} : { config: last.config }),
        };
        return outcome;
      },
    },
  };

  it('proves the gateway is reachable while a non-gateway host is blocked', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-docker-network-'));
    const handle = await driver.create({
      engine: 'claude-agent-sdk',
      sessionId: 'network-proof',
      workspacePath: root,
    });
    try {
      const gateway = await docker([
        'exec',
        handle.externalId,
        'wget',
        '-q',
        '-T',
        '3',
        '-O-',
        'http://gateway.internal.a12-fixture/',
      ]);
      const outside = await docker([
        'exec',
        handle.externalId,
        'wget',
        '-q',
        '-T',
        '3',
        '-O-',
        'http://example.com/',
      ]);
      expect(gateway.exitCode).toBe(0);
      expect(outside.exitCode).not.toBe(0);
    } finally {
      await driver.destroy(handle);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('A2 docker lane: a session past its deadline is reaped by the live daemon', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-docker-reap-'));
    const handle = await driver.create({
      engine: 'claude-agent-sdk',
      sessionId: 'deadline-reap',
      workspacePath: root,
      runSpec: runSpec({ timeoutSeconds: 1 }),
    });
    try {
      expect((await docker(['inspect', handle.externalId])).exitCode).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await driver.reapExpired();
      expect((await docker(['inspect', handle.externalId])).exitCode).not.toBe(0);
      expect(await driver.isLive(handle)).toBe(false);
    } finally {
      await driver.destroy(handle).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('returns only pass or capability-backed unsupported verdicts from the A.12 harness', async () => {
    const report = await runA12ConformanceSuite(driver, driver.capabilities, probe);
    console.log(
      `A.12 vs docker:\n${report.results
        .map((result) => `  ${result.verdict.padEnd(24)} ${result.id} — ${result.detail}`)
        .join('\n')}`,
    );
    expect(() => assertHonestReport(report)).not.toThrow();
    expect(report.results).toHaveLength(10);
    expect(report.results.every((result) => result.verdict !== 'fail')).toBe(true);
    expect(
      report.results.filter((result) => result.verdict === 'unsupported-by-capability'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'enforce-network-restricted' }),
        expect.objectContaining({ id: 'enforce-resource-limits' }),
      ]),
    );
  }, 180_000);
});

// ENG-07 (#306, ADR-0073 D3): the image is the run's engine's, from a map of two engines.
const TWO_ENGINE_IMAGES = new Map([
  ['claude-agent-sdk', `registry.example/runtime-claude-agent-sdk@sha256:${'a'.repeat(64)}`],
  ['pi', `registry.example/runtime-pi@sha256:${'b'.repeat(64)}`],
]);

describe('docker runtime: one image per engine (ENG-07)', () => {
  function recordingDocker(calls: string[][]): DockerCommand {
    let next = 0;
    return (args) => {
      calls.push([...args]);
      if (args[0] === 'network' && args[1] === 'inspect')
        return Promise.resolve(networkInspection('agent-egress'));
      if (args[0] === 'run') return Promise.resolve(commandResult(0, `c-${String(++next)}\n`));
      if (args[0] === 'rm') return Promise.resolve(commandResult(0));
      return Promise.resolve(commandResult(0, 'true\n'));
    };
  }

  it("starts each run in its own engine's image", async () => {
    const calls: string[][] = [];
    const root = await mkdtemp(path.join(tmpdir(), 'eng07-docker-'));
    const driver = createDockerDriver<never, never>({
      images: TWO_ENGINE_IMAGES,
      startAgent: () => {
        throw new Error('not used');
      },
      docker: recordingDocker(calls),
    });
    try {
      for (const engine of ['claude-agent-sdk', 'pi']) {
        calls.length = 0;
        await driver.create({ engine, sessionId: engine, workspacePath: path.join(root, engine) });
        const run = calls.find((call) => call[0] === 'run') ?? [];
        expect(run).toContain(TWO_ENGINE_IMAGES.get(engine));
        for (const [other, image] of TWO_ENGINE_IMAGES) {
          if (other !== engine) expect(run).not.toContain(image);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses an engine with no image before any docker command runs', async () => {
    const calls: string[][] = [];
    const driver = createDockerDriver<never, never>({
      images: TWO_ENGINE_IMAGES,
      startAgent: () => {
        throw new Error('not used');
      },
      docker: recordingDocker(calls),
    });
    await expect(
      driver.create({ engine: 'openai-agents', sessionId: 's', workspacePath: '/tmp/eng07-none' }),
    ).rejects.toThrow(/no runtime image for engine "openai-agents"/u);
    expect(calls.filter((call) => call[0] === 'run')).toHaveLength(0);
  });
});

function runSpec(overrides: Partial<RuntimeRunSpec> = {}): RuntimeRunSpec {
  return {
    runtimeProfileId: 'profile-1',
    driver: 'docker',
    networkPolicy: 'none',
    filesystem: 'read-write',
    ...overrides,
  };
}

function recordingDriver(
  calls: string[][],
  options: Readonly<{
    workspaceStorage?: 'bind' | 'anonymous-volume';
    rm?: (container: string) => DockerCommandResult | Promise<DockerCommandResult>;
  }> = {},
) {
  let next = 0;
  const docker: DockerCommand = (args) => {
    calls.push([...args]);
    if (args[0] === 'network' && args[1] === 'inspect')
      return Promise.resolve(networkInspection('agent-egress'));
    if (args[0] === 'run') return Promise.resolve(commandResult(0, `c-${String(++next)}\n`));
    if (args[0] === 'rm')
      return Promise.resolve(options.rm?.(args.at(-1) ?? '') ?? commandResult(0));
    return Promise.resolve(commandResult(0, 'true\n'));
  };
  return createDockerDriver<never, never>({
    images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
    startAgent: () => {
      throw new Error('not used');
    },
    docker,
    workspaceStorage: options.workspaceStorage ?? 'anonymous-volume',
  });
}

const removals = (calls: readonly string[][]) => calls.filter((call) => call[0] === 'rm');

describe('docker driver deadline reaper (#783)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes a session past expiresAt without a manager shutdown', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const driver = recordingDriver(calls);
    await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec({ timeoutSeconds: 60 }),
    });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(removals(calls)).toEqual([]);

    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS);
    expect(removals(calls)).toEqual([['rm', '--force', '--volumes', 'c-1']]);
  });

  it('never reaps a session without a deadline', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const driver = recordingDriver(calls);
    await driver.create({ sessionId: 's', engine: 'claude-agent-sdk', workspacePath: '/ws/s' });

    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(removals(calls)).toEqual([]);
  });

  it('reads a reaped handle as not live and lets the manager destroy it', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const driver = recordingDriver(calls);
    const handle = await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec({ timeoutSeconds: 1 }),
    });

    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS);
    expect(removals(calls)).toHaveLength(1);
    expect(await driver.isLive(handle)).toBe(false);
    await expect(driver.destroy(handle)).resolves.toBeUndefined();
    expect(removals(calls)).toHaveLength(1);
    await expect(driver.destroy(handle)).rejects.toThrow(/no longer live/u);
  });

  it('keeps the handle when removal fails, warns once and retries on the next tick', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls: string[][] = [];
    let failing = true;
    const driver = recordingDriver(calls, {
      rm: () => (failing ? commandResult(1, '', 'daemon busy') : commandResult(0)),
    });
    const handle = await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec({ timeoutSeconds: 1 }),
    });

    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS);
    expect(removals(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS);
    expect(removals(calls)).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/c-1: daemon busy/u));
    warn.mockRestore();
    failing = false;
    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS);
    expect(removals(calls)).toHaveLength(3);
    expect(await driver.isLive(handle)).toBe(false);
    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS * 4);
    expect(removals(calls)).toHaveLength(3);
  });

  it('lets destroy and a reaper tick race on the same container', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const pending: ((result: DockerCommandResult) => void)[] = [];
    const driver = recordingDriver(calls, {
      rm: () =>
        new Promise<DockerCommandResult>((resolve) => {
          pending.push(resolve);
        }),
    });
    const handle = await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec({ timeoutSeconds: 1 }),
    });

    // The reaper wins: its rm removes the container, destroy's rm finds it already gone.
    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS);
    const destroyed = driver.destroy(handle);
    expect(pending).toHaveLength(2);
    pending[0]?.(commandResult(0));
    await vi.advanceTimersByTimeAsync(0);
    pending[1]?.(commandResult(1, '', 'Error response from daemon: No such container: c-1'));
    await expect(destroyed).resolves.toBeUndefined();
    await expect(driver.destroy(handle)).rejects.toThrow(/no longer live/u);

    // destroy wins: the late reaper rm must not record the dropped handle as reaped.
    const second = await driver.create({
      sessionId: 's2',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s2',
      runSpec: runSpec({ timeoutSeconds: 1 }),
    });
    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS);
    const destroyedSecond = driver.destroy(second);
    expect(pending).toHaveLength(4);
    pending[3]?.(commandResult(0));
    await expect(destroyedSecond).resolves.toBeUndefined();
    pending[2]?.(commandResult(1, '', 'No such container: c-2'));
    await vi.advanceTimersByTimeAsync(0);
    await expect(driver.destroy(second)).rejects.toThrow(/no longer live/u);
  });

  it('waits out a removal another call still has in progress', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const answers = [
      commandResult(
        1,
        '',
        'Error response from daemon: removal of container c-1 is already in progress',
      ),
      commandResult(
        1,
        '',
        'Error response from daemon: removal of container c-1 is already in progress',
      ),
      commandResult(1, '', 'Error response from daemon: No such container: c-1'),
    ];
    const driver = recordingDriver(calls, { rm: () => answers.shift() ?? commandResult(0) });
    const handle = await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec(),
    });

    const destroyed = driver.destroy(handle);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(destroyed).resolves.toBeUndefined();
    expect(removals(calls)).toHaveLength(3);
    expect(await driver.isLive(handle)).toBe(false);
  });

  it('still reports a removal that keeps failing', async () => {
    const calls: string[][] = [];
    const driver = recordingDriver(calls, {
      rm: () => commandResult(1, '', 'Error response from daemon: device or resource busy'),
    });
    const handle = await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec(),
    });

    await expect(driver.destroy(handle)).rejects.toThrow(/remove container failed: .*busy/u);
    expect(removals(calls)).toHaveLength(1);
  });

  it('stops the interval once reapAll has run', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const driver = recordingDriver(calls);
    await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec({ timeoutSeconds: 3_600 }),
    });
    await driver.reapAll();
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(calls).toEqual([]);
  });
});

describe('docker driver workspace bound (#783)', () => {
  const baseArgs = {
    name: 'probe',
    image: 'alpine:3.20',
    workspacePath: '/srv/ws',
    networkPolicy: 'none',
    networkName: 'agent-egress',
  } as const;

  it('mounts a sized tmpfs for anonymous-volume and no volume mount', () => {
    const args = buildDockerRunArgs({
      ...baseArgs,
      workspaceStorage: 'anonymous-volume',
      workspaceMb: 512,
    });
    expect(
      includesSequence(args, [
        '--tmpfs',
        '/workspace:rw,exec,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=0700',
      ]),
    ).toBe(true);
    expect(args.some((arg) => arg.includes('type=volume'))).toBe(false);
    expect(args).not.toContain('--mount');
  });

  it('sizes --memory as the agent budget plus the tmpfs workspace, and leaves bind alone', () => {
    expect(
      includesSequence(
        buildDockerRunArgs({
          ...baseArgs,
          workspaceStorage: 'anonymous-volume',
          memoryMb: 2_048,
          workspaceMb: 512,
        }),
        ['--memory', '2560m'],
      ),
    ).toBe(true);
    expect(
      includesSequence(buildDockerRunArgs({ ...baseArgs, workspaceStorage: 'anonymous-volume' }), [
        '--memory',
        `${String(1_024 + DOCKER_DEFAULT_WORKSPACE_MB)}m`,
      ]),
    ).toBe(true);
    expect(includesSequence(buildDockerRunArgs(baseArgs), ['--memory', '1g'])).toBe(true);
  });

  it('applies the default size, and read-only when the filesystem is read-only', () => {
    const args = buildDockerRunArgs({
      ...baseArgs,
      workspaceStorage: 'anonymous-volume',
      filesystem: 'read-only',
    });
    expect(args).toContain(
      `/workspace:ro,exec,nosuid,nodev,size=${String(DOCKER_DEFAULT_WORKSPACE_MB)}m,uid=1000,gid=1000,mode=0700`,
    );
  });

  it('forwards diskMb to the run vector for anonymous-volume', async () => {
    const calls: string[][] = [];
    const driver = recordingDriver(calls);
    await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec({ diskMb: 2_048 }),
    });
    const run = calls.find((call) => call[0] === 'run') ?? [];
    expect(run).toContain('/workspace:rw,exec,nosuid,nodev,size=2048m,uid=1000,gid=1000,mode=0700');
  });

  it('falls back to an unbounded bind mount without diskMb and refuses diskMb on bind', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'a3-docker-bind-'));
    try {
      const calls: string[][] = [];
      const driver = recordingDriver(calls, { workspaceStorage: 'bind' });
      await driver.create({
        sessionId: 'plain',
        engine: 'claude-agent-sdk',
        workspacePath: path.join(root, 'plain'),
      });
      const run = calls.find((call) => call[0] === 'run') ?? [];
      expect(run).toContain(`type=bind,src=${path.join(root, 'plain')},dst=/workspace`);
      expect(run.some((arg) => arg.startsWith('/workspace:'))).toBe(false);

      calls.length = 0;
      await expect(
        driver.create({
          sessionId: 'sized',
          engine: 'claude-agent-sdk',
          workspacePath: path.join(root, 'sized'),
          runSpec: runSpec({ diskMb: 512 }),
        }),
      ).rejects.toThrow(/anonymous-volume/u);
      expect(calls.some((call) => call[0] === 'run')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([0, 15, 1.5, Number.NaN])(
    'refuses diskMb %s before any docker command',
    async (diskMb) => {
      const calls: string[][] = [];
      const driver = recordingDriver(calls);
      await expect(
        driver.create({
          sessionId: 's',
          engine: 'claude-agent-sdk',
          workspacePath: '/ws/s',
          runSpec: runSpec({ diskMb }),
        }),
      ).rejects.toThrow(/diskMb must be a safe integer/u);
      expect(calls).toEqual([]);
    },
  );
});
