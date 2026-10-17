/**
 * Host-capability detection (W7-CLI-02): which runtime drivers this machine can deliver, and the
 * strongest isolation among them. It moved here from `packages/runtime` (#364), whose only
 * callers were the generator and the embedded workspace: the published CLI must not import that
 * private package, and `packages/embedded` reaches it through `@indx-workspace/cli`.
 */
import { spawnSync } from 'node:child_process';

type HostPlatform = 'darwin' | 'linux' | 'win32';
type DetectableDriver = 'docker' | 'kubernetes' | 'local';

interface DriverAvailability {
  readonly id: DetectableDriver;
  readonly available: boolean;
  readonly reason: string;
}

export interface HostCapabilities {
  readonly platform: HostPlatform;
  readonly drivers: readonly DriverAvailability[];
  readonly defaultDriver: 'docker' | 'local';
}

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandProbe = (command: string, args: readonly string[]) => CommandResult;

const run: CommandProbe = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
};

function passed(result: CommandResult): boolean {
  return result.status === 0;
}

function dockerAvailability(probe: CommandProbe): DriverAvailability {
  const result = probe('docker', ['version', '--format', '{{.Server.Version}}']);
  return passed(result)
    ? { id: 'docker', available: true, reason: 'Docker daemon is reachable' }
    : { id: 'docker', available: false, reason: 'Docker daemon is not reachable' };
}

function kubernetesAvailability(probe: CommandProbe): DriverAvailability {
  const context = probe('kubectl', ['config', 'current-context']);
  if (!passed(context) || context.stdout.trim() === '') {
    return { id: 'kubernetes', available: false, reason: 'no current kubectl context' };
  }
  const cluster = probe('kubectl', ['cluster-info']);
  return passed(cluster)
    ? {
        id: 'kubernetes',
        available: true,
        reason: `kubectl context ${context.stdout.trim()} answers cluster-info`,
      }
    : {
        id: 'kubernetes',
        available: false,
        reason: `kubectl context ${context.stdout.trim()} is not reachable`,
      };
}

export function detectHostCapabilities(
  platform: NodeJS.Platform = process.platform,
  probe: CommandProbe = run,
): HostCapabilities {
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    throw new Error(`unsupported host platform ${platform}`);
  }
  const docker = dockerAvailability(probe);
  const kubernetes = kubernetesAvailability(probe);
  const local: DriverAvailability = {
    id: 'local',
    available: true,
    reason: 'No tenant isolation: commands run as the host user',
  };
  return {
    platform,
    drivers: [docker, kubernetes, local],
    defaultDriver: docker.available ? 'docker' : 'local',
  };
}
