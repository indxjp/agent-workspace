/**
 * `packages/runtime/src/driver.ts` — the one runtime abstraction (spec §14.1 rule 3).
 *
 * Spec §14.2 prints this contract and calls it "intentionally tiny": *"That is the whole
 * contract. If a driver needs more, the driver keeps it internal."* W3-RT-01 transcribes the
 * **whole** of §14.2 here — `RuntimeDriverId`, `RuntimeHandle`, `RuntimeDriver` (including the
 * optional `putFiles`/`getFiles` pair), and `AgentConnection` — plus §14.5's
 * `RuntimeCapabilities`. Earlier (W1-RN-02), this file transcribed only the subset its two
 * consumers needed and left `putFiles`/`getFiles` out, because the `/files` half of the §14.3
 * HTTP contract that would carry them did not exist yet. That HTTP contract lands later in Wave
 * 3 (W3-CP-07); the two methods are declared here, now, as the interface §14.2 always specified,
 * and remain optional exactly as spec text has them — a driver that can mount a volume (§15.3)
 * implements neither.
 *
 * `packages/runtime/src/types.ts` carries §15.1's `RuntimeProfile`, the type this file's
 * `RuntimeConfig` now references (see the comment on `RuntimeConfig` below).
 *
 * ## Why the two type parameters
 *
 * §14.2 writes `startAgent(runtime, request: AgentRunRequest): Promise<AgentConnection>` where
 * `AgentEvent` and `AgentRunRequest` are the platform's own run request and normalised event —
 * `RunRequest` and `ClassifiedSdkEvent`, both defined in `@agent-workspace/core`.
 *
 * This package does not import them. `packages/runtime/package.json` declares no dependencies, and
 * pnpm's isolated `node_modules` layout means `@agent-workspace/core` resolves from here at
 * neither type-check time nor run time. That is a decision, not an obstacle: the link *could* be
 * added — ADR-0017 gives a package's manifest to the task that owns it, and this one is in this
 * task's globs — but it would buy nothing while the only consumer that needs the concrete types,
 * `apps/runner`, still cannot depend on this package (its manifest belongs to another task), and
 * it would cost `packages/runtime` the dependency-free typecheck it has today. The trade and the
 * conditions under which it flips are recorded in
 * `docs/adr/W1-RN-02-runtime-driver-is-generic.md`; W1-CP-05 hit the neighbouring wall from
 * `apps/web` (`docs/adr/W1-CP-05-agents-api-has-no-core-dependency.md`).
 *
 * So the request and the event are type parameters rather than concrete imports. A driver is
 * still one abstraction, not two; the parameters are the seam where the caller — which *can*
 * import core — supplies the concrete types. `apps/runner/src/runtime.ts` is that caller.
 *
 * The same reasoning covers `putFiles`/`getFiles`: their `archive`/return-value type is
 * `ReadableStream`, a platform (WHATWG streams) global available without any dependency at all,
 * so widening the interface to include them does not reopen the §14.2-vs-`@agent-workspace/core`
 * question W1-RN-02 settled. Adding a `@agent-workspace/core` dependency to this package would be
 * a plan amendment, not a task decision — see `docs/adr/W1-RN-02-runtime-driver-is-generic.md`.
 */

/**
 * §14.2, plus one deliberate deviation. §14.4's catalogue includes `cloud-run-sandbox`, built on a
 * `gcloud run deploy --sandbox-launcher` / `/usr/local/gcp/bin/sandbox` surface that does not exist
 * in the Cloud Run Admin API or gcloud CLI (checked against gcloud SDK 581.0.0, stable/alpha/beta,
 * 2026-09): no `--sandbox-launcher` flag, no `sandbox` command group. `cloud-run-sandbox` stays in
 * this union as the spec's aspirational id — a driver may claim it once that surface ships — but it
 * has no implementation here.
 *
 * `cloud-run-service` is the real substitute: deploy one private Cloud Run **service** per session
 * (`create`/`destroy` mirror `docker`'s one-container-per-session shape) and forward the same §14.3
 * HTTP contract to it over HTTPS with a Cloud Run identity token, the same way `kubernetes` forwards
 * it to a pod. See `docs/adr/ADR-cloud-run-service-driver.md`.
 */
