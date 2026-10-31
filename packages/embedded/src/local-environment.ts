/**
 * S1-11 (#449), contract C1: the environment the local runtime runs its three services in.
 *
 * `aw dev` resolves the port, the runtime driver and the bootstrap admin from the project file and
 * sends them in `start`; the posture variables are fixed. A value the process environment or `.env`
 * already sets to something else is refused rather than silently overridden or silently ignored, and
 * the error names the variable, never its value. `NODE_ENV` is the one forced value: it says how the
 * bundle was built (a production Next build), not what the deployment is (see `core/posture.ts`).
 * `MIGRATIONS_DIR`, `GATEWAY_PRICING_JSON` and `AW_DEPLOYMENT_DEFAULT_MODELS` (#506) are defaults:
 * a value already set wins, an empty one included. A set `WORKSPACE_SLUG` must be a slug, so a bad
 * one is refused here rather than by the seed.
 *
 * S2-04a (#534, the ADR-0109 slice-2 amendment) adds two checks. A name `start.environment.withheld`
 * carries (SD17) is a `secret()` the local runtime does not hold: when the environment or `.env` holds
 * it in any case, even blank, startup is refused and the message says to remove it from `.env`.
 * `start.environment.policy` (contract C13, SD5) becomes `AW_DEPLOYMENT_POLICY` as canonical JSON. A
 * hand-set `AW_DEPLOYMENT_POLICY` must be a valid policy ceiling whether or not `policy` is sent, and
 * must equal it when it is; with no `policy` a valid hand-set value applies as is, with a warning.
 *
 * Issue #1495 (ADR-0160 D5): `start.environment.features` becomes `AW_DEPLOYMENT_FEATURES`, the
 * comma-separated list the web control plane reads, under the same rules as the policy ceiling.
 */
import { checkDeploymentPosture, isLoopbackHost } from '@agent-workspace/core/posture';
import { type FeatureId, FeatureListSchema } from '@indx-workspace/contracts/features';
import {
  LocalRuntimeCredentialMessageSchema,
  type LocalRuntimeStartMessage,
} from '@indx-workspace/contracts/local-runtime';
import { type ProjectPolicy, ProjectPolicySchema } from '@indx-workspace/contracts/policy-ceiling';
import {
  DEFAULT_LOCAL_PORT,
  LOCAL_RUNTIME_GATEWAY_PORT,
  LOCAL_RUNTIME_RUNNER_PORT,
  type LocalRuntimeService,
} from '@indx-workspace/contracts/project-file';

import {
  AW_DATABASE_PORT_VARIABLE,
  EMBEDDED_DATABASE_PORT,
  type LoopbackListenerState,
  resolveEmbeddedDatabasePort,
} from './embedded-db.js';

/** The host every local service binds; the local posture refuses anything but loopback. */
const LOCAL_RUNTIME_HOST = '127.0.0.1';

/**
 * The gateway refuses to start without a price catalogue, and a project `aw init` created has no
 * `.env`. This is the sentinel `.env.example` and the CLI's rendered `.env` ship: the gateway
 * becomes healthy, but the catalogue matches no real provider model, so metered runs settle
 * unpriced (cost zero, accounting state `unavailable`) until the person sets reviewed rates in
 * `.env` or the environment, which win over it.
 */
export const UNCONFIGURED_PRICING_JSON = JSON.stringify({
  version: 'unconfigured',
  models: { 'disabled:unconfigured': { inputUsdPerMillion: '0', outputUsdPerMillion: '0' } },
});

/**
 * S1-23 (#506): contract C7's deployment default model for the local posture, the last layer of the
 * run model ladder (ADR-0103 amendment). It is keyed by provider because the `default` connection may
 * be either: `aw dev` creates an Anthropic one, but leaves an existing one of any provider alone.
 * `claude-sonnet-4-5` is what the setup wizard seeds (ADR-0030) and what the journey's fake Anthropic
 * lists; real Anthropic accepts it. `gpt-5.1` matches the setup's OpenAI seed. No id is set for the
 * providers whose ids are deployment-specific, so an agent on one of those gets the typed refusal.
 */
