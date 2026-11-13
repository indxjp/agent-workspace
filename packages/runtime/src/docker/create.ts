import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { requireSuccessful, requireValue } from './command.js';
import type { DockerLifecycle } from './lifecycle.js';
import { type DockerNetworkPolicy } from './model.js';
import { ensureInternalNetwork } from './network.js';
import type { DockerRemoval } from './removal.js';
import {
  buildDockerEgressProxyArgs,
  buildDockerRunArgs,
  dockerEgressNetworkName,
  dockerEgressOutNetworkName,
  dockerEgressProxyName,
  dockerRuntimeName,
  requireDiskMb,
  resolveEgressAllowlist,
} from './run.js';
import type { DockerState } from './state.js';
import type { RuntimeConfig, RuntimeHandle } from '../driver.js';
import { EGRESS_PROXY_PORT, egressProxyEnvironment } from '../egress.js';
import { requireEngineImage } from '../engine-images.js';

type DockerCreation = {
  readonly removal: DockerRemoval;
  readonly lifecycle: DockerLifecycle;
  readonly publishedLoopbackOrigin: (externalId: string) => Promise<string>;
};
type DockerRunArguments = (env?: Readonly<Record<string, string>>) => readonly string[];

function validateDockerRun(state: DockerState, config: RuntimeConfig) {
  const { images, networkPolicy, proxyImage, workspaceStorage } = state;
  requireValue(config.sessionId, 'sessionId');
  const workspacePath = requireValue(config.workspacePath, 'workspacePath');
  // ENG-07's dispatch invariant, at the one place that can hold it: the image is chosen from
  // the run's engine, before anything is created, so a run can only ever start in the image
  // this deployment declared for its engine.
  const image = requireEngineImage(images, requireValue(config.engine, 'engine'), 'docker');
  const spec = config.runSpec;
  if (spec !== undefined && spec.driver !== 'docker') {
    throw new Error(`docker runtime: run spec selects incompatible driver ${spec.driver}.`);
  }
  const selectedNetworkPolicy = spec?.networkPolicy ?? networkPolicy;
  const allowlist = resolveEgressAllowlist(proxyImage, selectedNetworkPolicy, spec?.allowedDomains);
  requireDiskMb(spec?.diskMb, workspaceStorage);
  if (spec?.cpu !== undefined && (!Number.isFinite(spec.cpu) || spec.cpu <= 0)) {
    throw new Error('docker runtime: cpu must be a positive finite number.');
  }
  if (
    spec?.memoryMb !== undefined &&
    (!Number.isSafeInteger(spec.memoryMb) || spec.memoryMb < 64)
  ) {
    throw new Error('docker runtime: memoryMb must be a safe integer of at least 64.');
  }

  return { workspacePath, image, spec, selectedNetworkPolicy, allowlist };
}

async function prepareWorkspace(
  workspaceStorage: DockerState['workspaceStorage'],
  workspacePath: string,
): Promise<void> {
  if (workspaceStorage === 'bind') {
    await mkdir(workspacePath, { recursive: true });
    // The container is deliberately uid/gid 1000 rather than the host process's identity.
    // A freshly-created host directory is otherwise commonly 0700 and unusable through the
    // bind mount. The object-store hydration boundary contains the session's data; this grants
    // the container access to that one directory, not to a parent or an operator path.
    await chmod(workspacePath, 0o777);
  }
}

async function startProxiedSandbox(
  state: DockerState,
  removal: DockerRemoval,
  launch: {
    readonly id: string;
    readonly name: string;
    readonly sessionId: string;
    readonly proxyImage: string;
    readonly allowlist: string;
    readonly runArgs: DockerRunArguments;
  },
) {
  const { docker, composeProject, proxyBypass } = state;
  const { createSessionNetwork, rollbackSession } = removal;
  const { id, name, sessionId, proxyImage, allowlist, runArgs } = launch;
  const network = dockerEgressNetworkName(id);
  const outNetwork = dockerEgressOutNetworkName(id);
  const session = { proxy: dockerEgressProxyName(id), networks: [network, outNetwork] };
  const created: string[] = [];
  try {
    await createSessionNetwork(id, network, true);
    await createSessionNetwork(id, outNetwork, false);
    created.push(session.proxy);
    requireSuccessful(
      await docker(
        buildDockerEgressProxyArgs({
          name: session.proxy,
          image: proxyImage,
          runtimeId: id,
          sessionId,
          allowlist,
          outNetwork,
          ...(composeProject === undefined ? {} : { composeProject }),
        }),
      ),
      'start egress proxy',
    );
    requireSuccessful(
      await docker(['network', 'connect', network, session.proxy]),
      'attach egress proxy to its network',
    );
    created.push(name);
    const result = requireSuccessful(
      await docker(
        runArgs(
          egressProxyEnvironment(
            `http://${session.proxy}:${String(EGRESS_PROXY_PORT)}`,
            proxyBypass,
          ),
        ),
      ),
      'start container',
    );
    const externalId = requireValue(result.stdout.trim(), 'container id returned by docker');
    requireSuccessful(
      await docker(['network', 'connect', network, name]),
      'attach sandbox to the egress network',
    );
    return { externalId, session };
  } catch (error) {
    await rollbackSession(id, created, session.networks);
    throw error;
  }
}