export type RuntimeDriverId =
  | 'local'
  | 'sandbox-runtime'
  | 'docker'
  | 'kubernetes'
  | 'gke-agent-sandbox'
  | 'aca-sessions'
  | 'aws-agentcore'
  | 'aws-ecs'
  | 'cloud-run-sandbox'
  | 'cloud-run-service'
  | 'external'
  | 'vercel-sandbox'
  | 'cloudflare-sandbox';

/**
 * §14.2's `RuntimeHandle`. Transcribed as a `type` rather than an `interface` to match
 * `packages/core/src/types.ts`, which does the same for every shape the spec prints; the fields,
 * their names and their optionality are unchanged.
 */
export type RuntimeHandle = {
  readonly id: string;
  readonly driver: RuntimeDriverId;
  /** container id, pod name, session identifier, task ARN, sandbox id */
  readonly externalId: string;
  readonly workspacePath: string;
  readonly createdAt: Date;
  readonly expiresAt?: Date;
};

/**
 * §14.5, verbatim — *"never pretend drivers are equivalent"*.
 *
 * Every field is a claim the deployment will be believed on. §14.9 turns these into the
 * plain-language warnings shown before a runtime is saved, and A.12 turns each into a
 * conformance scenario: *"A driver that cannot pass a scenario declares it unsupported in
 * `RuntimeCapabilities`; it must never pass by weakening the test."*
 */
export type RuntimeCapabilities = {
  readonly isolation: 'none' | 'os-sandbox' | 'container' | 'gvisor' | 'microvm';
  readonly customImage: boolean;
  readonly persistentFilesystem: boolean;
  readonly sessionAffinity: boolean;
  readonly maxSessionSeconds: number | null;
  readonly networkPolicies: readonly ('none' | 'allowlist' | 'open')[];
  readonly execCommands: boolean;
  readonly gpu: boolean;
  readonly managedByProvider: boolean;
  readonly typicalStartMs: number | null;
};

/**
 * The resolved, immutable runtime constraints for one launch.
 *
 * Agents persist a profile reference, while drivers need the values selected by that reference
 * at allocation time. Keeping those values in one spec prevents individual drivers from
 * silently substituting their own resource or isolation defaults after a profile was selected.
 */
export type RuntimeRunSpec = {
  readonly runtimeProfileId: string;
  readonly driver: RuntimeDriverId;
  readonly runtimeConnectionId?: string;
  readonly cpu?: number;
  readonly memoryMb?: number;
  readonly diskMb?: number;
  readonly networkPolicy: 'none' | 'restricted' | 'open';
  readonly allowedDomains?: readonly string[];
  readonly filesystem: 'read-only' | 'read-write';
  readonly persistPaths?: readonly string[];
  readonly timeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly driverConfig?: Readonly<Record<string, unknown>>;
};

/**
 * What `create()` needs. The spec names the parameter `RuntimeConfig` but does not print it, so
 * this is the smallest shape that produces a working handle: where the workspace lives, which
 * session it belongs to (§14.6 — the control plane owns `session → runtime handle`), and — as of
 * this task — which `RuntimeProfile` (§15.1, `packages/runtime/src/types.ts`) governs its
 * resources and network.
 *
 * `runtimeProfileId` is a **reference**, never an inlined `RuntimeProfile`. §14.9's reversibility
 * rule is explicit about this: *"Runtime selection therefore stores a profile reference, never a
 * copy of the profile"* — a driver that received the profile's fields by value could still work
 * today, but it would make switching an agent back to a previously-used profile depend on nobody
 * having captured a stale copy anywhere, which is exactly the failure §14.9 rules out. Resolving
 * the id to a `RuntimeProfile` — the database read — is the caller's job, not this package's: this
 * package still declares no runtime dependencies, and reading a database row is not something a
 * dependency-free type module does.
 *
 * It is optional because a `RuntimeConfig` can be constructed before a profile is ever chosen —
 * every driver ships defaults (§15.1: *"It must never be required to create a working profile"*)
 * — and because widening it to required would break every existing caller of `create()`, none of
 * which is this task's to change (see this file's header on scope).
 */