export const LOCAL_DEPLOYMENT_DEFAULT_MODELS_JSON = JSON.stringify({
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5.1',
});

export type LocalRuntimeEnvironmentErrorCode =
  | 'non_loopback_host'
  | 'conflicting_value'
  | 'invalid_value'
  | 'reserved_port'
  | 'withheld_secret_set';

/** The variable the project file's policy ceiling travels in (C13, ADR-0102 SD6). */
const POLICY_VARIABLE = 'AW_DEPLOYMENT_POLICY';

/** The variable the project file's features travel in (ADR-0160 D5), as a comma-separated list. */
const FEATURES_VARIABLE = 'AW_DEPLOYMENT_FEATURES';

/** The variable `start.environment.modelSecrets` travels in, as a JSON array (issue #661). */
const MODEL_SECRETS_VARIABLE = 'AW_LOCAL_MODEL_SECRETS';

/**
 * A warning {@link applyLocalRuntimeEnvironment} returns, word for word from the ADR-0109 slice-2
 * amendment: a hand-set ceiling applies although the project file declares none.
 */
export const HAND_SET_POLICY_WARNING =
  'warning: AW_DEPLOYMENT_POLICY is set in the environment or .env and agent-workspace.yaml has no policy; that ceiling applies';

/**
 * A warning {@link applyLocalRuntimeEnvironment} returns, worded as {@link HAND_SET_POLICY_WARNING}:
 * a hand-set feature list applies although the project file declares none (issue #1495).
 */
export const HAND_SET_FEATURES_WARNING =
  'warning: AW_DEPLOYMENT_FEATURES is set in the environment or .env and agent-workspace.yaml has no features; that list applies';

/**
 * The variables, in the environment or `.env`, that move the runner's or the gateway's port off its
 * fixed ADR-0109 port (`workspace.ts` passes them on as the service's `PORT`).
 */
type LocalRuntimePortVariable = 'RUNNER_PORT' | 'GATEWAY_PORT' | 'AW_DATABASE_PORT';

/**
 * Issue #560: a service the local runtime binds before web: the project file's reserved runner and
 * gateway, and the embedded PostgreSQL, which binds first unless `DATABASE_URL` names a database.
 */
type LocalRuntimeReservedService = LocalRuntimeService | 'database';

/** Issue #560: the runtime service whose port the project's web port would take. */
export interface LocalRuntimeReservedPort {
  readonly port: number;
  readonly service: LocalRuntimeReservedService;
  /** The variable that moved the service onto `port`; `undefined` when it is the fixed port. */
  readonly variable: LocalRuntimePortVariable | undefined;
}

/** The slug grammar `credential.workspaceSlug` carries, so a slug the seed uses can also be sent. */
const WorkspaceSlugSchema = LocalRuntimeCredentialMessageSchema.unwrap().shape.workspaceSlug;

/** The variables C1 fixes, and that a differing pre-existing value is refused for. */
export type LocalRuntimeVariable =
  | 'HOST'
  | 'AW_DEPLOYMENT_POSTURE'
  | 'AW_LOCAL_SURFACE_SESSIONS'
  | 'PORT'
  | 'BOOTSTRAP_ADMIN'
  | 'RUNTIME_DRIVER'
  | 'WORKSPACE_SLUG';

/**
 * The variable a {@link LocalRuntimeEnvironmentError} names: a C1 {@link LocalRuntimeVariable},
 * `AW_DEPLOYMENT_POLICY`, `AW_DEPLOYMENT_FEATURES`, or (for `withheld_secret_set`) a name from
 * `start.environment.withheld`, which the start message schema has already validated as a secret
 * name. Never a value.
 */
export type LocalRuntimeEnvironmentVariable = string;

