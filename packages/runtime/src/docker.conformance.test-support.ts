import path from 'node:path';
import { expect } from 'vitest';
import type {
  A12AgentAction,
  A12AgentOutcome,
  A12Probe,
} from '../../../tests/conformance/types.js';
import type { RuntimeHandle } from './driver.js';
import { runDockerCommand } from './docker.js';
import type { DockerCommandResult } from './docker.js';
import { commandResult } from './docker.test-support.js';

export type ProbeEvent = Readonly<{
  markers: readonly string[];
  interrupted?: boolean;
  network?: A12AgentOutcome['network'];
  readPath?: A12AgentOutcome['readPath'];
  writePath?: A12AgentOutcome['writePath'];
  config?: A12AgentOutcome['config'];
}>;

type DockerRunner = (args: readonly string[]) => Promise<DockerCommandResult>;
type ProbeConfig = NonNullable<ProbeEvent['config']>;
type PathAction = Extract<A12AgentAction, { kind: 'read-path' | 'write-path' }>;

const GATEWAY_READY_TIMEOUT_MS = 60_000;
const GATEWAY_POLL_INTERVAL_MS = 500;
export const GATEWAY_ALIAS = 'gateway.internal.a12-fixture';

/** Runs docker while tracking which containers this suite started so teardown can remove them. */
export function createDockerTracker() {
  const liveContainers = new Set<string>();

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

  async function removeAll(networkName: string): Promise<void> {
    for (const container of liveContainers) {
      await runDockerCommand(['rm', '--force', '--volumes', container]);
    }
    await runDockerCommand(['network', 'rm', networkName]);
  }

  return { docker, mustDocker, removeAll };
}

export function wgetArgs(container: string, url: string, timeoutSeconds: number): string[] {
  return ['exec', container, 'wget', '-q', '-T', String(timeoutSeconds), '-O-', url];
}

export async function startGatewayFixture(
  tracker: ReturnType<typeof createDockerTracker>,
  networkName: string,
  gatewayName: string,
): Promise<void> {
  await tracker.mustDocker([
    'network',
    'create',
    '--driver',
    'bridge',
    '--internal',
    '--label',
    'agent-workspace.runtime=docker-network',
    networkName,
  ]);
  await tracker.mustDocker([
    'run',
    '--detach',
    '--name',
    gatewayName,
    '--network',
    networkName,
    '--network-alias',
    GATEWAY_ALIAS,
    'nginx:alpine',
  ]);
  await waitForGateway(tracker.docker, gatewayName);
}

/**
 * `docker run --detach` returns as soon as the container starts, not when nginx listens: the
 * image's entrypoint scripts can take several seconds before the socket is open, so a probe
 * issued straight away sees `Connection refused` and would fail an isolation proof for a
 * reason unrelated to isolation. Poll the gateway from inside its own container until it
 * serves, or fail the fixture with the last error rather than letting a test misreport it.
 */
async function waitForGateway(docker: DockerRunner, gatewayName: string): Promise<void> {
  const deadline = Date.now() + GATEWAY_READY_TIMEOUT_MS;
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
    await new Promise((resolve) => setTimeout(resolve, GATEWAY_POLL_INTERVAL_MS));
  }
  throw new Error(`gateway ${gatewayName} never became ready: ${last.stderr}`);
}

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

/** The workspace-relative path when the action targets the runtime's own workspace safely. */
function safeWorkspaceFile(runtime: RuntimeHandle, action: PathAction): string | undefined {
  const { target } = action;
  if (target.locus !== 'workspace' || target.handle.id !== runtime.id) return undefined;
  const { relativePath } = target;
  if (path.posix.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
    return undefined;
  }
  return `/workspace/${relativePath}`;
}

async function probePath(
  docker: DockerRunner,
  runtime: RuntimeHandle,
  action: PathAction,
  config: ProbeConfig,
) {
  const workspaceFile = safeWorkspaceFile(runtime, action);
  if (action.kind === 'read-path') {
    const result =
      workspaceFile !== undefined
        ? await docker(['exec', runtime.externalId, 'cat', workspaceFile])
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
  const result =
    workspaceFile !== undefined
      ? await docker([
          'exec',
          runtime.externalId,
          'sh',
          '-c',
          'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"',
          'sh',
          workspaceFile,
          action.content,
        ])
      : commandResult(1);
  return probeConnection(runtime.id, action, {
    markers: [],
    writePath: { succeeded: result.exitCode === 0 },
    config,
  });
}

/** Builds the driver's `startAgent` hook, translating each A.12 action into docker commands. */
export function createAgentStarter(tracker: ReturnType<typeof createDockerTracker>) {
  const { docker, mustDocker } = tracker;
  const sessionMarkers = new Map<string, readonly string[]>();

  return async function startAgent(runtime: RuntimeHandle, action: A12AgentAction) {
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
      const allowed = await docker(
        wgetArgs(runtime.externalId, `http://${action.allowedHost}/`, 3),
      );
      const blocked = await docker(
        wgetArgs(runtime.externalId, `http://${action.blockedHost}/`, 3),
      );
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
      return await probePath(docker, runtime, action, config);
    }
    return probeConnection(runtime.id, action, { markers: [action.marker], config });
  };
}

export const a12Probe: A12Probe<A12AgentAction, ProbeEvent> = {
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
