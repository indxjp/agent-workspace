/**
 * The deployment posture: whether this control plane runs as a developer's local runtime or as a
 * production deployment (developer-journey contract C2, issue #441).
 *
 * Before C2, six sites read `NODE_ENV === 'production'` to mean "this is a production deployment":
 * the egress policy's loopback exception, the runtime registry's `local` driver (three readings)
 * and its verification-file default, and the engine-image development default. A production
 * *build* of the local runtime runs with `NODE_ENV=production`, because that is what `next start`
 * needs, yet it is still a single developer's machine. `AW_DEPLOYMENT_POSTURE` separates the two
 * questions: `NODE_ENV` says how the code was built, the posture says what the deployment is.
 *
 * - Unset or blank: the posture is derived from `NODE_ENV` exactly as before, and HOST is never
 *   checked, so every existing deployment behaves the same.
 * - `local` or `production`: used as given. `local` is refused unless HOST is set to a loopback
 *   literal, because the local posture relaxes protections that only hold when nothing else can
 *   reach the process. An unset or blank HOST is refused too: the processes that read the posture
 *   do not agree on what an unset HOST binds to (`startWeb` defaults to `127.0.0.1`, the gateway
 *   and the runner to `0.0.0.0`, and an empty host makes Node listen on every interface), so the
 *   local runtime names its host explicitly (contract C1 sets `HOST=127.0.0.1`). HOST is compared
 *   exactly as the listener receives it, never trimmed, so the value checked is the value bound.
 * - Anything else is refused. A value is never accepted and then ignored.
 */
import { z } from 'zod';

/** The environment variable that names the posture. */
export const DEPLOYMENT_POSTURE_ENV = 'AW_DEPLOYMENT_POSTURE';

export const deploymentPostures = ['local', 'production'] as const;

export type DeploymentPosture = (typeof deploymentPostures)[number];

const deploymentPostureSchema = z.enum(deploymentPostures);

type DeploymentPostureErrorCode =
  'invalid_deployment_posture' | 'local_posture_needs_loopback_host';

export class DeploymentPostureError extends Error {
  readonly code: DeploymentPostureErrorCode;

  constructor(code: DeploymentPostureErrorCode, message: string) {
    super(message);
    this.name = 'DeploymentPostureError';
    this.code = code;
  }
}

const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

/**
 * `localhost`, any `127.0.0.0/8` literal, `::1` or `[::1]`; case-insensitive and never trimmed, so
 * a padded value, which a listener cannot bind as given, is refused.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;
  const match = IPV4_LOOPBACK.exec(normalized);
  if (match === null) return false;
  return match.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Read the deployment posture from an environment, or throw {@link DeploymentPostureError}.
 *
 * An unset or blank `AW_DEPLOYMENT_POSTURE` derives the posture from `NODE_ENV` without checking
 * HOST. An explicit `local` needs HOST set to a loopback literal.
 */
export function readDeploymentPosture(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeploymentPosture {
  return checkDeploymentPosture(env, env['HOST']);
}

/**
 * Read the posture from `env` and check an explicit `local` against `bindHost`, the host the
 * calling process actually listens on, which can differ from `env`'s HOST when a launcher passes
 * its own environment. `undefined` (nothing named) is refused under `local` like any other
 * non-loopback value.
 */
export function checkDeploymentPosture(
  env: Readonly<Record<string, string | undefined>>,
  bindHost: string | undefined,
): DeploymentPosture {
  const raw = (env[DEPLOYMENT_POSTURE_ENV] ?? '').trim();
  if (raw.length === 0) return env['NODE_ENV'] === 'production' ? 'production' : 'local';
  const parsed = deploymentPostureSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeploymentPostureError(
      'invalid_deployment_posture',
      `${DEPLOYMENT_POSTURE_ENV} must be one of ${deploymentPostures.join(', ')}`,
    );
  }
  if (parsed.data === 'local' && (bindHost === undefined || !isLoopbackHost(bindHost))) {
    throw new DeploymentPostureError(
      'local_posture_needs_loopback_host',
      `local posture needs a loopback HOST (${DEPLOYMENT_POSTURE_ENV}=local)`,
    );
  }
  return parsed.data;
}
