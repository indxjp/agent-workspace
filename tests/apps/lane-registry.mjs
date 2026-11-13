import { REGISTRY_IMAGE } from '../generated-project/run.mjs';
import { attempt, tail } from './lane-commands.mjs';

/**
 * The throwaway registry the lane pushes app images to, started on first use: its loopback
 * `host:port` and its container, which `stop()` removes.
 */
export function laneRegistry() {
  /** @type {{ host: string, container: string } | undefined} */
  let started;
  return {
    /** @returns {string} */
    host() {
      if (started !== undefined) return started.host;
      const container = attempt('docker', [
        'run',
        '--detach',
        '--rm',
        '-p',
        '127.0.0.1::5000',
        REGISTRY_IMAGE,
      ]);
      if (container.status !== 0)
        throw new Error(`the registry did not start:\n${tail(container.output)}`);
      const id = container.stdout.trim();
      const port =
        attempt('docker', ['port', id, '5000/tcp']).stdout.trim().split(':').at(-1) ?? '';
      started = { host: `127.0.0.1:${port}`, container: id };
      return started.host;
    },
    stop() {
      if (started !== undefined) attempt('docker', ['rm', '--force', started.container]);
    },
  };
}
