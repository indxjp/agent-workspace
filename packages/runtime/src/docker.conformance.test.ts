import type { RuntimeHandle } from './driver.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertHonestReport, runA12ConformanceSuite } from '../../../tests/conformance/harness.js';
import type {
  A12AgentAction,
  A12AgentOutcome,
  A12Probe,
} from '../../../tests/conformance/types.js';
import { createDockerDriver, runDockerCommand } from './docker.js';
import type { DockerCommandResult } from './docker.js';
import { commandResult, runSpec } from './docker.test-support.js';

type ProbeEvent = Readonly<{
  markers: readonly string[];
  interrupted?: boolean;
  network?: A12AgentOutcome['network'];
  readPath?: A12AgentOutcome['readPath'];
  writePath?: A12AgentOutcome['writePath'];
  config?: A12AgentOutcome['config'];
}>;

const dockerDaemonAvailable = await runDockerCommand(['info']).then(
  (result) => result.exitCode === 0,
  () => false,
);

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

  async function probePath(
    runtime: RuntimeHandle,
    action: Extract<A12AgentAction, { kind: 'read-path' | 'write-path' }>,
    config: NonNullable<ProbeEvent['config']>,
  ) {
    const ownWorkspace =
      action.target.locus === 'workspace' && action.target.handle.id === runtime.id;
    const safeRelative =
      ownWorkspace &&
      !path.posix.isAbsolute(action.target.relativePath) &&
      !action.target.relativePath.split('/').includes('..');
    if (action.kind === 'read-path') {
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
    throw new Error('unsupported path probe');
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
      if (action.kind === 'read-path' || action.kind === 'write-path') {
        return await probePath(runtime, action, config);
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
