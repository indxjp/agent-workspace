/**
 * The web process's settings (refactoring part 03, step 1). The composition root parses them once,
 * at start-up, and refuses a value the server would otherwise ignore, naming the variable: the
 * server then logs the refusal and exits (`stop-on-failed-start.ts`). The readers
 * that still take the environment call these same parsers, so a variable has one meaning wherever
 * it is read; a later step hands them the parsed object instead.
 *
 * Each settings module lists the variables it reads in a catalogue ({@link WEB_SETTINGS} here), and
 * `docs/operations/settings.md` is generated from those catalogues (part 03, step 7):
 * `tests/settings-table.test.ts` fails when a catalogue misses a variable its parser reads, or when
 * the committed table is stale.
 */

export type SettingsEnvironment = Readonly<Record<string, string | undefined>>;

/** One row of the generated settings table: a variable, what applies when it is unset, and why it exists. */
export interface SettingDescription {
  readonly name: string;
  readonly default: string;
  readonly meaning: string;
}

/** A parsed value, or why the raw value was refused. */
export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/** The most proxies `AW_TRUSTED_PROXY_HOPS` may count. */
export const MAX_TRUSTED_PROXY_HOPS = 16;

/** Kept before a Cloudflare Container's idle stop for the best-effort interrupt (ADR-0127). */
export const CONTAINER_STOP_MARGIN_MS = 15_000;

export interface WebSettings {
  /** Proxies in front of web that append `X-Forwarded-For`; `null` trusts no chain. */
  readonly trustedProxyHops: number | null;
  /** Seconds a Cloudflare Container idles before it stops; `null` off Cloudflare. */
  readonly containerIdleStopSeconds: number | null;
}

/** The variables {@link readWebSettings} reads. */
export const WEB_SETTINGS: readonly SettingDescription[] = [
  {
    name: 'AW_TRUSTED_PROXY_HOPS',
    default: 'unset: no proxy chain is trusted',
    meaning:
      `How many reverse proxies in front of web append \`X-Forwarded-For\`, 1 to ${String(MAX_TRUSTED_PROXY_HOPS)}; ` +
      '`0` trusts none. Runnable public links refuse to run without it. Any other value stops start-up.',
  },
  {
    name: 'AW_CONTAINER_IDLE_STOP_SECONDS',
    default: 'unset: not on Cloudflare',
    meaning:
      'Seconds a Cloudflare Container idles before it stops; a run keeps ' +
      `${String(CONTAINER_STOP_MARGIN_MS / 1000)} s of it for the interrupt. Whole seconds above that, or start-up stops.`,
  },
];

/** Thrown at start-up, listing every refused variable at once. */
export class SettingsError extends Error {
  override readonly name = 'SettingsError';

  /** One sentence per refused variable, each naming it. */
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`Start-up stopped on invalid settings. ${reasons.join(' ')}`);
    this.reasons = reasons;
  }
}

const accept = <T>(value: T): Parsed<T> => ({ ok: true, value });
const refuse = (reason: string): Parsed<never> => ({ ok: false, reason });

/** A plain non-negative integer: `'1e3'`, `'9.5'`, `'-1'` and `'0x10'` are not. */
function wholeNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** `AW_TRUSTED_PROXY_HOPS`: unset or `0` trusts no proxy chain (the local installer renders `0`). */
export function parseTrustedProxyHops(raw: string | undefined): Parsed<number | null> {
  if (raw === undefined || raw.trim() === '') return accept(null);
  const hops = wholeNumber(raw);
  if (hops === 0) return accept(null);
  if (hops !== null && hops <= MAX_TRUSTED_PROXY_HOPS) return accept(hops);
  return refuse(
    `AW_TRUSTED_PROXY_HOPS is ${JSON.stringify(raw.trim())}; expected 0 (no proxy) or the number of ` +
      `proxies in front of web, 1 to ${String(MAX_TRUSTED_PROXY_HOPS)}.`,
  );
}

/** `AW_CONTAINER_IDLE_STOP_SECONDS`: must leave room for the interrupt margin. */
export function parseContainerIdleStopSeconds(raw: string | undefined): Parsed<number | null> {
  if (raw === undefined || raw.trim() === '') return accept(null);
  const seconds = wholeNumber(raw);
  if (seconds !== null && seconds * 1000 > CONTAINER_STOP_MARGIN_MS) return accept(seconds);
  return refuse(
    `AW_CONTAINER_IDLE_STOP_SECONDS is ${JSON.stringify(raw.trim())}; expected whole seconds ` +
      `above ${String(CONTAINER_STOP_MARGIN_MS / 1000)}, the margin a run keeps before the Container stops.`,
  );
}

/** Parse every web setting; throws {@link SettingsError} naming each refused variable. */
export function readWebSettings(env: SettingsEnvironment): WebSettings {
  const trustedProxyHops = parseTrustedProxyHops(env['AW_TRUSTED_PROXY_HOPS']);
  const containerIdleStopSeconds = parseContainerIdleStopSeconds(
    env['AW_CONTAINER_IDLE_STOP_SECONDS'],
  );
  const refused = [trustedProxyHops, containerIdleStopSeconds].flatMap((parsed) =>
    parsed.ok ? [] : [parsed.reason],
  );
  if (!trustedProxyHops.ok || !containerIdleStopSeconds.ok) {
    throw new SettingsError(refused);
  }
  return {
    trustedProxyHops: trustedProxyHops.value,
    containerIdleStopSeconds: containerIdleStopSeconds.value,
  };
}
