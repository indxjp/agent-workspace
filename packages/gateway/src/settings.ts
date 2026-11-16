/**
 * The model gateway's settings (refactoring part 03). `startGateway` and the Vercel Function entry
 * parse them once, before any database or secret store opens, and a refused value stops start-up
 * with every refused variable named at once. The parsers are pure functions over a record: they
 * read no file and open no connection, so tests pass values in and never touch `process.env`.
 *
 * The database, the master key and tracing keep their own readers in `packages/core`, shared with
 * web; they are not listed here.
 */
import { z } from 'zod';

import { parsePricingCatalog, type PricingCatalog } from './pricing.js';
import { scriptedModelsDirFromEnv } from './providers/scripted.js';

export type SettingsEnvironment = Readonly<Record<string, string | undefined>>;

/** One row of the generated settings table (`docs/operations/settings.md`, refactoring part 03). */
export interface SettingDescription {
  readonly name: string;
  readonly default: string;
  readonly meaning: string;
}

/** The shortest `GATEWAY_TOKEN_SECRET` the gateway accepts. */
export const MIN_TOKEN_SECRET_LENGTH = 32;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = '4000';
const MAX_PORT = 65_535;

/** The variables {@link readGatewayServerSettings} reads. */
export const GATEWAY_SETTINGS: readonly SettingDescription[] = [
  {
    name: 'GATEWAY_TOKEN_SECRET',
    default: 'none: start-up stops',
    meaning: `The key run tokens are signed with, at least ${String(MIN_TOKEN_SECRET_LENGTH)} characters. Web mints the tokens, so it holds the same value.`,
  },
  {
    name: 'GATEWAY_PRICING_JSON',
    default: 'none: start-up stops',
    meaning:
      'The model prices usage is charged at: JSON with a string `version` and at least one `provider:model` price. An invalid value stops start-up.',
  },
  {
    name: 'GATEWAY_TOOL_SANDBOX_AUTH',
    default: 'unset: no ID token is sent',
    meaning:
      '`google-id-token` sends a Google ID token to a Cloud Run tool sandbox. Any other value stops start-up.',
  },
  {
    name: 'GATEWAY_CONTROL_PLANE_ORIGIN',
    default: 'unset: every `aw-control` call is refused',
    meaning:
      "Web's origin, where the Builder's `aw-control` tool calls go. Anything but an http(s) origin with no path, query or credentials stops start-up.",
  },
  {
    name: 'GATEWAY_VERTEX_PROJECT_ID',
    default: 'unset: keyless (`vertex`) connections are refused',
    meaning:
      'The one Google Cloud project keyless connections may act on, with the cloud identity of the process.',
  },
  {
    name: 'RUNNER_MANAGER_TOKEN',
    default: 'unset: no manager token is sent',
    meaning:
      "The runner manager's token, sent when the gateway calls a tool sandbox the manager serves.",
  },
  {
    name: 'AW_SCRIPTED_MODELS_DIR',
    default: 'unset: no scripted models',
    meaning:
      'A test tool: an absolute folder of scripted model replies, offered only under the `local` posture. Anything else stops start-up.',
  },
  {
    name: 'AW_DEPLOYMENT_POSTURE',
    default: '`production` when `NODE_ENV` is `production`, otherwise `local`',
    meaning: 'Read here only when `AW_SCRIPTED_MODELS_DIR` is set, to check the `local` posture.',
  },
  {
    name: 'NODE_ENV',
    default: 'unset',
    meaning: 'Decides the posture above when `AW_DEPLOYMENT_POSTURE` is unset.',
  },
  {
    name: 'OIDC_ISSUER_URL',
    default: 'unset',
    meaning:
      'Read here only with `AW_SCRIPTED_MODELS_DIR` under the `production` posture, whose check refuses a non-https issuer.',
  },
  {
    name: 'HOST',
    default: `\`${DEFAULT_HOST}\``,
    meaning: 'The address the gateway listens on; a `local` posture must use a loopback host.',
  },
  {
    name: 'PORT',
    default: `\`${DEFAULT_PORT}\``,
    meaning: `The port the gateway listens on, 1 to ${String(MAX_PORT)}. Any other value stops start-up.`,
  },
];

export interface GatewaySettings {
  readonly tokenSecret: string;
  readonly pricing: PricingCatalog;
  /** `google-id-token` sends the ID token to a Cloud Run tool sandbox; `undefined` sends none. */
  readonly toolSandboxAuth: 'google-id-token' | undefined;
  /** `undefined` refuses every `aw-control` call. */
  readonly controlPlaneOrigin: string | undefined;
  /** `undefined` refuses keyless connections. */
  readonly vertexProjectId: string | undefined;
  readonly runnerManagerToken: string | undefined;
  /** The scripted-models folder, checked but not read; `undefined` in every deployment. */
  readonly scriptedModelsDir: string | undefined;
}

export interface GatewayListenSettings {
  readonly host: string;
  readonly port: number;
}

/** Thrown at start-up, listing every refused variable at once. */
export class GatewaySettingsError extends Error {
  override readonly name = 'GatewaySettingsError';

  /** One sentence per refused variable, each naming it. */
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`Gateway start-up stopped on invalid settings. ${reasons.join(' ')}`);
    this.reasons = reasons;
  }
}

/**
 * The log fields for a gateway that could not start: one field per refused variable for a
 * {@link GatewaySettingsError}, since the logger cuts a string field at 200 characters and a long
 * list would lose the variables after the first few; the error itself otherwise.
 */
export function startFailureFields(error: unknown): Readonly<Record<string, unknown>> {
  return error instanceof GatewaySettingsError ? { refused: error.reasons } : { error };
}

