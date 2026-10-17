/**
 * `packages/runtime/src/env.ts` — the A.11 environment contract, as one injector, plus the
 * §25 per-session isolation paths.
 *
 * A.11: *"Every driver injects the same variables. This is what keeps the drivers
 * interchangeable."* This file is that injector: {@link buildRuntimeEnvironment} is the single
 * function that decides A.11's emitted key set, and every driver in this package — `local.ts`
 * today, `docker.ts` later in Wave 3 — can call it directly, as a
 * sibling module, without `packages/runtime` gaining a dependency (it declares none; see
 * `driver.ts`'s header). {@link sessionWorkspacePaths} is §25's *"Each workspace and session
 * must get a distinct directory"*, expressed as a pure path computation any driver can use when
 * it allocates a `RuntimeConfig.workspacePath` per session rather than per workspace.
 *
 * ## Why this file does not derive `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` from anything
 *
 * A.11 requires both, unconditionally. Neither can be *sourced* by this package today: the
 * model gateway that mints a run-scoped token is §26's, and §26 — like A.11's own declared gap
 * in the Wave 3 plan's "Declared gaps" item 3 — is Wave 4
 * (`docs/adr/0021-phase-0-credential-step-belongs-to-wave-4.md`). So this function takes both as
 * caller-supplied strings rather than resolving them, which is the same shape §14.2's
 * `RuntimeConfig` already uses for `runtimeProfileId` — a reference the caller resolved, not a
 * thing this package reaches out and fetches. `packages/core/src/config.ts` (this task's other
 * half) documents the matching gap on the production path: `RunRequest` carries no gateway field
 * yet, so `compileRunRequest` cannot derive these two either, today.
 *
 * ## What this file refuses, and why that is not the same list as what it emits
 *
 * A.11's own sentence — *"Provider master credentials never enter a sandbox"* — is checked
 * **inside** {@link buildRuntimeEnvironment}, not left to a caller's discipline: an agent secret
 * literally named `ANTHROPIC_API_KEY`, or one that collides with any reserved A.11 name, is
 * rejected rather than silently overwriting the contract. That is ADR-0015's shape applied here —
 * the function ends in an explicit check that rejects, not a hope that no caller ever passes one.
 */

/** A.11's `networkPolicy` vocabulary, spec §15.1's three values. */
type EnvNetworkPolicy = 'none' | 'restricted' | 'open';

/** Secrets already resolved for this agent (§23) — name to plaintext value, nothing else. */
type AgentSecrets = Readonly<Record<string, string>>;

/**
 * What {@link buildRuntimeEnvironment} needs. Every field here is something the caller already
 * knows or has already resolved; this function only decides which A.11 keys to emit and what
 * value each carries, never how to obtain one.
 */
export type RuntimeEnvironmentInput = {
  /** A.11's `ANTHROPIC_BASE_URL` — "the internal gateway URL". */
  readonly gatewayBaseUrl: string;
  /** A.11's `ANTHROPIC_AUTH_TOKEN` — "short-lived token scoped to this run". Never a provider key. */
  readonly authToken: string;
  /** A.11's `CLAUDE_CONFIG_DIR` — "a per-session directory inside the sandbox" (§25). */
  readonly configDir: string;
  /** A.11's `AGENT_WORKSPACE_RUN_ID`. */
  readonly runId: string;
  /** A.11's `AGENT_WORKSPACE_SESSION_ID`. */
  readonly sessionId: string;
  /**
   * Which Node major version the sandbox's `fetch` runs under. Defaults to this process's own
   * (`process.versions.node`) so a real driver need not pass it, and is a parameter at all so a
   * test can drive both sides of A.11's `"1 on Node 24+"` without needing two Node installs.
   */
  readonly nodeMajorVersion?: number;
  /** §15.1's `networkPolicy`. Gates `HTTP_PROXY` / `HTTPS_PROXY` together with `proxyUrl`. */
  readonly networkPolicy: EnvNetworkPolicy;
  /**
   * Set only when `networkPolicy` is `'restricted'` or `'open'` **and** the driver routes that
   * policy through the egress proxy (ADR-0117 decision 8: `open` is the public internet *through*
   * the proxy). A `proxyUrl` supplied for `'none'` is deliberately ignored: the condition is the
   * policy, not the presence of a URL.
   */
  readonly proxyUrl?: string;
  /** A.11's optional collector. Absent means no `OTEL_EXPORTER_OTLP_ENDPOINT` at all. */
  readonly otelExporterOtlpEndpoint?: string;
  /** §23: "only the secrets assigned to this agent." Never a wider set, never a narrower one. */
  readonly secrets?: AgentSecrets;
};

