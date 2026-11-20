/**
 * The web process's settings (refactoring part 03, step 1). The composition root parses them once,
 * at start-up, and refuses a value the server would otherwise ignore, naming the variable: the
 * server then logs the refusal and exits (`stop-on-failed-start.ts`). The readers
 * that still take the environment call these same parsers, so a variable has one meaning wherever
 * it is read; a later step hands them the parsed object instead.
 *
 * Each settings module lists the variables it reads in a catalogue ({@link WEB_SETTINGS} here), and
 * `docs/40-operate/operations/settings.md` is generated from those catalogues (part 03, step 7):
 * `tests/settings-table/settings-table.docs-check.ts` fails when a catalogue misses a variable its parser reads, or when
 * the committed table is stale.
 */

import {
  DEMO_RUNS_PER_CLIENT_PER_DAY,
  DEMO_RUNS_PER_PERSON_PER_DAY,
} from '@indx-workspace/contracts/demo';

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
  /** `AW_EMAIL_LINK_BASE_URL`: where a sign-in link points; `null` when unset (sending is refused). */
  readonly emailLinkBaseUrl: string | null;
  /** `AW_EMAIL_LINK_SENDER`: the name of the email-link sender adapter; `null` when unset. */
  readonly emailLinkSender: string | null;
  /** `AW_EMAIL_LINK_CHALLENGE`: the name of the sign-up challenge adapter; `null` when unset. */
  readonly emailLinkChallenge: string | null;
  /** The Agent Store demo's caps and the lead retention period. */
  readonly demo: DemoSettings;
  /**
   * `AW_DEMO_OPERATOR_TOKEN`: the bearer token of the deployment's operator routes (template
   * seeding, the sample check, the maintenance flip, the readiness check); `null` when unset, and
   * every operator route then answers `404`.
   */
  readonly demoOperatorToken: string | null;
  /**
   * `AW_DEMO_ANTHROPIC_API_KEY`: the Anthropic API key the visitors' demo runs use, from the
   * deployment's Secret Manager; `null` when unset, and a demo copy then has no model to run on.
   */
  readonly demoAnthropicApiKey: string | null;
}

/**
 * The Agent Store demo's caps (internal spec, "Abuse controls"). The amounts are open human
 * decisions, so the ones the spec gives no default for are `null` while unset, and a demo run start
 * is then refused `demo_caps_unconfigured` (fail closed).
 */
export interface DemoSettings {
  /** `AW_DEMO_RUNS_PER_PERSON_PER_DAY`: runs one person may start in 24 hours. */
  readonly runsPerPersonPerDay: number;
  /** `AW_DEMO_RUNS_PER_CLIENT_PER_DAY`: runs one client address may start in 24 hours. */
  readonly runsPerClientPerDay: number;
  /** `AW_DEMO_MAX_TURNS_PER_RUN`: the most turns a demo run takes; `null` when unset. */
  readonly maxTurnsPerRun: number | null;
  /** `AW_DEMO_MAX_COST_PER_RUN_USD`: the most a demo run may spend; `null` when unset. */
  readonly maxCostPerRunUsd: number | null;
  /** `AW_DEMO_SITE_MAX_COST_PER_DAY_USD`: every demo run's spend per UTC day; `null` when unset. */
  readonly siteMaxCostPerDayUsd: number | null;
  /** `AW_STORE_LEAD_RETENTION_DAYS`: days a lead is kept after its last contact; `null` when unset. */
  readonly leadRetentionDays: number | null;
}

/** The largest USD amount a demo cost setting may name: a sanity bound, not a recommendation. */
export const DEMO_MAX_COST_USD = 100_000;

/** The longest lead retention period a deployment may set, in days: ten years. */
export const MAX_LEAD_RETENTION_DAYS = 3_650;

/** The shortest value a demo secret setting may have: anything shorter is a mistake, not a secret. */
export const DEMO_SECRET_MIN_LENGTH = 32;

