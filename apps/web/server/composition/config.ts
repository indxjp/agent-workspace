import { runtimeDriverIds, type RuntimeDriverId } from '@agent-workspace/run-protocol';
import { type RuntimeRunSpec } from '@agent-workspace/runtime/driver';
import { cloudflareSandboxRuntimeCapabilities } from '@agent-workspace/runtime/driver/cloudflare-sandbox';
import { ProjectPolicySchema, type ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import {
  configuredPath as configuredPathIn,
  resolveStorageSettings as resolveStorageSettingsWith,
  type ResolvedStorageSettings,
} from '@indx-workspace/contracts/storage-settings';

import { defaultRuntimeNetworkPolicy, type RuntimeNetworkPolicy } from '../../contracts/runtimes';

// The storage settings are resolved by contracts, so `agent-workspace doctor` decides the same way.
export {
  STORAGE_URL_ENV,
  legacyAreaPrefixes,
  storageAreaPlace,
  type StorageArea,
  type StorageAreaPlace,
  type StorageSettings,
} from '@indx-workspace/contracts/storage-settings';

/** The environment variable carrying the deployment's policy ceiling (C13, ADR-0102 SD6). */
export const DEPLOYMENT_POLICY_ENV = 'AW_DEPLOYMENT_POLICY';

/**
 * The deployment's policy ceiling (issue #535): `AW_DEPLOYMENT_POLICY` parsed with the one
 * `ProjectPolicySchema` the project file and the local runtime use (C13). Unset or blank means no
 * ceiling. A value that is not JSON or not a policy throws, so start-up stops rather than run
 * without the ceiling the operator asked for; the message names the issues, never the value.
 */
export function readDeploymentPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProjectPolicy | null {
  const raw = env[DEPLOYMENT_POLICY_ENV]?.trim();
  if (raw === undefined || raw === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${DEPLOYMENT_POLICY_ENV} is invalid: the value is not JSON`);
  }
  const parsed = ProjectPolicySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
  );
  throw new Error(`${DEPLOYMENT_POLICY_ENV} is invalid: ${issues.join('; ')}`);
}

/** A non-empty, trimmed environment value, or `null`; reads `process.env` by default. */
export function configuredPath(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  return configuredPathIn(name, env);
}

/**
 * Which driver id a runtime profile must select to reach the runner manager. An unset or blank
 * value means `docker`; any other value outside `runtimeDriverIds` is refused, without echoing it
 * because a mistyped value may be a secret.
 */
export function runnerManagerDriverId(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeDriverId {
  const raw = env['RUNTIME_DRIVER']?.trim();
  if (raw === undefined || raw.length === 0) return 'docker';
  const id = runtimeDriverIds.find((candidate) => candidate === raw);
  if (id === undefined) {
    throw new Error(
      `RUNTIME_DRIVER is not a runtime driver id; use one of ${runtimeDriverIds.join(', ')}, or leave it unset for docker.`,
    );
  }
  return id;
}

/**
 * Network policy used only by the runner manager's create/readiness/echo/destroy probe.
 *
 * Existing Docker and Cloud Run deployments intentionally retain `none`. ACA dynamic-session
 * pools choose egress at pool creation, so an egress-enabled preview pool must opt its probe into
 * `open` instead of asking the driver to enforce an impossible per-session `none` override.
 */
export function runtimeVerificationNetworkPolicy(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeRunSpec['networkPolicy'] {
  const value = env['RUNTIME_VERIFICATION_NETWORK_POLICY']?.trim();
  if (value === undefined || value.length === 0) return 'none';
  if (value === 'none' || value === 'restricted' || value === 'open') return value;
  throw new Error('RUNTIME_VERIFICATION_NETWORK_POLICY must be one of none, restricted, or open');
}

/**
 * Policy for the profile created by first-run setup.
 *
 * Every driver but ACA keeps {@link defaultRuntimeNetworkPolicy}'s strongest-enforceable default.
 * An ACA pool fixes its network mode at creation, so the first profile must match the pool-wide
 * policy the manager verifies with rather than promise a per-session mode the pool cannot honour.
 */
export function setupRuntimeNetworkPolicy(
  driverId: string,
  env: Readonly<Record<string, string | undefined>>,
): RuntimeRunSpec['networkPolicy'] {
  if (driverId !== 'aca-sessions') return defaultRuntimeNetworkPolicy(driverId);
  const policy = runtimeVerificationNetworkPolicy(env);
  if (policy === 'restricted') {
    throw new Error(
      'aca-sessions first-run setup requires RUNTIME_VERIFICATION_NETWORK_POLICY to be none or open',
    );
  }
  return policy;
}

/**
 * Why a driver refuses every run, or `null` when it declares a network policy it can run under.
 * `cloudflare-sandbox` declares none until egress denial is provable (ADR-0131), so setup records
 * this instead of failing, and the Runtimes screen shows it; runs stay refused by the driver.
 */
export function runtimeNetworkPolicyRefusal(driverId: string): string | null {
  return driverId === 'cloudflare-sandbox' &&
    cloudflareSandboxRuntimeCapabilities().networkPolicies.length === 0
    ? 'cloudflare-sandbox refuses every network policy (ADR-0131): runs are refused with network_policy_unsupported until a policy is declared.'
    : null;
}

/**
 * Which §15.2 network policies this deployment can actually enforce for a driver, or `null` when
 * the driver is free to carry any of them.
 *
 * An ACA dynamic-sessions pool fixes egress at pool creation, so the only policy it can honour is
 * the one the pool was built with — the same value the verification probe runs under. A profile
 * outside this set is refused at the HTTP boundary instead of being stored and then failing inside
 * `assertCompatibleRunSpec` on every run (spec §15.2: where a driver cannot express a policy
 * natively, the UI must say so rather than silently accept it).
 *
 * The web composition layer owns this mapping: it is the only place that knows the pool's
 * configured policy, which `packages/runtime` cannot read.
 *
 * `docker` enforces `restricted` only through the egress proxy (ADR-0117), so without
 * `AGENT_WORKSPACE_EGRESS_PROXY_IMAGE` it accepts `none` and `open` alone (BH061-030). Both Compose
 * files give web and the runner manager the same value. `kubernetes` is not narrowed here: the Helm
 * chart sets the image on the runner manager only, so web cannot tell.
 */
export function enforceableRuntimeNetworkPolicies(
  driverId: string,
  verificationNetworkPolicy: RuntimeNetworkPolicy,
  egressProxyConfigured: boolean,
): readonly RuntimeNetworkPolicy[] | null {
  if (driverId === 'docker') return egressProxyConfigured ? null : ['none', 'open'];
  if (driverId !== 'aca-sessions') return null;
  // A pool is EgressEnabled or not; `restricted` is a policy it can never hold (spec §15.2), so
  // reporting it would make the API refuse the only two policies that can run. Mirror
  // {@link setupRuntimeNetworkPolicy}'s refusal instead of publishing an inverted restriction.
  if (verificationNetworkPolicy === 'restricted') {
    throw new Error(
      'aca-sessions cannot enforce RUNTIME_VERIFICATION_NETWORK_POLICY=restricted; set none or open',
    );
  }
  return [verificationNetworkPolicy];
}

const ACA_HTTP_INGRESS_LIMIT_MS = 240_000;
const ACA_HTTP_INGRESS_SAFETY_MARGIN_MS = 15_000;

const VERCEL_FUNCTION_MAX_DURATION_MS = 300_000;
const VERCEL_FUNCTION_SAFETY_MARGIN_MS = 15_000;
const CONTAINER_STOP_MARGIN_MS = 15_000;

/**
 * The longest run the control plane's host allows, or `null` when the host sets no limit.
 *
 * On Vercel Functions (`VERCEL=1`, a system environment variable) a run's stream consumer lives
 * under `after()`/`waitUntil`, whose promises share the function's timeout (ADR-0120 LC7; the
 * duration page https://vercel.com/docs/functions/configuring-functions/duration, checked
 * 2026-10-08: 300 s default and Hobby maximum, 800 s on Pro and Enterprise). Fifteen seconds are
 * kept for the best-effort `/interrupt` and for concluding the run before the function is killed.
 * On a Cloudflare Container the limit is the idle stop less the same margin.
 */
export function hostRunLimitMs(env: Readonly<Record<string, string | undefined>>): number | null {
  // ponytail: the Hobby floor (300 s); Pro's 800 s needs `vercel.json` `functions.maxDuration` and
  // this constant to come from one setting, or a mismatch kills runs mid-stream.
  if (env['VERCEL'] === '1') {
    return VERCEL_FUNCTION_MAX_DURATION_MS - VERCEL_FUNCTION_SAFETY_MARGIN_MS;
  }
  // Cloudflare Containers (ADR-0127): the routing Worker stops the idle Container after this many
  // seconds (`setInactivityTimeout`, https://developers.cloudflare.com/containers/, checked
  // 2026-10-08), and the stop would kill a longer run's consumer. A malformed value is no limit.
  const idleStopSeconds = Number(env['AW_CONTAINER_IDLE_STOP_SECONDS']);
  return Number.isInteger(idleStopSeconds) && idleStopSeconds * 1000 > CONTAINER_STOP_MARGIN_MS
    ? idleStopSeconds * 1000 - CONTAINER_STOP_MARGIN_MS
    : null;
}

/**
 * What the host's run limit adds to the launcher. Vercel Functions (ADR-0120 LC7): `after` is
 * `waitUntil`, so the launch outlives the request that started it, and no run outlives the
 * function (https://nextjs.org/docs/app/api-reference/functions/after, checked 2026-10-08). A
 * Cloudflare Container is a long-lived server (ADR-0127): the launch outlives the request in its
 * process, so it needs the run limit and no `keepAlive`; `after` outside a request scope throws.
 */
export function hostLaunchOptions(
  env: Readonly<Record<string, string | undefined>>,
  after: (work: Promise<void>) => void,
): { hostMaxRunDurationMs?: number; keepAlive?: (work: Promise<void>) => void } {
  const limit = hostRunLimitMs(env);
  return {
    ...(limit === null ? {} : { hostMaxRunDurationMs: limit }),
    ...(env['VERCEL'] === '1'
      ? {
          keepAlive: (work: Promise<void>) => {
            after(work);
          },
        }
      : {}),
  };
}

/**
 * Bound an ACA run below the platform's 240-second HTTP request ceiling.
 *
 * `/run` is one streaming HTTP request and the runtime protocol has no resume cursor. Capping the
 * web-side lifetime at 225 seconds leaves fifteen seconds for the best-effort `/interrupt` before
 * ACA terminates the manager-to-session request. Other drivers retain the credential-derived
 * lifetime exactly. A Vercel host's limit is applied by the launcher ({@link hostRunLimitMs}).
 */
export function maximumRunDurationMs(
  env: Readonly<Record<string, string | undefined>>,
  gatewayTokenTtlSeconds: number,
): number {
  const credentialBoundMs = Math.max(1, Math.floor(gatewayTokenTtlSeconds * 900));
  return runnerManagerDriverId(env) === 'aca-sessions'
    ? Math.min(credentialBoundMs, ACA_HTTP_INGRESS_LIMIT_MS - ACA_HTTP_INGRESS_SAFETY_MARGIN_MS)
    : credentialBoundMs;
}

/** Whether two configured storage roots are the same directory or one contains the other. */
export async function storageRootsOverlap(firstRoot: string, secondRoot: string): Promise<boolean> {
  const path = await import('node:path');
  const first = path.resolve(firstRoot);
  const second = path.resolve(secondRoot);
  const isInside = (candidate: string, parent: string): boolean => {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return isInside(first, second) || isInside(second, first);
}

/**
 * Where this deployment keeps files, skills and session state (the storage design, §03 and §04),
 * including the `storage_endpoint_same_origin` refusal; see the contracts resolver.
 */
// @story US-STO-10
export function resolveStorageSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedStorageSettings {
  return resolveStorageSettingsWith(env);
}