/**
 * The five unconditional A.11 keys — the ones this task's plan cell names as the floor every
 * emitted environment must equal exactly when no optional condition holds.
 *
 * Declared here as a checkable value (not only as inline object keys below) so
 * `env.test.ts` can import it and never has to retype the set it asserts against — the set is
 * still independently **derived from `docs/spec.md`** by that test's own parser; this constant is
 * the implementation's answer, compared against that derivation, not a substitute for it.
 */
export const A11_UNCONDITIONAL_ENV_VARS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'AGENT_WORKSPACE_RUN_ID',
  'AGENT_WORKSPACE_SESSION_ID',
] as const;

/** The four conditional A.11 keys, across all three optional conditions. */
export const A11_CONDITIONAL_ENV_VARS = [
  'NODE_USE_ENV_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
] as const;

/** Every name {@link buildRuntimeEnvironment} may ever emit outside of agent secrets. */
const RESERVED_ENV_VARS: readonly string[] = [
  ...A11_UNCONDITIONAL_ENV_VARS,
  ...A11_CONDITIONAL_ENV_VARS,
];

/** A.11's own forbidden entry — never a key this function emits, under any input. */
const PROVIDER_MASTER_CREDENTIAL_ENV = 'ANTHROPIC_API_KEY';

/**
 * The two suffixes that make a variable name credential-shaped (ENG-04's generalised A.11).
 *
 * A restatement of `packages/engine/src/sandbox-env.ts`'s `CREDENTIAL_ENV_SUFFIXES`: this
 * package depends on no workspace package, and the rule is two strings. `env.test.ts` reads that
 * file and holds the two equal, which is the ADR W2-CP-07 rule for a restatement across a
 * package boundary.
 */
export const CREDENTIAL_SECRET_NAME_SUFFIXES = ['_API_KEY', '_AUTH_TOKEN'] as const;

/** Environment names are case-insensitive when Node creates a Windows subprocess. */
function canonicalEnvironmentName(name: string): string {
  return name.toUpperCase();
}

const RESERVED_ENV_VAR_NAMES = new Set(RESERVED_ENV_VARS.map(canonicalEnvironmentName));
const PROVIDER_MASTER_CREDENTIAL_NAME = canonicalEnvironmentName(PROVIDER_MASTER_CREDENTIAL_ENV);

/** Name a value in a rejection message without stringifying something huge or cyclic. */
function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  return `a value of type ${typeof value}`;
}

/** ADR-0015 rule 1: parse before comparing. Rejects by name; never coerces. */
function requireNonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `buildRuntimeEnvironment: ${what} must be a non-empty string; got ${describe(value)}.`,
    );
  }
  return value;
}

/**
 * This process's own Node major version, parsed from `process.versions.node` rather than
 * `process.version` (both carry the same number; `versions.node` has no leading `v` to strip).
 *
 * `Number.parseInt` rather than `.split('.')`: the latter's `'.'` argument is, read purely as a
 * string, a relative module specifier that resolves to this package's own `index.ts` — which
 * `tests/no-sdk-import.test.ts`'s §42 boundary gate cannot tell apart from a disguised dynamic
 * loader when the call is rooted at the unbound global `process` (ADR-0031: undecidable is
 * refused, not passed over). `parseInt` stops at the first non-digit character, so it needs no
 * split at all, and its arguments are never string literals a module resolver could act on.
 */
function currentNodeMajorVersion(): number {
  const parsed = Number.parseInt(process.versions.node, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(
      `buildRuntimeEnvironment: could not parse a Node major version out of process.versions.node ${JSON.stringify(process.versions.node)}.`,
    );
  }
  return parsed;
}

/**
 * The A.11 injector. Every driver's environment for a run is this function's return value, and
 * nothing else — a driver that adds a variable of its own outside this function has stopped
 * being interchangeable with the others, which is the whole property A.11 exists to keep.
 *
 * The **emitted key set** is the contract: exactly {@link A11_UNCONDITIONAL_ENV_VARS}, plus each
 * of {@link A11_CONDITIONAL_ENV_VARS} exactly when its own stated condition holds, plus the
 * caller's agent secrets, and never `ANTHROPIC_API_KEY` under any circumstance. An agent secret is
 * never emitted under a credential-shaped name (`*_API_KEY` / `*_AUTH_TOKEN`, see
 * {@link CREDENTIAL_SECRET_NAME_SUFFIXES}): every engine adapter refuses to compile an environment
 * in which such a variable holds anything but the run's own gateway token
 * (`sandboxEnvironmentVerdict`, ENG-04), so emitting one would only move the refusal from here,
 * with a sentence about the secret, to the engine, with a sentence about model connections.
 *
 * Throws — never returns a partial or best-effort environment — when an input is malformed, when
 * a secret's name collides with a reserved A.11 key, when a secret is literally the forbidden
 * provider credential, or when a secret's name is credential-shaped. ADR-0015: a check that cannot run must fail, not fall through.
 */