function reservedPortMessage(
  variable: LocalRuntimeEnvironmentVariable,
  reserved: LocalRuntimeReservedPort | undefined,
): string {
  if (reserved === undefined) {
    return `${variable} is a port the local runtime uses for its own services; choose another environments.local.port`;
  }
  const taken = `port ${String(reserved.port)} is the local runtime's ${reserved.service} port`;
  return reserved.variable === undefined
    ? `${taken}; choose another environments.local.port`
    : `${taken} (${reserved.variable} in the environment or .env); change ${reserved.variable} or choose another environments.local.port`;
}

function invalidValueMessage(variable: LocalRuntimeEnvironmentVariable): string {
  if (variable === POLICY_VARIABLE) {
    return `${variable} in the environment or .env must be a JSON policy ceiling (ADR-0102 SD6); unset it, or set policy in agent-workspace.yaml instead`;
  }
  if (variable === FEATURES_VARIABLE) {
    return `${variable} in the environment or .env must be a comma-separated list of feature ids, each once and with the features it needs (ADR-0160 D5); unset it, or set features in agent-workspace.yaml instead`;
  }
  return `${variable} in the environment or .env must be a workspace slug: lower-case letters, digits and hyphens, at most 63 characters`;
}

function environmentErrorMessage(
  code: LocalRuntimeEnvironmentErrorCode,
  variable: LocalRuntimeEnvironmentVariable,
  reserved: LocalRuntimeReservedPort | undefined,
): string {
  switch (code) {
    case 'non_loopback_host':
      return `local posture needs a loopback HOST: unset ${variable} or set it to ${LOCAL_RUNTIME_HOST}`;
    case 'conflicting_value':
      if (variable === 'PORT') {
        return 'PORT is set in the environment or .env to another port than the web port aw dev starts the runtime on; remove it from .env, and choose the port with aw dev --port <n> or environments.local.port in agent-workspace.yaml';
      }
      return variable === 'HOST'
        ? `the local runtime binds ${LOCAL_RUNTIME_HOST}: unset HOST or set it to ${LOCAL_RUNTIME_HOST}`
        : `${variable} is set in the environment or .env to a value the local runtime cannot use; unset it, or change the project file instead`;
    case 'invalid_value':
      return invalidValueMessage(variable);
    case 'withheld_secret_set':
      return `${variable} is named by secret() and is set in .env; the local runtime holds no secret: remove it from .env and start aw dev with ${variable} in its environment`;
    case 'reserved_port':
      return reservedPortMessage(variable, reserved);
  }
}

export class LocalRuntimeEnvironmentError extends Error {
  readonly code: LocalRuntimeEnvironmentErrorCode;
  readonly variable: LocalRuntimeEnvironmentVariable;
  /** For `reserved_port`: the port and the runtime service that binds it (issue #560). */
  readonly reserved: LocalRuntimeReservedPort | undefined;

  constructor(code: 'reserved_port', variable: 'PORT', reserved: LocalRuntimeReservedPort);
  constructor(
    code: Exclude<LocalRuntimeEnvironmentErrorCode, 'reserved_port'>,
    variable: LocalRuntimeEnvironmentVariable,
  );
  constructor(
    code: LocalRuntimeEnvironmentErrorCode,
    variable: LocalRuntimeEnvironmentVariable,
    reserved?: LocalRuntimeReservedPort,
  ) {
    super(environmentErrorMessage(code, variable, reserved));
    this.name = 'LocalRuntimeEnvironmentError';
    this.code = code;
    this.variable = variable;
    this.reserved = reserved;
  }
}

/** What {@link applyLocalRuntimeEnvironment} reports besides the environment it writes. */
export interface LocalRuntimeEnvironmentOutcome {
  /** One line each, without a trailing newline; the launcher writes them to stderr. */
  readonly warnings: readonly string[];
}

export interface LocalRuntimeEnvironmentOptions {
  /** The migrations shipped with the runtime; used unless `MIGRATIONS_DIR` is already set. */
  readonly migrationsDir: string;
}

