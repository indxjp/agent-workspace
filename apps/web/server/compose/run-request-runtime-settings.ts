/** The deployment values a run needs, once they have been read and found usable. */
export interface RuntimeSettings {
  /** `POST {runnerUrl}/run` — the §14.3 contract. No trailing slash. */
  readonly runnerUrl: string;
  /**
   * The directory, **inside the runtime container**, under which each workspace's sandbox lives.
   *
   * §25 requires a distinct `cwd` per workspace and forbids two tenants sharing one; this is the
   * parent of those, and the workspace id is the segment appended to it. It has a default because
   * it is a path in an image this repository builds, not a secret and not a value an operator has
   * to know — `Dockerfile`'s runner target works in `/app`, and `/workspace` is a sibling of it
   * that no build step writes to. Override it when the runtime is somebody else's image.
   */
  readonly workspaceRoot: string;
  /**
   * Whether the runner allocated this run's session a tool sandbox (ADR-0118 TS2). Absent for a
   * runtime that has none, which a run with code tools refuses by name.
   */
  readonly toolSandbox?: boolean;
}

export type RuntimeSettingsResult =
  | { readonly ok: true; readonly settings: RuntimeSettings }
  | { readonly ok: false; readonly reason: string };

/** The default for {@link RuntimeSettings.workspaceRoot}. See that field for why it has one. */
export const DEFAULT_WORKSPACE_ROOT = '/workspace';

/**
 * Read the runtime's deployment values, or say what is missing.
 *
 * `RUNNER_URL` has **no default**. A guess would be a URL nobody chose, and the failure it
 * produces — every run failing thirty seconds later with a connection error written into the run
 * record — is far worse than the 503 the run routes answer while this returns `ok: false`. That
 * is the ADR-0015 shape applied to configuration: the capability is unavailable because nothing
 * asserted it was available.
 *
 * The URL is parsed before it is used, so a value that is not a URL is rejected here with the
 * variable's name attached rather than at the first `fetch` of the first run.
 */
export function readRuntimeSettings(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeSettingsResult {
  const raw = env['RUNNER_URL'];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      ok: false,
      reason:
        'RUNNER_URL is not set, so there is no spec §14.3 runtime to relay runs to. The three ' +
        'run routes answer 503 run_api_not_configured until it is. Set it to the runtime ' +
        "container's base URL — inside compose that is http://runner:8080.",
    };
  }
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: `RUNNER_URL is not a parseable URL: ${JSON.stringify(trimmed)}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: `RUNNER_URL uses the "${parsed.protocol}" scheme; §14.3 is an HTTP contract.`,
    };
  }

  const rawRoot = env['RUNNER_WORKSPACE_ROOT'];
  const workspaceRoot =
    typeof rawRoot === 'string' && rawRoot.trim().length > 0
      ? rawRoot.trim().replace(/\/+$/, '')
      : DEFAULT_WORKSPACE_ROOT;
  if (workspaceRoot.length === 0) {
    return { ok: false, reason: 'RUNNER_WORKSPACE_ROOT is only slashes.' };
  }

  return {
    ok: true,
    settings: { runnerUrl: trimmed.replace(/\/+$/, ''), workspaceRoot },
  };
}
