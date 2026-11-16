import { requireSuccessful } from './command.js';
import {
  type DockerCommand,
  type DockerCommandResult,
  DOCKER_COMPOSE_PROJECT_LABEL,
  DOCKER_NETWORK_OWNERSHIP_LABEL,
  DOCKER_NETWORK_OWNERSHIP_VALUE,
} from './model.js';
/** Compose's own rule for a project name, so the label value can never widen a `--filter`. */
const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;

/** Validate a Compose project name before it reaches a label or a `--filter`. */
export function requireComposeProject(value: string): string {
  if (!COMPOSE_PROJECT_PATTERN.test(value)) {
    throw new Error(
      `docker runtime: composeProject ${JSON.stringify(value)} is not a Compose project name (lowercase letters, digits, "-" and "_", starting with a letter or digit).`,
    );
  }
  return value;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function validateInternalNetworkInspection(result: DockerCommandResult, networkName: string): void {
  let decoded: unknown;
  try {
    decoded = parseJson(result.stdout);
  } catch {
    throw new Error(
      `docker runtime: refusing network ${JSON.stringify(networkName)} because docker network inspect returned malformed JSON.`,
    );
  }
  if (!Array.isArray(decoded) || decoded.length !== 1) {
    throw new Error(
      `docker runtime: refusing network ${JSON.stringify(networkName)} because docker network inspect did not return exactly one network.`,
    );
  }
  const inspected = (decoded as unknown[])[0];
  if (typeof inspected !== 'object' || inspected === null || Array.isArray(inspected)) {
    throw new Error(
      `docker runtime: refusing network ${JSON.stringify(networkName)} because docker network inspect returned an invalid network object.`,
    );
  }
  const network = inspected as Record<string, unknown>;
  const labels = network['Labels'];
  const owned =
    typeof labels === 'object' &&
    labels !== null &&
    !Array.isArray(labels) &&
    (labels as Record<string, unknown>)[DOCKER_NETWORK_OWNERSHIP_LABEL] ===
      DOCKER_NETWORK_OWNERSHIP_VALUE;
  const problems: string[] = [];
  if (network['Name'] !== networkName) problems.push('its inspected name does not match');
  if (network['Driver'] !== 'bridge') problems.push('it is not a bridge network');
  if (network['Internal'] !== true) problems.push('it is not internal');
  if (!owned) {
    problems.push(
      `it lacks ownership label ${DOCKER_NETWORK_OWNERSHIP_LABEL}=${DOCKER_NETWORK_OWNERSHIP_VALUE}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `docker runtime: refusing network ${JSON.stringify(networkName)} because ${problems.join('; ')}. Remove or recreate it as an internal bridge with --label ${DOCKER_NETWORK_OWNERSHIP_LABEL}=${DOCKER_NETWORK_OWNERSHIP_VALUE}.`,
    );
  }
}

export async function ensureInternalNetwork(
  docker: DockerCommand,
  networkName: string,
  composeProject: string | undefined,
): Promise<void> {
  const inspected = await docker(['network', 'inspect', networkName]);
  if (inspected.exitCode === 0) {
    validateInternalNetworkInspection(inspected, networkName);
    return;
  }
  const created = await docker([
    'network',
    'create',
    '--driver',
    'bridge',
    '--internal',
    '--label',
    `${DOCKER_NETWORK_OWNERSHIP_LABEL}=${DOCKER_NETWORK_OWNERSHIP_VALUE}`,
    ...(composeProject === undefined
      ? []
      : ['--label', `${DOCKER_COMPOSE_PROJECT_LABEL}=${composeProject}`]),
    networkName,
  ]);
  let verified: DockerCommandResult;
  if (created.exitCode !== 0) {
    // A concurrent creator may have won between inspect and create. Accept only if the network
    // can now be positively inspected and satisfies every isolation and ownership invariant.
    verified = requireSuccessful(
      await docker(['network', 'inspect', networkName]),
      `create internal network ${JSON.stringify(networkName)}`,
    );
  } else {
    // Do not trust a successful create response on its own. A daemon/plugin mismatch or a race
    // still has to produce the exact network we asked for before a container may use it.
    verified = requireSuccessful(
      await docker(['network', 'inspect', networkName]),
      `inspect newly-created internal network ${JSON.stringify(networkName)}`,
    );
  }
  validateInternalNetworkInspection(verified, networkName);
}