const UNSET_REFUSES_DEMO_RUNS = 'unset: every demo run start is refused `demo_caps_unconfigured`';

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
  {
    name: 'AW_EMAIL_LINK_BASE_URL',
    default: 'unset: email sign-in links cannot be sent',
    meaning:
      'The absolute `http(s)` URL of the page that opens an email sign-in link (the Agent Store sign-in page); ' +
      'no credentials, query or fragment. Its origin is also the one origin the platform answers credentialed CORS to ' +
      "(the store's browser calls the sign-in, the lead form and, for an email-link session only, the demo run routes); unset, " +
      'no origin is allowed. Unset, `POST /api/auth/email-link` answers `503 email_link_unavailable`. ' +
      'Any other value stops start-up.',
  },
  {
    name: 'AW_EMAIL_LINK_SENDER',
    default: 'unset: email sign-in links cannot be sent',
    meaning:
      'The name of the adapter that delivers an email sign-in link; the provider is an open decision, so ' +
      'the production adapter is selected here. Unset, `POST /api/auth/email-link` answers `503 email_link_unavailable`. ' +
      'An unknown name stops start-up.',
  },
  {
    name: 'AW_EMAIL_LINK_CHALLENGE',
    default: 'unset: email sign-in links cannot be sent',
    meaning:
      'The name of the adapter that checks the sign-up challenge (CAPTCHA or an equivalent); the provider is an ' +
      'open decision, so the production adapter is selected here. Unset, `POST /api/auth/email-link` answers ' +
      '`503 email_link_unavailable`. An unknown name stops start-up.',
  },
  {
    name: 'AW_DEMO_RUNS_PER_PERSON_PER_DAY',
    default: `${String(DEMO_RUNS_PER_PERSON_PER_DAY)}, fixed by the Agent Store spec`,
    meaning:
      'Runs one person may start in their demo workspaces in 24 hours. A whole number from 1, or start-up stops.',
  },
  {
    name: 'AW_DEMO_RUNS_PER_CLIENT_PER_DAY',
    default: `${String(DEMO_RUNS_PER_CLIENT_PER_DAY)}, the spec's recommended default`,
    meaning:
      'Demo runs one client address may start in 24 hours, across every account it signs in as. ' +
      'A whole number from 1, or start-up stops.',
  },
  {
    name: 'AW_DEMO_MAX_TURNS_PER_RUN',
    default: UNSET_REFUSES_DEMO_RUNS,
    meaning:
      "The most turns one demo run takes; it is set on the visitor's copy of the demo agent. " +
      'A whole number from 1, or start-up stops.',
  },
  {
    name: 'AW_DEMO_MAX_COST_PER_RUN_USD',
    default: UNSET_REFUSES_DEMO_RUNS,
    meaning:
      "The most one demo run may spend, in USD; it is set on the visitor's copy of the demo agent. " +
      `A positive number up to ${String(DEMO_MAX_COST_USD)}, or start-up stops.`,
  },
  {
    name: 'AW_DEMO_SITE_MAX_COST_PER_DAY_USD',
    default: UNSET_REFUSES_DEMO_RUNS,
    meaning:
      "Every demo workspace's model spend together, per UTC day, in USD; at the cap no demo run starts. " +
      `A positive number up to ${String(DEMO_MAX_COST_USD)}, or start-up stops.`,
  },
  {
    name: 'AW_DEMO_OPERATOR_TOKEN',
    default: 'unset: the demo operator routes answer 404',
    meaning:
      "The bearer token of the deployment's own operator steps: seeding the demo templates, the nightly sample check, " +
      "the daily production test's maintenance flip and the readiness check. A secret, read from Secret Manager; " +
      `at least ${String(DEMO_SECRET_MIN_LENGTH)} characters, or start-up stops.`,
  },
  {
    name: 'AW_DEMO_ANTHROPIC_API_KEY',
    default: 'unset: a demo copy has no model to run on',
    meaning:
      "The Anthropic API key the visitors' demo runs use. A secret, read from Secret Manager, never shown or logged. " +
      `At least ${String(DEMO_SECRET_MIN_LENGTH)} characters with no whitespace, or start-up stops.`,
  },
  {
    name: 'AW_STORE_LEAD_RETENTION_DAYS',
    default: 'unset: the lead retention job does not run',
    meaning:
      'Days a store lead (address, demos tried, enquiry, launch notices) is kept after its last contact; a scheduled job deletes ' +
      'older ones. `GET /api/store/privacy` reports it to the privacy notice, which says it is to be set while unset. ' +
      `A whole number from 1 to ${String(MAX_LEAD_RETENTION_DAYS)}, or start-up stops.`,
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

/**
 * `AW_EMAIL_LINK_BASE_URL`: an absolute `http(s)` URL of the page that opens a sign-in link, with no
 * credentials, query or fragment: the link appends its own fragment, so the secret never reaches a
 * server log.
 */
export function parseEmailLinkBaseUrl(raw: string | undefined): Parsed<string | null> {
  if (raw === undefined || raw.trim() === '') return accept(null);
  const value = raw.trim();
  try {
    const url = new URL(value);
    const plain =
      url.username === '' && url.password === '' && url.search === '' && url.hash === '';
    if ((url.protocol === 'https:' || url.protocol === 'http:') && plain) return accept(value);
  } catch {
    // Not a URL: refused below, with the variable named.
  }
  return refuse(
    `AW_EMAIL_LINK_BASE_URL is ${JSON.stringify(value)}; expected an absolute http(s) URL with no ` +
      'credentials, query or fragment.',
  );
}

/** `AW_EMAIL_LINK_SENDER`: a sender adapter name, or unset. The adapter registry refuses an unknown one. */
export function parseEmailLinkSender(raw: string | undefined): Parsed<string | null> {
  if (raw === undefined || raw.trim() === '') return accept(null);
  return accept(raw.trim());
}

/** `AW_EMAIL_LINK_CHALLENGE`: a challenge adapter name, or unset. The adapter registry refuses an unknown one. */
export function parseEmailLinkChallenge(raw: string | undefined): Parsed<string | null> {
  if (raw === undefined || raw.trim() === '') return accept(null);
  return accept(raw.trim());
}

/**
 * A demo secret setting (`AW_DEMO_OPERATOR_TOKEN`, `AW_DEMO_ANTHROPIC_API_KEY`): `null` when unset or
 * blank, else at least {@link DEMO_SECRET_MIN_LENGTH} characters with no whitespace. A refusal names
 * the variable and never the value.
 */
export function parseDemoSecret(name: string, raw: string | undefined): Parsed<string | null> {
  if (raw === undefined || raw.trim() === '') return accept(null);
  const trimmed = raw.trim();
  if (trimmed.length < DEMO_SECRET_MIN_LENGTH || /\s/u.test(trimmed)) {
    return refuse(
      `${name} is set but is not a usable secret; expected at least ${String(DEMO_SECRET_MIN_LENGTH)} characters with no whitespace.`,
    );
  }
  return accept(trimmed);
}

/** A whole number from 1 up to `max`, or `null` when unset. */
function positiveWholeNumber(
  name: string,
  raw: string | undefined,
  max: number = Number.MAX_SAFE_INTEGER,
): Parsed<number | null> {
  if (raw === undefined || raw.trim() === '') return accept(null);
  const value = wholeNumber(raw);
  if (value !== null && value >= 1 && value <= max) return accept(value);
  return refuse(
    `${name} is ${JSON.stringify(raw.trim())}; expected a whole number from 1` +
      (max === Number.MAX_SAFE_INTEGER ? '.' : ` to ${String(max)}.`),
  );
}

/** A positive decimal USD amount up to {@link DEMO_MAX_COST_USD}, or `null` when unset. */
function usdAmount(name: string, raw: string | undefined): Parsed<number | null> {
  if (raw === undefined || raw.trim() === '') return accept(null);
  const trimmed = raw.trim();
  const value = /^\d+(?:\.\d+)?$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (value > 0 && value <= DEMO_MAX_COST_USD) return accept(value);
  return refuse(
    `${name} is ${JSON.stringify(trimmed)}; expected a positive USD amount up to ${String(DEMO_MAX_COST_USD)}.`,
  );
}

const withDefault = (parsed: Parsed<number | null>, fallback: number): Parsed<number> =>
  parsed.ok ? accept(parsed.value ?? fallback) : parsed;

/** The demo caps and the lead retention period, each from its own variable. */
export function parseDemoSettings(env: SettingsEnvironment): Parsed<DemoSettings> {
  const runsPerPersonPerDay = withDefault(
    positiveWholeNumber('AW_DEMO_RUNS_PER_PERSON_PER_DAY', env['AW_DEMO_RUNS_PER_PERSON_PER_DAY']),
    DEMO_RUNS_PER_PERSON_PER_DAY,
  );
  const runsPerClientPerDay = withDefault(
    positiveWholeNumber('AW_DEMO_RUNS_PER_CLIENT_PER_DAY', env['AW_DEMO_RUNS_PER_CLIENT_PER_DAY']),
    DEMO_RUNS_PER_CLIENT_PER_DAY,
  );
  const maxTurnsPerRun = positiveWholeNumber(
    'AW_DEMO_MAX_TURNS_PER_RUN',
    env['AW_DEMO_MAX_TURNS_PER_RUN'],
  );
  const maxCostPerRunUsd = usdAmount(
    'AW_DEMO_MAX_COST_PER_RUN_USD',
    env['AW_DEMO_MAX_COST_PER_RUN_USD'],
  );
  const siteMaxCostPerDayUsd = usdAmount(
    'AW_DEMO_SITE_MAX_COST_PER_DAY_USD',
    env['AW_DEMO_SITE_MAX_COST_PER_DAY_USD'],
  );
  const leadRetentionDays = positiveWholeNumber(
    'AW_STORE_LEAD_RETENTION_DAYS',
    env['AW_STORE_LEAD_RETENTION_DAYS'],
    MAX_LEAD_RETENTION_DAYS,
  );
  if (
    runsPerPersonPerDay.ok &&
    runsPerClientPerDay.ok &&
    maxTurnsPerRun.ok &&
    maxCostPerRunUsd.ok &&
    siteMaxCostPerDayUsd.ok &&
    leadRetentionDays.ok
  ) {
    return accept({
      runsPerPersonPerDay: runsPerPersonPerDay.value,
      runsPerClientPerDay: runsPerClientPerDay.value,
      maxTurnsPerRun: maxTurnsPerRun.value,
      maxCostPerRunUsd: maxCostPerRunUsd.value,
      siteMaxCostPerDayUsd: siteMaxCostPerDayUsd.value,
      leadRetentionDays: leadRetentionDays.value,
    });
  }
  return refuse(
    [
      runsPerPersonPerDay,
      runsPerClientPerDay,
      maxTurnsPerRun,
      maxCostPerRunUsd,
      siteMaxCostPerDayUsd,
      leadRetentionDays,
    ]
      .flatMap((parsed) => (parsed.ok ? [] : [parsed.reason]))
      .join(' '),
  );
}

/** Parse every web setting; throws {@link SettingsError} naming each refused variable. */
export function readWebSettings(env: SettingsEnvironment): WebSettings {
  const trustedProxyHops = parseTrustedProxyHops(env['AW_TRUSTED_PROXY_HOPS']);
  const containerIdleStopSeconds = parseContainerIdleStopSeconds(
    env['AW_CONTAINER_IDLE_STOP_SECONDS'],
  );
  const emailLinkBaseUrl = parseEmailLinkBaseUrl(env['AW_EMAIL_LINK_BASE_URL']);
  const emailLinkSender = parseEmailLinkSender(env['AW_EMAIL_LINK_SENDER']);
  const emailLinkChallenge = parseEmailLinkChallenge(env['AW_EMAIL_LINK_CHALLENGE']);
  const demo = parseDemoSettings(env);
  const demoOperatorToken = parseDemoSecret(
    'AW_DEMO_OPERATOR_TOKEN',
    env['AW_DEMO_OPERATOR_TOKEN'],
  );
  const demoAnthropicApiKey = parseDemoSecret(
    'AW_DEMO_ANTHROPIC_API_KEY',
    env['AW_DEMO_ANTHROPIC_API_KEY'],
  );
  const refused = [
    trustedProxyHops,
    containerIdleStopSeconds,
    emailLinkBaseUrl,
    emailLinkSender,
    emailLinkChallenge,
    demo,
    demoOperatorToken,
    demoAnthropicApiKey,
  ].flatMap((parsed) => (parsed.ok ? [] : [parsed.reason]));
  if (
    !trustedProxyHops.ok ||
    !containerIdleStopSeconds.ok ||
    !emailLinkBaseUrl.ok ||
    !emailLinkSender.ok ||
    !emailLinkChallenge.ok ||
    !demo.ok ||
    !demoOperatorToken.ok ||
    !demoAnthropicApiKey.ok
  ) {
    throw new SettingsError(refused);
  }
  return {
    trustedProxyHops: trustedProxyHops.value,
    containerIdleStopSeconds: containerIdleStopSeconds.value,
    emailLinkBaseUrl: emailLinkBaseUrl.value,
    emailLinkSender: emailLinkSender.value,
    emailLinkChallenge: emailLinkChallenge.value,
    demo: demo.value,
    demoOperatorToken: demoOperatorToken.value,
    demoAnthropicApiKey: demoAnthropicApiKey.value,
  };
}
