import { pathToFileURL } from 'node:url';
import { createJsonLogger } from '@agent-workspace/core/telemetry';
import { createRunnerManagerServer, type RunnerManagerOptions } from './manager.js';
import {
  readRunnerManagerOptions,
  readRunnerManagerSettings,
  startFailureFields,
} from './manager-settings.js';
import { createShutdownGate } from './shutdown-gate.js';
import { listen } from './server.js';
import type { DriverOptions } from './manager-driver-settings.js';
import { shutdownRunnerManager } from './manager-shutdown.js';
import { createShutdownSignalHandler } from './manager-shutdown.js';

export { composeProjectFor } from './manager-driver-docker.js';

export { dockerToolSandboxOrigin } from './manager-driver-docker.js';

export { dockerRuntimeOrigin } from './manager-driver-docker.js';

export { engineImagesFor } from './manager-driver-settings.js';

export { dockerDriverOptions } from './manager-driver-docker.js';

export { acaSessionsNetworkStatus } from './manager-driver-aca.js';

export { acaSessionsDriverOptions } from './manager-driver-aca.js';

export { toolSandboxTimeoutSeconds } from './manager-driver-settings.js';

export { externalDriverOptions } from './manager-driver-external.js';

export { cloudflareSandboxDriverOptions } from './manager-driver-cloudflare.js';

export { vercelSandboxDriverOptions } from './manager-driver-vercel.js';

export { KUBERNETES_FIELD_MANAGER } from './manager-driver-kubernetes.js';

export { kubernetesDriverOptions } from './manager-driver-kubernetes.js';

export { kubernetesRuntimeOrigin } from './manager-driver-kubernetes.js';

export { IN_FLIGHT_SETTLE_TIMEOUT_MS } from './manager-shutdown.js';

export type { ManagerShutdownOutcome } from './manager-shutdown.js';

export { shutdownRunnerManager } from './manager-shutdown.js';

export { createShutdownSignalHandler } from './manager-shutdown.js';

export {
  managerDriverOptions,
  RUNNER_MANAGER_SETTINGS,
  RunnerManagerSettingsError,
  RuntimeDriverConfigurationError,
  SERVED_RUNTIME_DRIVERS,
} from './manager-settings.js';

/**
 * The manager's options from its environment, and the Docker reap a shutdown runs (if any).
 * Throws `RunnerManagerSettingsError` naming every refused setting.
 */
export function runnerManagerOptionsFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): { options: RunnerManagerOptions; reap: DriverOptions['reap'] } {
  return readRunnerManagerOptions(env);
}

export async function startRunnerManager(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const { options, reap, listen: address } = readRunnerManagerSettings(env);
  // Every create goes through the gate, so a shutdown can refuse new ones and wait for the rest.
  const gate = createShutdownGate(options.driver);
  const server = createRunnerManagerServer({ ...options, driver: gate.driver });
  // `PORT=0` asks the OS for a free port; the embedded local runtime does, and reads `address.port`.
  const bound = await listen(server, address.port, address.host);
  return {
    server,
    address: bound,
    shutdown: () => shutdownRunnerManager(server, reap, process.stderr, gate),
  };
}

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

const invokedPath = process.argv[1];

if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  startRunnerManager()
    .then(({ address, shutdown }) => {
      process.stdout.write(
        `runner manager listening on ${address.address}:${String(address.port)}\n`,
      );
      const stop = createShutdownSignalHandler(shutdown);
      for (const signal of SHUTDOWN_SIGNALS) process.on(signal, stop);
    })
    .catch((error: unknown) => {
      // One JSON line on stderr, each refused setting in its own field, then exit status 1.
      createJsonLogger({ service: 'runner-manager' }).error(
        'runner manager failed to start',
        startFailureFields(error),
      );
      process.exitCode = 1;
    });
}