export function buildRuntimeEnvironment(input: RuntimeEnvironmentInput): Record<string, string> {
  const gatewayBaseUrl = requireNonEmptyString(input.gatewayBaseUrl, 'gatewayBaseUrl');
  const authToken = requireNonEmptyString(input.authToken, 'authToken');
  const configDir = requireNonEmptyString(input.configDir, 'configDir');
  const runId = requireNonEmptyString(input.runId, 'runId');
  const sessionId = requireNonEmptyString(input.sessionId, 'sessionId');

  // ADR-0015: a positive assertion, not the absence of a negative. The three values this type
  // permits are checked by name; anything else is refused rather than treated as "probably open".
  if (
    input.networkPolicy !== 'none' &&
    input.networkPolicy !== 'restricted' &&
    input.networkPolicy !== 'open'
  ) {
    throw new Error(
      `buildRuntimeEnvironment: networkPolicy must be 'none' | 'restricted' | 'open'; got ${describe(input.networkPolicy)}.`,
    );
  }

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: gatewayBaseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    CLAUDE_CONFIG_DIR: configDir,
    AGENT_WORKSPACE_RUN_ID: runId,
    AGENT_WORKSPACE_SESSION_ID: sessionId,
  };

  // A.11: "`1` on Node 24+, since `fetch` ignores proxy variables otherwise."
  const nodeMajorVersion = input.nodeMajorVersion ?? currentNodeMajorVersion();
  if (nodeMajorVersion >= 24) {
    env['NODE_USE_ENV_PROXY'] = '1';
  }

  // A.11: set only when the profile's traffic goes through a proxy — the condition is the policy
  // *and* a configured proxy, never a proxy URL alone (which `'none'` must ignore) and never the
  // policy alone (which without a proxy has nothing to route through). ADR-0117 decision 8 puts
  // `'open'` behind the proxy as well, so it is not exempt.
  if (
    input.networkPolicy !== 'none' &&
    typeof input.proxyUrl === 'string' &&
    input.proxyUrl.length > 0
  ) {
    env['HTTP_PROXY'] = input.proxyUrl;
    env['HTTPS_PROXY'] = input.proxyUrl;
  }

  if (
    typeof input.otelExporterOtlpEndpoint === 'string' &&
    input.otelExporterOtlpEndpoint.length > 0
  ) {
    env['OTEL_EXPORTER_OTLP_ENDPOINT'] = input.otelExporterOtlpEndpoint;
  }

  // §23: "The runtime receives only the secrets required by that particular agent." — spread
  // last, and checked one at a time, so a secret can never silently overwrite an A.11 key nor
  // smuggle in the one credential A.11 forbids outright.
  const secretNames = new Set<string>();
  for (const [name, value] of Object.entries(input.secrets ?? {})) {
    if (name.length === 0) {
      throw new Error('buildRuntimeEnvironment: an agent secret name must not be empty.');
    }
    const canonicalName = canonicalEnvironmentName(name);
    if (canonicalName === PROVIDER_MASTER_CREDENTIAL_NAME) {
      throw new Error(
        `buildRuntimeEnvironment: refusing to emit ${JSON.stringify(name)} as an agent secret because environment names are case-insensitive on Windows and it is ${PROVIDER_MASTER_CREDENTIAL_ENV}. Spec A.11: "Provider master credentials never enter a sandbox."`,
      );
    }
    if (RESERVED_ENV_VAR_NAMES.has(canonicalName)) {
      throw new Error(
        `buildRuntimeEnvironment: agent secret ${JSON.stringify(name)} collides with a reserved A.11 variable name; refusing rather than letting one silently overwrite the other.`,
      );
    }
    if (CREDENTIAL_SECRET_NAME_SUFFIXES.some((suffix) => canonicalName.endsWith(suffix))) {
      throw new Error(
        `buildRuntimeEnvironment: agent secret ${JSON.stringify(name)} is spelled like a credential (${CREDENTIAL_SECRET_NAME_SUFFIXES.join(' / ')}). Spec A.11 as ENG-04 generalised it allows such a variable in a sandbox only when it holds the run's own gateway token, so every engine would refuse this run; store the secret under a name without those suffixes.`,
      );
    }
    if (secretNames.has(canonicalName)) {
      throw new Error(
        `buildRuntimeEnvironment: duplicate agent secret name ${JSON.stringify(name)} under Windows case-insensitive environment semantics.`,
      );
    }
    secretNames.add(canonicalName);
    // Assignment to `__proto__` invokes Object.prototype's legacy setter instead of creating an
    // environment entry. Define an enumerable data property so every accepted secret survives
    // unchanged without mutating the result object's prototype.
    Object.defineProperty(env, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  // The explicit `else` that rejects (ADR-0015), kept even though every path above already
  // refuses this name: the one thing this function must never do, regardless of how a future
  // edit reaches this line, is return a record carrying the provider master credential.
  if (
    Object.keys(env).some(
      (name) => canonicalEnvironmentName(name) === PROVIDER_MASTER_CREDENTIAL_NAME,
    )
  ) {
    throw new Error(
      `buildRuntimeEnvironment: refusing to emit ${PROVIDER_MASTER_CREDENTIAL_ENV} under any circumstance (spec A.11).`,
    );
  }

  return env;
}

// ── §25: a distinct cwd and CLAUDE_CONFIG_DIR per session ──────────────────────────────────

/**
 * A session id is safe to use as a single path segment when it is exactly this: letters, digits,
 * `_` and `-`, starting with a letter or digit. That excludes `.`, `/`, `\` and every other
 * character a path-traversal or absolute-path attempt needs, so there is no separate "reject
 * `..`" rule to keep in sync with this one — anything that is not this shape is refused.
 */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type SessionWorkspacePaths = {
  /** §25: a distinct `cwd` per session, nested under the workspace's own root. */
  readonly cwd: string;
  /** §25 / A.11's `CLAUDE_CONFIG_DIR`: a distinct per-session directory inside that `cwd`. */
  readonly configDir: string;
};

/**
 * Compute a distinct `cwd` and engine configuration directory for one session under one workspace
 * root.
 *
 * §25: *"Each workspace and session must get a distinct directory."* A workspace's own root
 * (`workspaceRoot`) is shared across the sessions that run against it — multiple sessions
 * against one agent's workspace is the ordinary case — so the distinctness this function adds is
 * per-**session**, nested one level under the workspace: two calls with the same
 * `workspaceRoot` and different `sessionId`s can never return equal `cwd`s or equal `configDir`s,
 * because they differ in exactly the path segment this function's own safety check controls.
 *
 * `protectedConfigDirectory` is the engine's own answer — `AgentEngine.protectedConfigDirectory`,
 * `.claude` for the Claude Agent SDK — and it is a **required** parameter (ENG-04b, #325). This
 * package may not import an engine adapter and has no way to look one up, so a default here would be
 * this package deciding one engine's directory layout on every adapter's behalf; a caller that knows
 * which engine a run is for is the only code that can answer, so it is asked.
 *
 * A positive assertion, not the absence of a negative (ADR-0015): `sessionId` is checked against
 * an allow-list shape and refused by name otherwise, rather than checked for the specific
 * characters a path-traversal attempt happens to use. `protectedConfigDirectory` gets the same
 * treatment for the same reason: it becomes a path segment.
 */
export function sessionWorkspacePaths(
  workspaceRoot: string,
  sessionId: string,
  protectedConfigDirectory: string,
): SessionWorkspacePaths {
  const root = requireNonEmptyString(workspaceRoot, 'workspaceRoot');
  if (typeof sessionId !== 'string' || !SAFE_PATH_SEGMENT.test(sessionId)) {
    throw new Error(
      `sessionWorkspacePaths: sessionId ${describe(sessionId)} is not safe to use as a directory name (must match ${String(SAFE_PATH_SEGMENT)}); refusing to allocate a session workspace under an unvalidated name (spec §25).`,
    );
  }
  const configDirectory = requireNonEmptyString(
    protectedConfigDirectory,
    'protectedConfigDirectory',
  );
  if (configDirectory.includes('/') || configDirectory.includes('\\') || configDirectory === '..') {
    throw new Error(
      `sessionWorkspacePaths: protectedConfigDirectory ${describe(protectedConfigDirectory)} is not a single path segment; refusing to nest a session's engine configuration under an unvalidated name (spec §25).`,
    );
  }
  const trimmedRoot = root.replace(/[\\/]+$/, '');
  const cwd = `${trimmedRoot}/${sessionId}`;
  return { cwd, configDir: `${cwd}/${configDirectory}` };
}