export type RuntimeConfig = {
  readonly sessionId: string;
  readonly workspacePath: string;
  /**
   * The engine this run is for (ENG-07, #306) — `runs.engine`, the id the session is pinned to.
   *
   * **Required**, unlike `runtimeProfileId`, and that is the point. A driver that takes an image
   * picks it from the `engine → image` map (`engine-images.ts`), so a `create()` that did not know
   * the engine could only start the run in whichever image the driver was constructed with — which
   * is the pre-ENG-07 behaviour, and is exactly how a `pi` run ends up inside the Claude image
   * answering `engine_not_installed` several seconds and one container later. A driver that takes
   * no image (`local`, `sandbox-runtime`) still receives it: `local` runs whatever adapters the
   * workspace has installed, and recording which engine it was asked for is what lets its
   * conformance run be about the same thing the container drivers' runs are about.
   *
   * It is a `string` and not an `EngineId` for the reason this whole file takes type parameters:
   * this package imports nothing (see the header). The caller validates it against `ENGINE_IDS`.
   */
  readonly engine: string;
  readonly runtimeProfileId?: string;
  /** Resolved values for `runtimeProfileId`; required by a driver when that id is present. */
  readonly runSpec?: RuntimeRunSpec;
};

/**
 * §14.2's `AgentConnection`, parameterised over the event type.
 *
 * `sessionId` is a promise because most drivers learn the Claude session id from the run itself
 * rather than choosing it. It must resolve because something *said* so — an event carrying the
 * id — and reject otherwise; a driver that resolves it from a value it assumed has invented the
 * identity §14.9 resumes a conversation by.
 */
export type AgentConnection<TEvent> = {
  readonly events: AsyncIterable<TEvent>;
  readonly sessionId: Promise<string>;
  interrupt(): Promise<void>;
};

/**
 * §14.2's `RuntimeDriver`, now the whole of it.
 *
 * `capabilities` is a field, not a method, for the same reason §14.5 exists: it is a static
 * property of the driver that the UI can read before anything is created, and a driver that
 * computed it per call could quietly answer differently once a run was in flight.
 *
 * `putFiles`/`getFiles` are optional, exactly as §14.2 declares them, and exist for the reason
 * §15.3 states: *"Drivers that can mount a volume do so. Drivers that cannot (`aca-sessions`,
 * `aws-agentcore`, `external`) implement `putFiles`/`getFiles` over the runtime HTTP contract
 * instead. That is the entire reason those two optional methods exist."* Their `archive`
 * parameter and return value are `ReadableStream` — a platform global, not a type this package
 * would need a dependency to name (see this file's header).
 */
export type RuntimeDriver<TRequest, TEvent> = {
  readonly id: RuntimeDriverId;
  readonly capabilities: RuntimeCapabilities;

  create(config: RuntimeConfig): Promise<RuntimeHandle>;

  startAgent(runtime: RuntimeHandle, request: TRequest): Promise<AgentConnection<TEvent>>;

  destroy(runtime: RuntimeHandle): Promise<void>;

  /** Optional. Only implemented when the driver cannot mount a volume (§15.3). */
  putFiles?(runtime: RuntimeHandle, archive: ReadableStream): Promise<void>;
  getFiles?(runtime: RuntimeHandle, paths: string[]): Promise<ReadableStream>;
};