/** `GATEWAY_TOOL_SANDBOX_AUTH`: `google-id-token` sends the ID token; unset sends none. */
export function parseToolSandboxAuth(value: string | undefined): 'google-id-token' | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') return undefined;
  if (trimmed === 'google-id-token') return trimmed;
  throw new Error("GATEWAY_TOOL_SANDBOX_AUTH must be unset or 'google-id-token'.");
}

/**
 * An http(s) origin with no credentials, path, query or fragment, as the deployment sets
 * `GATEWAY_CONTROL_PLANE_ORIGIN`; parsed to its normalised `URL.origin`.
 */
const ControlPlaneOriginSchema = z
  .url({ protocol: /^https?$/u })
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '',
  )
  .transform((url) => url.origin);

/**
 * The control-plane origin from `GATEWAY_CONTROL_PLANE_ORIGIN`, checked once at startup: `undefined`
 * when unset (every `aw-control` call is then refused), and a startup error when it is not an
 * http(s) origin. The error never repeats the value.
 */
export function parseControlPlaneOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = ControlPlaneOriginSchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new Error(
      'GATEWAY_CONTROL_PLANE_ORIGIN must be an http(s) origin with no credentials, path or query.',
    );
  }
  return parsed.data;
}

/** `GATEWAY_TOKEN_SECRET`, as given: it is a key, so it is not trimmed. */
export function parseTokenSecret(value: string | undefined): string {
  if (value === undefined || value.length < MIN_TOKEN_SECRET_LENGTH) {
    throw new Error(
      `GATEWAY_TOKEN_SECRET must contain at least ${String(MIN_TOKEN_SECRET_LENGTH)} characters.`,
    );
  }
  return value;
}

/** `PORT`: the whole value is a decimal integer from 1 through 65535. */
export function parseGatewayPort(value: string | undefined): number {
  const text = value ?? DEFAULT_PORT;
  const port = /^\d+$/u.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`PORT must be an integer from 1 through ${String(MAX_PORT)}.`);
  }
  return port;
}

/** The one result each parser gives, or the reason it refused, so every refusal is listed at once. */
type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function attempt<T>(parse: () => T): Outcome<T> {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function refusalsOf(outcomes: readonly Outcome<unknown>[]): string[] {
  return outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.reason]));
}

function stop(refused: readonly string[]): never {
  throw new GatewaySettingsError(refused);
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** Parsed settings, or every reason a value was refused. */
type Collected<T> =
  | { readonly value: T; readonly refused?: undefined }
  | { readonly value?: undefined; readonly refused: readonly string[] };

function gatewaySettingsOf(env: SettingsEnvironment): Collected<GatewaySettings> {
  const tokenSecret = attempt(() => parseTokenSecret(env['GATEWAY_TOKEN_SECRET']));
  const pricing = attempt(() => parsePricingCatalog(env['GATEWAY_PRICING_JSON']));
  const toolSandboxAuth = attempt(() => parseToolSandboxAuth(env['GATEWAY_TOOL_SANDBOX_AUTH']));
  const controlPlaneOrigin = attempt(() =>
    parseControlPlaneOrigin(env['GATEWAY_CONTROL_PLANE_ORIGIN']),
  );
  const scriptedModelsDir = attempt(() => scriptedModelsDirFromEnv(env));
  const runnerManagerToken = env['RUNNER_MANAGER_TOKEN'] ?? '';
  const vertexProjectId = blankToUndefined(env['GATEWAY_VERTEX_PROJECT_ID']);
  if (
    !tokenSecret.ok ||
    !pricing.ok ||
    !toolSandboxAuth.ok ||
    !controlPlaneOrigin.ok ||
    !scriptedModelsDir.ok
  ) {
    return {
      refused: refusalsOf([
        tokenSecret,
        pricing,
        toolSandboxAuth,
        controlPlaneOrigin,
        scriptedModelsDir,
      ]),
    };
  }
  return {
    value: {
      tokenSecret: tokenSecret.value,
      pricing: pricing.value,
      toolSandboxAuth: toolSandboxAuth.value,
      controlPlaneOrigin: controlPlaneOrigin.value,
      vertexProjectId,
      runnerManagerToken: runnerManagerToken === '' ? undefined : runnerManagerToken,
      scriptedModelsDir: scriptedModelsDir.value,
    },
  };
}

function listenSettingsOf(env: SettingsEnvironment): Collected<GatewayListenSettings> {
  const port = attempt(() => parseGatewayPort(env['PORT']));
  if (!port.ok) return { refused: [port.reason] };
  return { value: { host: env['HOST'] ?? DEFAULT_HOST, port: port.value } };
}

/** Parse every gateway setting; throws {@link GatewaySettingsError} naming each refused variable. */
export function readGatewaySettings(env: SettingsEnvironment): GatewaySettings {
  const gateway = gatewaySettingsOf(env);
  if (gateway.refused !== undefined) stop(gateway.refused);
  return gateway.value;
}

/**
 * The gateway's settings and the address `startGateway` listens on, parsed together so a bad `PORT`
 * and a bad gateway setting are named in one error, before any store opens.
 */
export function readGatewayServerSettings(env: SettingsEnvironment): {
  readonly gateway: GatewaySettings;
  readonly listen: GatewayListenSettings;
} {
  const listen = listenSettingsOf(env);
  const gateway = gatewaySettingsOf(env);
  if (listen.refused !== undefined || gateway.refused !== undefined) {
    stop([...(listen.refused ?? []), ...(gateway.refused ?? [])]);
  }
  return { gateway: gateway.value, listen: listen.value };
}
