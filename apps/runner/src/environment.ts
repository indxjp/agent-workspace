/**
 * A runner container is a control-plane process, not a source of sandbox configuration.
 * Per spec A.11, every value visible to the agent arrives on its run request (or is derived from
 * that request by compileRunRequest). In particular, no deployment variable is inherited.
 *
 * The one exception is what the operating system needs to start a program. The SDK replaces the
 * subprocess environment, so a run without `PATH` cannot find `node` or any tool the host installed
 * outside the shell's built-in default path. These are the keys, per platform, that
 * `apps/web/server/connectors/base-env.ts` gives a spawned connector command; nothing else is copied.
 */
const POSIX_KEYS = ['PATH', 'HOME'] as const;
const WIN32_KEYS = ['PATH', 'USERPROFILE', 'SystemRoot', 'TEMP'] as const;

export function runnerBaseEnvironment(
  containerEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of process.platform === 'win32' ? WIN32_KEYS : POSIX_KEYS) {
    const value = containerEnvironment[key];
    if (value !== undefined && value !== '') environment[key] = value;
  }
  return environment;
}

/** Request values win structurally over the base. */
export function runnerEnvironmentFor(
  requestEnvironment: Readonly<Record<string, string>>,
  base: Readonly<Record<string, string>> = runnerBaseEnvironment(),
): Record<string, string> {
  return { ...base, ...requestEnvironment };
}