export async function createDockerSandbox(
  state: DockerState,
  creation: DockerCreation,
  config: RuntimeConfig,
): Promise<RuntimeHandle> {
  const prepared = await prepareSandboxNetwork(state, config);
  const id = randomUUID();
  const launched = await startSandbox(state, creation, {
    ...prepared,
    id,
    name: dockerRuntimeName(id),
    config,
  });
  return rememberSandbox(state, creation.lifecycle, {
    id,
    ...launched,
    workspacePath: prepared.workspacePath,
    timeoutSeconds: prepared.spec?.timeoutSeconds,
  });
}

async function prepareSandboxNetwork(state: DockerState, config: RuntimeConfig) {
  const { networkName, docker, workspaceStorage, composeProject, publish, proxyImage } = state;
  const { workspacePath, image, spec, selectedNetworkPolicy, allowlist } = validateDockerRun(
    state,
    config,
  );
  await prepareWorkspace(workspaceStorage, workspacePath);
  const proxied = proxyImage !== undefined && allowlist !== null;
  // A proxied `open` sandbox is on the internal network like any other: its way out is the proxy.
  const sandboxPolicy: DockerNetworkPolicy = proxied ? 'restricted' : selectedNetworkPolicy;
  if (publish === 'loopback' && sandboxPolicy !== 'open') {
    throw new Error(
      'docker runtime: a sandbox published on the host loopback needs network policy open; an internal network publishes no port.',
    );
  }
  if (sandboxPolicy !== 'open') {
    await ensureInternalNetwork(docker, networkName, composeProject);
  }

  return { workspacePath, image, spec, allowlist, sandboxPolicy };
}

type SandboxLaunch = Awaited<ReturnType<typeof prepareSandboxNetwork>> & {
  readonly id: string;
  readonly name: string;
  readonly config: RuntimeConfig;
};

async function startSandbox(state: DockerState, creation: DockerCreation, launch: SandboxLaunch) {
  const { proxyImage, docker, publish, published } = state;
  const { id, name, config, image, workspacePath, sandboxPolicy, allowlist, spec } = launch;
  const proxied = proxyImage !== undefined && allowlist !== null;
  const runArgs = sandboxRunArguments(state, {
    id,
    name,
    config,
    image,
    workspacePath,
    sandboxPolicy,
    spec,
  });
  let externalId: string;
  let session: Readonly<{ proxy: string; networks: readonly string[] }> | undefined;
  if (proxied) {
    const launched = await startProxiedSandbox(state, creation.removal, {
      id,
      name,
      sessionId: config.sessionId,
      proxyImage,
      allowlist,
      runArgs,
    });
    externalId = launched.externalId;
    session = launched.session;
  } else {
    const result = requireSuccessful(await docker(runArgs()), 'start container');
    externalId = requireValue(result.stdout.trim(), 'container id returned by docker');
    if (publish === 'loopback') {
      published.set(id, await creation.publishedLoopbackOrigin(externalId));
    }
  }

  return { externalId, session };
}
function sandboxRunArguments(
  state: DockerState,
  launch: {
    readonly id: string;
    readonly name: string;
    readonly config: RuntimeConfig;
    readonly image: string;
    readonly workspacePath: string;
    readonly sandboxPolicy: DockerNetworkPolicy;
    readonly spec: RuntimeConfig['runSpec'];
  },
): DockerRunArguments {
  const { options, workspaceStorage, networkName, composeProject, publish } = state;
  const { id, name, config, image, workspacePath, sandboxPolicy, spec } = launch;
  return (env?: Readonly<Record<string, string>>): readonly string[] =>
    buildDockerRunArgs({
      name,
      image,
      workspacePath,
      workspaceStorage,
      networkPolicy: sandboxPolicy,
      networkName,
      runtimeId: id,
      sessionId: config.sessionId,
      ...(composeProject === undefined ? {} : { composeProject }),
      ...(spec?.cpu === undefined ? {} : { cpu: spec.cpu }),
      ...(spec?.memoryMb === undefined ? {} : { memoryMb: spec.memoryMb }),
      ...(spec?.diskMb === undefined ? {} : { workspaceMb: spec.diskMb }),
      ...(spec?.filesystem === undefined ? {} : { filesystem: spec.filesystem }),
      ...(options.command === undefined ? {} : { command: options.command }),
      ...(env === undefined ? {} : { env }),
      ...(publish === undefined ? {} : { publish }),
    });
}

function rememberSandbox(
  state: DockerState,
  lifecycle: DockerLifecycle,
  sandbox: {
    readonly id: string;
    readonly externalId: string;
    readonly workspacePath: string;
    readonly timeoutSeconds: number | undefined;
    readonly session: Readonly<{ proxy: string; networks: readonly string[] }> | undefined;
  },
): RuntimeHandle {
  const { live, sessions } = state;
  const { id, externalId, workspacePath, timeoutSeconds, session } = sandbox;
  const handle: RuntimeHandle = {
    id,
    driver: 'docker',
    externalId,
    workspacePath,
    createdAt: new Date(),
    ...(timeoutSeconds === undefined
      ? {}
      : { expiresAt: new Date(Date.now() + timeoutSeconds * 1_000) }),
  };
  live.set(id, handle);
  if (session !== undefined) sessions.set(id, session);
  if (handle.expiresAt !== undefined) lifecycle.startReaper();
  return handle;
}