function requireValue(
  env: Record<string, string | undefined>,
  variable: LocalRuntimeVariable,
  value: string,
): void {
  const existing = env[variable];
  if (existing !== undefined && existing !== value) {
    throw new LocalRuntimeEnvironmentError(
      variable === 'HOST' && !isLoopbackHost(existing) ? 'non_loopback_host' : 'conflicting_value',
      variable,
    );
  }
  env[variable] = value;
}

/** `value` with only ASCII letters upper-cased, as `secret-reference.ts` compares names. */
function asciiUpperCase(value: string): string {
  return value.replace(/[a-z]/gu, (letter) => letter.toUpperCase());
}

/**
 * Refuse a withheld secret name (SD17) the environment or `.env` holds in any case, a blank value
 * included. The error names the start message's name, never the key's spelling or its value.
 */
function refuseWithheldNames(
  env: Record<string, string | undefined>,
  withheld: readonly string[],
): void {
  if (withheld.length === 0) return;
  const present = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) present.add(asciiUpperCase(key));
  }
  for (const name of withheld) {
    if (present.has(asciiUpperCase(name))) {
      throw new LocalRuntimeEnvironmentError('withheld_secret_set', name);
    }
  }
}

function byCodeUnit(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * JSON with object keys sorted by code unit at every depth, array order kept, `undefined` members
 * dropped and no whitespace, so two equal ceilings compare equal as strings. Its input is a parsed
 * {@link ProjectPolicy}: booleans, finite numbers, strings, arrays and plain objects.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const members: string[] = [];
    const entries: [string, unknown][] = Object.entries(value);
    for (const [key, member] of entries.sort(([left], [right]) => byCodeUnit(left, right))) {
      if (member === undefined) continue;
      members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
    }
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A hand-set `AW_DEPLOYMENT_POLICY`, parsed; refused as `invalid_value`, a blank one included. */
function parseHandSetPolicy(value: string): ProjectPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LocalRuntimeEnvironmentError('invalid_value', POLICY_VARIABLE);
  }
  const result = ProjectPolicySchema.safeParse(parsed);
  if (!result.success) throw new LocalRuntimeEnvironmentError('invalid_value', POLICY_VARIABLE);
  return result.data;
}

/**
 * Map the project file's policy ceiling (C13, SD5) to `AW_DEPLOYMENT_POLICY` and return the warnings
 * to print. A hand-set value must be a valid ceiling, and equal to `policy` when that is sent.
 */
function applyPolicy(
  env: Record<string, string | undefined>,
  policy: ProjectPolicy | undefined,
): readonly string[] {
  const handSet = env[POLICY_VARIABLE];
  const parsedHandSet = handSet === undefined ? undefined : parseHandSetPolicy(handSet);
  if (policy !== undefined) {
    const wanted = canonicalJson(policy);
    if (parsedHandSet !== undefined && canonicalJson(parsedHandSet) !== wanted) {
      throw new LocalRuntimeEnvironmentError('conflicting_value', POLICY_VARIABLE);
    }
    env[POLICY_VARIABLE] = wanted;
    return [];
  }
  return parsedHandSet === undefined ? [] : [HAND_SET_POLICY_WARNING];
}

/**
 * A hand-set `AW_DEPLOYMENT_FEATURES`, parsed as the web control plane parses it (split on `,`, each
 * id trimmed, one `FeatureListSchema`); refused as `invalid_value`, a blank one included, since only
 * an unset variable means every feature here.
 */
function parseHandSetFeatures(value: string): readonly FeatureId[] {
  const result = FeatureListSchema.safeParse(value.split(',').map((id) => id.trim()));
  if (!result.success) throw new LocalRuntimeEnvironmentError('invalid_value', FEATURES_VARIABLE);
  return result.data;
}

