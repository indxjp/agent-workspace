import { type DockerReapReport } from '@agent-workspace/runtime/driver/docker';
import {
  EngineImageConfigurationError,
  readEngineImageMap,
  type EngineImageMap,
} from '@agent-workspace/runtime/engine-images';
import { ADAPTER_ENGINE_IDS } from './engines.js';
import { type RunnerManagerOptions } from './manager.js';

/**
 * A variable `driver` needs, refused by name when unset or blank. Returns the value as set, since
 * the runtime package checks the same option again under its own name, which an operator cannot
 * map back to the variable.
 */
export function requiredDriverSetting(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  driver: string,
): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`runner manager: ${name} must be set when RUNTIME_DRIVER is ${driver}.`);
  }
  return value;
}

/** A variable that may be unset (its default applies) but not set to a blank value. */
export function optionalDriverSetting(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  driver: string,
): string | undefined {
  const value = env[name];
  if (value !== undefined && value.trim() === '') {
    throw new Error(
      `runner manager: ${name} is blank; unset it or give it a value when RUNTIME_DRIVER is ${driver}.`,
    );
  }
  return value;
}

export const noAgentStart = (): never => {
  throw new Error('runner manager proxies the runtime HTTP contract directly');
};

export type DriverOptions = Pick<
  RunnerManagerOptions,
  | 'driver'
  | 'expectedDriver'
  | 'runtimeOrigin'
  | 'runtimeRequestUrl'
  | 'runtimeAuthHeaders'
  | 'configurationFingerprint'
  | 'readinessPath'
  | 'toolSandboxes'
  | 'toolSandboxRefusal'
> &
  Readonly<{
    /**
     * Remove every sandbox this manager owns, on shutdown (issue #394). Only the Docker driver
     * sets it: its sandboxes are containers beside the manager's own, on a network `docker compose
     * down` cannot remove while they hold it. A cloud driver's sandboxes outlive a manager replica
     * by design and expire on their own.
     */
    reap?: () => Promise<DockerReapReport>;
  }>;

/**
 * The `engine → image` map this manager starts sandboxes from (ENG-07, #306).
 *
 * Parsed once, at start-up, and never re-read: a malformed map must stop a manager from coming up
 * rather than surface as a failed run an hour later, and `readEngineImageMap` is the same parser the
 * control plane uses to decide `installed`. The two processes therefore cannot disagree about which
 * engines this deployment offers — which is the whole reason the parser lives in
 * `packages/runtime` rather than in either application.
 *
 * An empty map is legal for the parser, and a driver built over one refuses every `create()`; a
 * runner manager whose driver takes an image, though, can serve no run without one. It therefore
 * refuses to start rather than come up healthy and fail every allocation (ADR-0015). The guard
 * lives here and not in the drivers, whose total `create()` the `no-image-at-all` replay vector
 * pins.
 */
export function engineImagesFor(
  env: Readonly<Record<string, string | undefined>>,
  requireDigest: boolean = env['NODE_ENV'] === 'production',
): EngineImageMap {
  const images = readEngineImageMap(env, {
    knownEngineIds: ADAPTER_ENGINE_IDS,
    requireDigest,
    source: 'runner manager environment',
  });
  if (images.size === 0) {
    throw new EngineImageConfigurationError(
      'runner manager: no engine runtime image is configured; set AGENT_WORKSPACE_RUNTIME_IMAGE_<ENGINE> for at least one engine, or the legacy RUNTIME_IMAGE for claude-agent-sdk.',
      [],
    );
  }
  return images;
}

/**
 * A fingerprint over the whole map, so the control plane's Test Runtime approval is invalidated
 * when *any* engine's image changes rather than only when the first one does.
 */
export function imagesFingerprint(images: EngineImageMap): string {
  return [...images]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([engine, image]) => `${engine}=${image}`)
    .join(',');
}

/** `RUNTIME_PROXY_BYPASS`: the hosts a proxied sandbox reaches directly (the gateway). */
export function proxyBypassFor(env: Readonly<Record<string, string | undefined>>): string[] {
  return (env['RUNTIME_PROXY_BYPASS'] ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}

/**
 * `RUNNER_MANAGER_STATELESS=true` (ADR-0126): the manager keeps no allocation table, so a Vercel
 * Function can serve it. The seal secret is `RUNNER_MANAGER_TOKEN`; the driver derives separate
 * keys from it. Only the two drivers whose provider can find a session's sandbox again support it.
 */
export function sealSecretFor(
  env: Readonly<Record<string, string | undefined>>,
  driver: 'external' | 'vercel-sandbox',
): { sealSecret?: string } {
  const flag = env['RUNNER_MANAGER_STATELESS']?.trim() ?? '';
  if (flag === '') return {};
  if (flag !== 'true') {
    throw new Error('runner manager: RUNNER_MANAGER_STATELESS must be true, or unset.');
  }
  const secret = env['RUNNER_MANAGER_TOKEN'] ?? '';
  if (secret.length < 32) {
    throw new Error(
      `runner manager: RUNNER_MANAGER_TOKEN must contain at least 32 characters when RUNNER_MANAGER_STATELESS is true (${driver}).`,
    );
  }
  return { sealSecret: secret };
}

/**
 * ADR-0132's backstop for a tool sandbox no close reached: it ends this many seconds after the
 * last run that opened it. 15 minutes unless `AGENT_WORKSPACE_TOOL_SANDBOX_TIMEOUT_SECONDS` says
 * otherwise, from one minute to one hour.
 */
export function toolSandboxTimeoutSeconds(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const text = env['AGENT_WORKSPACE_TOOL_SANDBOX_TIMEOUT_SECONDS']?.trim() || '900';
  const seconds = /^\d+$/u.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3_600) {
    throw new Error(
      'runner manager: AGENT_WORKSPACE_TOOL_SANDBOX_TIMEOUT_SECONDS must be an integer from 60 through 3600, or unset.',
    );
  }
  return seconds;
}

/**
 * How long a session's agent-runtime sandbox may sit idle before its provider ends it. It stays
 * above the longest run a host allows (285 s on Vercel, 885 s on Cloudflare), so no run is cut,
 * and a crashed or abandoned session frees its slot instead of holding it for the plan maximum.
 */
export const AGENT_RUNTIME_IDLE_SECONDS = 900;
