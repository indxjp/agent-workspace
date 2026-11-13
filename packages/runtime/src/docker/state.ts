import { requireValue, runDockerCommand } from './command.js';
import { type DockerDriverOptions } from './model.js';
import { requireComposeProject } from './network.js';
import type { RuntimeHandle } from '../driver.js';
import { requireEgressProxyImage, requireProxyBypass } from '../egress.js';
import { assertDigestPinnedEngineImages } from '../engine-images.js';

export function createDockerState(options: Omit<DockerDriverOptions<never, never>, 'startAgent'>) {
  const images = options.images;

  if (options.requireDigest === true) assertDigestPinnedEngineImages(images, 'docker');

  const networkName = requireValue(options.networkName ?? 'agent-egress', 'networkName');

  const networkPolicy = options.networkPolicy ?? 'none';

  const docker = options.docker ?? runDockerCommand;

  const workspaceStorage = options.workspaceStorage ?? 'bind';

  const composeProject =
    options.composeProject === undefined
      ? undefined
      : requireComposeProject(options.composeProject);

  const publish = options.publish;

  const live = new Map<string, RuntimeHandle>();

  // Live handle id -> `http://127.0.0.1:<port>`, under `publish: 'loopback'` only.
  const published = new Map<string, string>();

  const proxyImage =
    options.egressProxyImage === undefined
      ? undefined
      : requireEgressProxyImage('docker', options.egressProxyImage, options.requireDigest === true);

  const proxyBypass = requireProxyBypass('docker', options.proxyBypass ?? []);

  // Handle id -> the proxy container and network a proxied session owns.
  const sessions = new Map<string, Readonly<{ proxy: string; networks: readonly string[] }>>();

  // Handles the deadline reaper removed, id -> container. The manager still holds them, so its
  // later destroy() must succeed instead of throwing "no longer live".
  const reaped = new Map<string, string>();

  // Handles whose failed reaper rm was already logged, so a stuck container warns once, not every tick.
  const reapWarned = new Set<string>();
  return {
    options,
    images,
    networkName,
    networkPolicy,
    docker,
    workspaceStorage,
    composeProject,
    publish,
    live,
    published,
    proxyImage,
    proxyBypass,
    sessions,
    reaped,
    reapWarned,
  };
}
export type DockerState = ReturnType<typeof createDockerState>;
