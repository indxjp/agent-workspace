import { commandFailure, requireSuccessful } from './docker/command.js';
import {
  DOCKER_PROXIED_RUNTIME_CAPABILITIES as proxiedDockerCapabilities,
  DOCKER_RUNTIME_CAPABILITIES as dockerCapabilities,
  DOCKER_RUNTIME_PORT,
  type DockerCommand,
  type DockerDriver,
  type DockerDriverOptions,
} from './docker/model.js';

import { createDockerSandbox } from './docker/create.js';
import { createDockerLifecycle } from './docker/lifecycle.js';
import { createDockerRemoval } from './docker/removal.js';
import { createDockerState } from './docker/state.js';
export { runDockerCommand } from './docker/command.js';
export {
  DOCKER_COMPOSE_PROJECT_LABEL,
  DOCKER_DEFAULT_WORKSPACE_MB,
  DOCKER_REAP_INTERVAL_MS,
  DOCKER_SANDBOX_LABEL,
  type DockerAgentStarter,
  type DockerCommand,
  type DockerCommandResult,
  type DockerDriver,
  type DockerDriverOptions,
  type DockerNetworkPolicy,
  type DockerPolicyEnforcement,
  type DockerReapReport,
  type DockerRuntimeCapabilities,
} from './docker/model.js';
export { requireComposeProject } from './docker/network.js';
export {
  buildDockerEgressProxyArgs,
  buildDockerRunArgs,
  dockerEgressNetworkName,
  dockerEgressOutNetworkName,
  dockerEgressProxyName,
  dockerRuntimeName,
} from './docker/run.js';
export const DOCKER_RUNTIME_CAPABILITIES = dockerCapabilities;
export const DOCKER_PROXIED_RUNTIME_CAPABILITIES = proxiedDockerCapabilities;

const WORKSPACE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** The `127.0.0.1:<port>` line `docker port` prints for a loopback-published port. */
const LOOPBACK_BINDING = /^127\.0\.0\.1:(\d{1,5})$/mu;
/** Read where `docker run --publish 127.0.0.1::8080` put the port; remove the sandbox if unreadable. */
async function publishedLoopbackOrigin(docker: DockerCommand, externalId: string): Promise<string> {
  const port = await docker(['port', externalId, DOCKER_RUNTIME_PORT]).catch((error: unknown) =>
    commandFailure(error),
  );
  const match = port.exitCode === 0 ? LOOPBACK_BINDING.exec(port.stdout) : null;
  if (match?.[1] !== undefined) return `http://127.0.0.1:${match[1]}`;
  await docker(['rm', '--force', '--volumes', externalId]).catch(() => undefined);
  const detail = port.stderr.trim() || port.stdout.trim() || `exit ${String(port.exitCode)}`;
  throw new Error(`docker runtime: read the published runtime port failed: ${detail}`);
}
export function createDockerDriver<TRequest, TEvent>(
  options: DockerDriverOptions<TRequest, TEvent>,
): DockerDriver<TRequest, TEvent> {
  const state = createDockerState(options);
  const removal = createDockerRemoval(state);
  const lifecycle = createDockerLifecycle(state, removal);
  const { docker, live, published, proxyImage } = state;
  const { assertLive } = lifecycle;
  return {
    id: 'docker',

    capabilities:
      proxyImage === undefined ? DOCKER_RUNTIME_CAPABILITIES : DOCKER_PROXIED_RUNTIME_CAPABILITIES,

    async startAgent(runtime, request) {
      return await options.startAgent(assertLive(runtime, 'start an agent'), request);
    },

    async isLive(runtime) {
      const known = live.get(runtime.id);
      if (known === undefined || known.externalId !== runtime.externalId) return false;
      const result = await docker(['inspect', '--format', '{{.State.Running}}', known.externalId]);
      return result.exitCode === 0 && result.stdout.trim() === 'true';
    },

    async writeFile(runtime, name, content) {
      if (!WORKSPACE_FILE_NAME.test(name)) {
        throw new Error(`docker runtime: ${JSON.stringify(name)} is not a plain file name.`);
      }
      const known = assertLive(runtime, 'write a file');
      requireSuccessful(
        await docker(
          [
            'exec',
            '--interactive',
            known.externalId,
            'sh',
            '-c',
            'cat > "/workspace/.$0.tmp" && mv "/workspace/.$0.tmp" "/workspace/$0"',
            name,
          ],
          { input: content },
        ),
        `write ${name} into the sandbox`,
      );
    },

    publishedOrigin(runtime) {
      const origin = published.get(assertLive(runtime, 'address a sandbox').id);
      if (origin === undefined) {
        throw new Error('docker runtime: this driver does not publish its sandboxes on the host.');
      }
      return origin;
    },
    create: (config) =>
      createDockerSandbox(
        state,
        {
          removal,
          lifecycle,
          publishedLoopbackOrigin: (id) => publishedLoopbackOrigin(state.docker, id),
        },
        config,
      ),
    destroy: lifecycle.destroy,
    reapAll: lifecycle.reapAll,
    reapExpired: lifecycle.reapExpired,
  };
}
