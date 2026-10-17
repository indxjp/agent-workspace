/**
 * The minimal, explicit environment a route handler hands `testConnection` — never
 * `process.env` itself. See `test-connection.ts`'s `baseEnv` documentation and
 * `docs/adr/W2-CP-05-stdio-probe-base-env-must-not-default-to-process-env.md` for the hazard this
 * closes: `compose.yaml` puts `DATABASE_URL`,
 * `MASTER_ENCRYPTION_KEY`, `SESSION_SECRET` and `BOOTSTRAP_ADMIN_PASSWORD` into the same `web`
 * service this route runs in, and a `stdio` probe spawns a caller-supplied command with whatever
 * `baseEnv` it is given, copied wholesale into the child.
 *
 * This is deliberately NOT "the environment the real runner would give a connector" — Wave 4's
 * model gateway / the sandboxed runner owns that decision (ADR-0021). It is only enough for a
 * caller-supplied command to actually start: `PATH` so the OS can resolve it, `HOME`/
 * `USERPROFILE` for tools that read a home directory, and, on win32 only, `SystemRoot` (loader
 * and DLL resolution depend on it) and `TEMP` (many Windows binaries fail outright without a
 * writable temp path). Nothing else in this process's environment is ever copied.
 *
 * `test-connection.ts` no longer defaults `baseEnv` to `process.env` when a caller omits it
 * (ADR-0015: an absent value must be an error, not a fallback) — every route call site is
 * required to construct one explicitly, and this is the one place that construction happens.
 */
const POSIX_KEYS = ['PATH', 'HOME'] as const;
const WIN32_ONLY_KEYS = ['PATH', 'USERPROFILE', 'SystemRoot', 'TEMP'] as const;

export function restrictedBaseEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string | undefined>> {
  const keys = process.platform === 'win32' ? WIN32_ONLY_KEYS : POSIX_KEYS;
  const env: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