/** True when both lists hold the same features; order is not meaningful to the control plane. */
function sameFeatures(left: readonly FeatureId[], right: readonly FeatureId[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

/**
 * Map the project file's features (ADR-0160 D5) to `AW_DEPLOYMENT_FEATURES` and return the warnings
 * to print. A hand-set value must be a valid list, and name the same features when `features` is sent.
 */
function applyFeatures(
  env: Record<string, string | undefined>,
  features: readonly FeatureId[] | undefined,
): readonly string[] {
  const handSet = env[FEATURES_VARIABLE];
  const parsedHandSet = handSet === undefined ? undefined : parseHandSetFeatures(handSet);
  if (features !== undefined) {
    if (parsedHandSet !== undefined && !sameFeatures(parsedHandSet, features)) {
      throw new LocalRuntimeEnvironmentError('conflicting_value', FEATURES_VARIABLE);
    }
    env[FEATURES_VARIABLE] = features.join(',');
    return [];
  }
  return parsedHandSet === undefined ? [] : [HAND_SET_FEATURES_WARNING];
}

/** A port the service itself would accept from its variable: digits only, in 1..65535. */
function portNumber(text: string, pattern: RegExp): number | undefined {
  if (!pattern.test(text)) return undefined;
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

/**
 * The port the runner binds for `RUNNER_PORT`, parsed as the runner parses its `PORT`
 * (`apps/runner` `parsePort`): unset, empty or blank is the fixed port, the value is trimmed, and
 * anything else that is not a port makes the runner refuse to start, so it reserves nothing here.
 * `AW_DATABASE_PORT` is trimmed the same way, with the database's own `fixed` port.
 */
function runnerPort(
  raw: string | undefined,
  fixed: number = LOCAL_RUNTIME_RUNNER_PORT,
): number | undefined {
  const text = raw?.trim() ?? '';
  return text === '' ? fixed : portNumber(text, /^\d{1,5}$/u);
}

/**
 * The port the gateway binds for `GATEWAY_PORT`, parsed as the gateway parses its `PORT`
 * (`packages/gateway` `startGateway`): unset is the fixed port, the value is not trimmed, and an
 * empty or non-numeric one makes the gateway refuse to start, so it reserves nothing here.
 */
function gatewayPort(raw: string | undefined): number | undefined {
  return raw === undefined ? LOCAL_RUNTIME_GATEWAY_PORT : portNumber(raw, /^\d+$/u);
}

function reservedService(
  service: LocalRuntimeReservedService,
  variable: LocalRuntimePortVariable,
  port: number | undefined,
  fixed: number,
): LocalRuntimeReservedPort | undefined {
  if (port === undefined) return undefined;
  return { port, service, variable: port === fixed ? undefined : variable };
}

/**
 * Issue #560: the services bind their ports before web binds `PORT`, so a project port equal to
 * one can never start. The ports are the ones `workspace.ts` binds: the embedded PostgreSQL's
 * `AW_DATABASE_PORT` unless `DATABASE_URL` is set (then none is started), and the environment's
 * or `.env`'s (or, #664, the derived) `RUNNER_PORT` / `GATEWAY_PORT`, each parsed as its service parses it,
 * else the fixed ADR-0109 port. The project file's schema refuses only the fixed runner and gateway
 * ports: the file is shared, `.env` is per machine.
 */
function refuseReservedPort(env: Record<string, string | undefined>, port: number): void {
  const services: readonly (LocalRuntimeReservedPort | undefined)[] = [
    env['DATABASE_URL']
      ? undefined
      : reservedService(
          'database',
          AW_DATABASE_PORT_VARIABLE,
          runnerPort(env[AW_DATABASE_PORT_VARIABLE], EMBEDDED_DATABASE_PORT),
          EMBEDDED_DATABASE_PORT,
        ),
    reservedService(
      'runner',
      'RUNNER_PORT',
      runnerPort(env['RUNNER_PORT']),
      LOCAL_RUNTIME_RUNNER_PORT,
    ),
    reservedService(
      'gateway',
      'GATEWAY_PORT',
      gatewayPort(env['GATEWAY_PORT']),
      LOCAL_RUNTIME_GATEWAY_PORT,
    ),
  ];
  const taken = services.find((service) => service?.port === port);
  if (taken !== undefined) throw new LocalRuntimeEnvironmentError('reserved_port', 'PORT', taken);
}

/** The highest port a derived service port may be: below every OS dynamic range's start (#556). */
const LAST_DERIVED_PORT = 49_151;

/**
 * Issue #664: the services' ports move with the project's web port, so two projects on different
 * `environments.local.port`s run side by side with no setting. Each unset `GATEWAY_PORT`,
 * `RUNNER_PORT` and `AW_DATABASE_PORT` becomes its fixed port plus the web port's offset from 3000:
 * port 3000 keeps 4000 / 8080 / 25432, port 3070 gets 4070 / 8150 / 25502. A derived port outside
 * 1024-49151 keeps the fixed port. A set value, even a blank one, is left as it is.
 */
export function derivedServicePorts(webPort: number): Readonly<Record<string, number>> {
  const offset = webPort - DEFAULT_LOCAL_PORT;
  const derive = (fixed: number): number => {
    const port = fixed + offset;
    return port >= FIRST_UNPRIVILEGED_PORT && port <= LAST_DERIVED_PORT ? port : fixed;
  };
  return {
    GATEWAY_PORT: derive(LOCAL_RUNTIME_GATEWAY_PORT),
    RUNNER_PORT: derive(LOCAL_RUNTIME_RUNNER_PORT),
    [AW_DATABASE_PORT_VARIABLE]: derive(EMBEDDED_DATABASE_PORT),
  };
}

function deriveServicePorts(env: Record<string, string | undefined>, webPort: number): void {
  for (const [variable, port] of Object.entries(derivedServicePorts(webPort))) {
    env[variable] ??= String(port);
  }
}

/** Issue #660: a port the local runtime binds, what binds it, and the setting that moves it. */
export interface LocalRuntimePort {
  readonly port: number;
  readonly role: 'web' | 'gateway' | 'runner' | 'embedded PostgreSQL';
  readonly setting: string;
}

/** The lowest port an unprivileged process can bind. */
const FIRST_UNPRIVILEGED_PORT = 1024;

/**
 * Issue #660: every port the local runtime will bind once C1 is applied to `env`, so all of them
 * can be checked before anything starts. The values are parsed as {@link refuseReservedPort} and
 * the services parse them; a value the service refuses on its own is left out, as is a port below
 * 1024, whose bind error the service words itself. The embedded PostgreSQL's port is left out when
 * `DATABASE_URL` is set, and an invalid `AW_DATABASE_PORT` is refused as the database refuses it.
 */
export function localRuntimePorts(
  env: Readonly<Record<string, string | undefined>>,
  webPort: number,
): readonly LocalRuntimePort[] {
  const ports: (LocalRuntimePort | undefined)[] = [
    { port: webPort, role: 'web', setting: 'environments.local.port in agent-workspace.yaml' },
    withPort(gatewayPort(env['GATEWAY_PORT']), 'gateway', 'GATEWAY_PORT in .env'),
    withPort(runnerPort(env['RUNNER_PORT']), 'runner', 'RUNNER_PORT in .env'),
    env['DATABASE_URL']
      ? undefined
      : {
          port: resolveEmbeddedDatabasePort(env),
          role: 'embedded PostgreSQL',
          setting: 'AW_DATABASE_PORT in .env',
        },
  ];
  return ports.filter(
    (entry): entry is LocalRuntimePort =>
      entry !== undefined && entry.port >= FIRST_UNPRIVILEGED_PORT,
  );
}

function withPort(
  port: number | undefined,
  role: LocalRuntimePort['role'],
  setting: string,
): LocalRuntimePort | undefined {
  return port === undefined ? undefined : { port, role, setting };
}

/** A {@link LocalRuntimePort} that cannot be bound, with what the listener check found. */
export interface BusyLocalRuntimePort extends LocalRuntimePort {
  readonly state: LoopbackListenerState;
}

function busyPortLine({ port, role, setting, state }: BusyLocalRuntimePort): string {
  const subject = `port ${String(port)} (${role})`;
  const move = `set ${setting} to a free port below 49152`;
  switch (state) {
    case 'listening':
      return `${subject} is already in use: stop the process that holds it, or ${move}`;
    case 'none':
      return `${subject} cannot be bound on 127.0.0.1, but no process is listening on it: the operating system reserves it; ${move}`;
    case 'unknown':
      return `${subject} cannot be bound on 127.0.0.1, and whether a process holds it could not be determined: stop whatever holds it, or ${move}`;
  }
}

/**
 * Issue #660: ports the local runtime needs cannot be bound, found before anything started. The
 * message names every one, one line each, with its role and the setting that moves it. It carries
 * `code: 'EADDRINUSE'` and the first such `port`, so a second `aw dev` in the same project is still
 * worded as `already_running`.
 */
export class LocalRuntimePortsBusyError extends Error {
  readonly code = 'EADDRINUSE';
  readonly port: number;

  constructor(ports: readonly [BusyLocalRuntimePort, ...BusyLocalRuntimePort[]]) {
    super(
      [
        'the local runtime cannot start; nothing was started. These ports are not free:',
        ...ports.map((entry) => `  ${busyPortLine(entry)}`),
      ].join('\n'),
    );
    this.name = 'LocalRuntimePortsBusyError';
    this.port = ports[0].port;
  }
}

/**
 * Apply contract C1 to `env` for the `start` message, then check the resulting posture. Throws
 * {@link LocalRuntimeEnvironmentError} on a withheld secret name the environment holds, on a
 * conflicting value or on an invalid one, before anything is started. Returns the warnings the
 * launcher prints.
 */
export function applyLocalRuntimeEnvironment(
  env: Record<string, string | undefined>,
  start: LocalRuntimeStartMessage,
  options: LocalRuntimeEnvironmentOptions,
): LocalRuntimeEnvironmentOutcome {
  refuseWithheldNames(env, start.environment.withheld ?? []);
  requireValue(env, 'HOST', LOCAL_RUNTIME_HOST);
  requireValue(env, 'AW_DEPLOYMENT_POSTURE', 'local');
  requireValue(env, 'AW_LOCAL_SURFACE_SESSIONS', '1');
  requireValue(env, 'PORT', String(start.environment.port));
  deriveServicePorts(env, start.environment.port);
  refuseReservedPort(env, start.environment.port);
  requireValue(env, 'BOOTSTRAP_ADMIN', start.environment.bootstrapAdmin);
  if (start.environment.runtimeDriver !== undefined) {
    requireValue(env, 'RUNTIME_DRIVER', start.environment.runtimeDriver);
  }
  const workspaceSlug = env['WORKSPACE_SLUG'];
  if (
    workspaceSlug !== undefined &&
    workspaceSlug.trim() !== '' &&
    !WorkspaceSlugSchema.safeParse(workspaceSlug).success
  ) {
    throw new LocalRuntimeEnvironmentError('invalid_value', 'WORKSPACE_SLUG');
  }
  const warnings = [
    ...applyPolicy(env, start.environment.policy),
    ...applyFeatures(env, start.environment.features),
  ];
  // Names only (issue #661): the try page names them in the fix for a missing or rejected key.
  if (start.environment.modelSecrets !== undefined) {
    env[MODEL_SECRETS_VARIABLE] = JSON.stringify(start.environment.modelSecrets);
  }
  env['NODE_ENV'] = 'production';
  env['MIGRATIONS_DIR'] ??= options.migrationsDir;
  env['GATEWAY_PRICING_JSON'] ??= UNCONFIGURED_PRICING_JSON;
  env['AW_DEPLOYMENT_DEFAULT_MODELS'] ??= LOCAL_DEPLOYMENT_DEFAULT_MODELS_JSON;
  checkDeploymentPosture(env, env['HOST']);
  return { warnings };
}
