/**
 * `@agent-workspace/engine` — the **engine port** (ENG-04, #303).
 *
 * An *engine* is the harness that turns an agent definition and a prompt into model calls, tool
 * calls and a stream of events. ENG-02 gave engines an identity in the contracts; ENG-03 gave
 * their messages one neutral `agent.*` vocabulary. This module is the third half of that: the
 * interface an adapter implements so that **adding an engine means adding a package, not editing
 * the runner**.
 *
 * ## What this package may depend on, and why that is the whole design
 *
 * `@indx-workspace/contracts`, and nothing else — not even zod. The port is the place a runner
 * and an adapter meet, so anything it imported would become something *every* adapter has to
 * carry — which is how a port turns back into a framework. It needs no validator because it is
 * types and pure functions: the trust-boundary parse belongs to the adapter that owns the policy
 * arm it is parsing. `dependency-cruiser.config.mjs` states the rule
 * as `engine-port-depends-only-on-contracts` rather than leaving it to review.
 *
 * ## The three things an adapter is asked for, and the one it is not
 *
 *   1. **{@link AgentEngine.compile}** — a pure function from the neutral {@link EngineRunRequest}
 *      to whatever this engine's own SDK wants. It is separated from `start` on purpose: compiling
 *      is the half a test can check exhaustively without a credential, a network or a subprocess,
 *      and the T4 refinement theorem of this unit is a statement about `compile` alone.
 *   2. **{@link AgentEngine.start}** — one run, as an {@link EngineConnection}.
 *   3. **{@link AgentEngine.capabilities}** and {@link AgentEngine.protectedConfigDirectory} — what
 *      the adapter declares about itself, so the control plane can refuse a request this engine
 *      cannot honour *before* a run starts rather than narrowing it silently.
 *
 * There is deliberately no fourth: no agent loop, no planner, no tool executor, no conversation
 * engine (spec §53). An adapter translates and delegates; the engine it wraps does the rest.
 *
 * ## Why `compile` returns a verdict instead of throwing
 *
 * Every refusal this port can produce is a *typed* one with a stable code
 * ({@link EngineRefusalCode}), because the runner turns it into a `run-error` frame the control
 * plane records and a person reads. A thrown `Error` carries a sentence and no code, so the
 * runner would have to decide what kind of failure it was by looking at its message — which is
 * the shape ADR-0015 exists to refuse. `start` may still throw for a programming fault; that is a
 * 5xx, and it is not the same thing as "this engine will not run this request".
 */
import type { AgentPermissions, AgentSkillPolicy } from '@indx-workspace/contracts/agents';
import type { EngineCapabilities } from '@indx-workspace/contracts/engines';

import type { EngineFrame } from './frames.js';

/**
 * How this run relates to an engine session.
 *
 * `mode` is the platform's question and `engineSessionId` is the engine's answer to a previous
 * one: the platform never invents an engine session id, it only ever hands back one an
 * `agent.session` frame reported. `fresh` carries none, and the two continuing modes require one
 * — which is why this is a discriminated union rather than a mode beside an optional field that
 * a caller could leave unset.
 */
export type EngineSessionSelector =
  | { readonly mode: 'fresh' }
  | { readonly mode: 'resume'; readonly engineSessionId: string }
  | { readonly mode: 'fork'; readonly engineSessionId: string };

/**
 * The model connection an engine reaches, handed to the adapter **programmatically**.
 *
 * Spec A.11's *"provider master credentials never enter a sandbox"* generalised past Claude: the
 * platform hands every adapter a gateway base URL, a short-lived run token and the wire protocol
 * the gateway serves this run's provider over, and the adapter decides how its engine is told
 * about them. Most engines take a parameter. The Claude Agent SDK's bundled CLI reads
 * `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` out of its environment, so the Claude adapter —
 * and only the Claude adapter — translates this back into two environment entries.
 *
 * `token` is the run token, never a provider credential. `packages/engine/src/sandbox-env.ts`'s
 * {@link sandboxEnvironmentVerdict} is what turns that sentence into a check.
 */
export type EngineGatewayConnection = {
  /** The gateway's base URL, without a trailing slash. */
  readonly baseUrl: string;
  /** The short-lived, run-scoped bearer. Bound to workspace/run/session; no provider secret. */
  readonly token: string;
  /** Which dialect the gateway serves this run's model connection over. */
  readonly protocol: string;
};

/** One file the platform materialised into the sandbox, as the adapter is told about it. */
export type EngineFileGrant = {
  readonly kind: 'file' | 'directory';
  /** Workspace-relative, already normalised. See `./path-grant.ts` for what that guarantees. */
  readonly path: string;
  readonly access: 'read' | 'read-write';
};

/**
 * One skill, handed to the adapter as bytes rather than as a location.
 *
 * ENG-04's "skills and resources materialisation" item: the *runner* writes files (that is
 * engine-neutral and needs a filesystem), but **where** a skill goes is the engine's business —
 * the Claude Agent SDK reads `${CLAUDE_CONFIG_DIR}/skills/<name>/`, and the next engine will not.
 * So the port hands over `{ name, files }` and the adapter says where they land.
 */
export type EngineSkillGrant = {
  readonly name: string;
  readonly files: readonly { readonly path: string; readonly contentBase64: string }[];
};

export type EngineResources = {
  readonly files: readonly EngineFileGrant[];
  readonly skills: readonly EngineSkillGrant[];
};

/**
 * One file of one skill, at the path **this engine** reads it from (ENG-04b, #325).
 *
 * The answer to the half of {@link EngineSkillGrant} the port could not state: the runner holds
 * the filesystem and the safe-write machinery (symlink refusal, read-only modes, a manifest that
 * removes what a revoked assignment left behind), and the adapter holds the knowledge of where its
 * engine looks. So the runner asks {@link AgentEngine.placeSkills} and writes what comes back.
 *
 * `path` is relative to the run's `cwd` and must normalise **inside**
 * {@link AgentEngine.protectedConfigDirectory} — that is the whole safety property, it is checked
 * by `skillPlacementVerdict` before a byte is written, and the conformance kit fails an adapter
 * that breaks it.
 */
export type EngineSkillFile = {
  /** Which {@link EngineSkillGrant} this file came from. Carried so a refusal can name it. */
  readonly skill: string;
  /** Workspace-relative, under the engine's own configuration directory. */
  readonly path: string;
  readonly contentBase64: string;
};

/** One subagent of this run (ADR-0133 D14): delegated to by name, inside the parent's run. */
export type EngineSubagent = {
  readonly name: string;
  /** Required: the parent's model reads it to decide when to delegate. */
  readonly description: string;
  readonly instructions: string;
  /** `null`: the parent run's model. */
  readonly model: string | null;
  /** Already intersected with the parent's permissions; an adapter may only narrow further. */
  readonly permissions: AgentPermissions;
};

/**
 * The portable core of one run's agent configuration: what **every** engine must honour.
 *
 * #299's "portable core vs engine-native" table, as a type. Everything here is the platform's own
 * vocabulary — four permission booleans, a skill surface, connectors, limits, instructions — and an
 * adapter's job is to express it in its engine's terms. Nothing here names a tool, because tool
 * names are the first thing two engines disagree about; the permission switches are the portable
 * statement and {@link EngineRunRequest.policy} is where an engine's own grammar lives.
 *
 * `mcpServers` is `unknown` per entry on purpose. MCP is a third-party wire protocol with its own
 * schema, and a copy of it here would be a copy this package has to keep current for every adapter
 * — while the *record keys* are what the port actually has to promise, because they are what an
 * engine's tool names are derived from. The adapter validates the values it is about to hand its
 * own SDK.
 */
export type EnginePortableConfig = {
  readonly name: string;
  readonly instructions: string;
  /** `null` means "whatever the engine's own default model is". */
  readonly model: string | null;
  /** §17 Step 4's four switches. The portable statement of what this agent may do. */
  readonly permissions: AgentPermissions;
  readonly skills: AgentSkillPolicy;
  /** The connectors assigned to this run, by the record key their tool names are built from. */
  readonly mcpServers: Readonly<Record<string, unknown>>;
  readonly limits: {
    /** `null` means the engine's own default, not "unlimited". */
    readonly maxTurns: number | null;
    /** `null` means no per-run cap. */
    readonly maxBudgetUsd: number | null;
  };
  /** Absent or empty: no subagents. An engine whose `capabilities.subagents` is false refuses a non-empty list. */
  readonly subagents?: readonly EngineSubagent[] | undefined;
};

/**
 * One run, as the **port** sees it: engine-neutral except for `policy`.
 *
 * `policy` is typed `unknown` and not `Record<string, unknown>` for the reason the architecture
 * document gives about every other trust boundary: the engine arm arrives from a database column
 * through an HTTP body, so it is not a shape until an adapter has parsed it. The adapter owns
 * that parse — it is the only code that knows what its own engine's policy means — and a policy
 * it refuses is an {@link EngineRefusal}, not a throw.
 */
export type EngineRunRequest = {
  /** The platform's own run id (`runs.id`), for correlation. */
  readonly runId: string;
  /** `sessions.id`. The engine-side identity is in {@link EngineSessionSelector}. */
  readonly sessionId: string;
  /**
   * The tenant namespace this run's session state is keyed under.
   *
   * The platform's value, not the engine's: {@link EngineSessionKey} is keyed by it, and §25
   * requires that two tenants on one workspace path can never share one. An adapter may derive its
   * engine's own spelling from it; it may not invent one.
   */
  readonly projectKey: string;
  /** The sandbox workspace root the engine works in. */
  readonly cwd: string;
  readonly prompt: string;
  /** Which engine this request is addressed to. The registry has already matched it. */
  readonly engine: string;
  /** What every engine must honour. See {@link EnginePortableConfig}. */
  readonly portable: EnginePortableConfig;
  /** The engine-native policy arm. `unknown` until this engine's adapter parses it. */
  readonly policy: unknown;
  readonly session: EngineSessionSelector;
  /**
   * The model connection, handed over programmatically — or `null` when the request did not
   * carry one.
   *
   * `null` is the pre-ENG-04 private-contract body, whose model credential is still two entries
   * in `env` named after the Claude CLI. It is spelled as an explicit arm rather than left
   * optional so that an adapter has to *decide* what to do about it. Every adapter refuses it,
   * the Claude adapter included: an engine that cannot find a credential must not start a run that
   * will fail at the first model call, and without the connection's token the environment's own
   * credential could not be checked against anything.
   */
  readonly gateway: EngineGatewayConnection | null;
  readonly resources: EngineResources;
  /** The complete subprocess environment, minus anything the adapter derives for itself. */
  readonly env: Readonly<Record<string, string>>;
};

/**
 * A durable store of one session's engine state, as the port declares it.
 *
 * ENG-04 declared this interface and ENG-06 (#305) implements it, over one platform-owned,
 * engine-scoped store reached with the per-run token. `key` is opaque to the platform: an engine
 * keys its state however it likes, and the platform's job is to store and return the bytes
 * unchanged.
 *
 * ## Why there are more members than the Agent SDK has
 *
 * `append` / `load` / `listSessions` / `listSessionSummaries` / `delete` / `listSubkeys` are the
 * Agent SDK's `SessionStore`, restated. The three below it are the operations the *other* engines
 * this platform has researched need and Claude does not: the OpenAI Agents SDK's `popItem` is
 * {@link deleteLast}, its `clearSession`-then-rewrite is {@link replaceAll}, and an ACP agent's own
 * state directory is a {@link putBlob} snapshot. They are declared here rather than in whichever
 * adapter needs one first, because a store that is *platform*-owned has to offer every operation an
 * engine could need or each adapter builds its own durable store beside it.
 *
 * Every member but `append` and `load` is optional, and that is a statement about the store rather
 * than about the engine: a store which cannot delete says so by not having the method, and an
 * adapter that needs one refuses the run instead of silently continuing without durability.
 */
export type EngineSessionStore = {
  append(key: EngineSessionKey, entries: readonly EngineTranscriptEntry[]): Promise<void>;
  load(key: EngineSessionKey): Promise<readonly EngineTranscriptEntry[] | null>;
  /**
   * The four SDK-shaped optional members, optional here because they are optional in the one
   * engine SDK that has this concept today.
   *
   * They are declared rather than left off for a reason that is easy to get wrong: an adapter
   * bridges this interface to its engine's own, and a bridge that forwarded only `append` and
   * `load` would **silently drop** the rest — the engine would stop being able to enumerate or
   * delete a transcript, and nothing would say so. Naming them here is what makes forwarding
   * them the obvious thing to write and their absence a visible decision.
   */
  listSessions?(projectKey: string): Promise<readonly { sessionId: string; mtime: number }[]>;
  listSessionSummaries?(
    projectKey: string,
  ): Promise<readonly { sessionId: string; mtime: number; data: Record<string, unknown> }[]>;
  delete?(key: EngineSessionKey): Promise<void>;
  listSubkeys?(key: { projectKey: string; sessionId: string }): Promise<readonly string[]>;
  /**
   * Remove the last entry of one stream.
   *
   * The OpenAI Agents SDK's `Session.popItem()`, which its own guide describes as undoing the last
   * turn. Idempotent, and it answers nothing: popping from an empty stream leaves an empty stream,
   * and a caller that needs to know what was there reads the stream — a boolean saying "there was
   * one" is a fact about a moment that has already passed.
   */
  deleteLast?(key: EngineSessionKey): Promise<void>;
  /**
   * Replace a stream's contents with exactly these entries.
   *
   * The OpenAI Agents SDK's `clearSession()` followed by a rewrite, as **one** operation: two calls
   * would leave a window in which the session has no history at all, and a resume landing in that
   * window would start a fresh conversation without anything saying so.
   */
  replaceAll?(key: EngineSessionKey, entries: readonly EngineTranscriptEntry[]): Promise<void>;
  /**
   * Store an opaque snapshot under `blobKey`, replacing whatever was there.
   *
   * For an engine whose state is files inside the sandbox — an ACP agent replays its own state
   * directory on `session/load` — the entry list is the wrong shape and a tar of the directory is
   * the right one. Rejects when the bytes exceed the store's cap; see
   * {@link SESSION_STATE_BLOB_MAX_BYTES}.
   */
  putBlob?(key: EngineSessionKey, blobKey: string, bytes: Uint8Array): Promise<void>;
  /** The snapshot at `blobKey`, or `null` when there is none. */
  getBlob?(key: EngineSessionKey, blobKey: string): Promise<Uint8Array | null>;
  /**
   * Every write this store could not complete, in the order it gave up on them.
   *
   * The reason the durability verdict does not have to be engine-specific. Before ENG-06 the only
   * evidence that a transcript batch had been lost was the Agent SDK's own `system/mirror_error`
   * event, so `sessionDurability()` could only be honest for Claude. A store that records its own
   * failures gives every adapter the same evidence, and
   * {@link withStoreWriteFailures} is what folds it into the verdict.
   */
  writeFailures?(): readonly string[];
};

/** Where one transcript lives, in the engine's own terms. */
export type EngineSessionKey = {
  /** The tenant namespace. Never a value derived from a path the tenant controls. */
  readonly projectKey: string;
  readonly sessionId: string;
  /** Absent for the main transcript; set for a sub-agent's. Opaque — use it as a key suffix. */
  readonly subpath?: string | undefined;
};

/** One transcript line as a mirror observes it. Stored verbatim; the platform reads no field. */
export type EngineTranscriptEntry = {
  readonly type: string;
  readonly [field: string]: unknown;
};

/**
 * Whether this run's conversation survives the sandbox (spec §14.9, §20).
 *
 * Moved here from `apps/runner/src/claude.ts`, unchanged in meaning: the `false` arm **always**
 * carries a sentence, and `true` is only ever returned because a scenario passed — a store was
 * configured, its writes were observed to resolve, none was dropped and the stream reached a
 * terminal message. There is no "probably fine" arm, because §14.9 calls a session that lives only
 * inside the sandbox a release blocker and the platform has to be able to say which runs it may
 * offer a resume for (ADR-0015).
 */
export type SessionDurabilityVerdict =
  | { readonly durable: true; readonly mirroredBatches: number }
  | { readonly durable: false; readonly reason: string };

/**
 * Why an engine refused a request, as a code the control plane can branch on.
 *
 * Every one of these is a *request* problem, which is why the runner answers them inside an
 * established stream as a `run-error` frame rather than as a status code: by the time a run
 * request has been matched to an engine the response is already a 200 SSE stream
 * (the R-13 research note finding 7).
 */
export const ENGINE_REFUSAL_CODES = [
  /** No adapter for `request.engine` is installed in this runtime image. */
  'engine_not_installed',
  /** The engine arm of the policy is not a policy this engine can read. */
  'engine_policy_invalid',
  /** The request asks for something {@link AgentEngine.capabilities} says this engine cannot do. */
  'engine_capability_unsupported',
  /** The sandbox environment would carry a provider credential. Spec A.11. */
  'engine_credential_refused',
  /** A grant would let the engine write outside what the platform granted. */
  'engine_path_grant_refused',
] as const;
export type EngineRefusalCode = (typeof ENGINE_REFUSAL_CODES)[number];

/** A refusal, with the code a machine reads and the sentence a person acts on. */
export type EngineRefusal = {
  readonly ok: false;
  readonly code: EngineRefusalCode;
  readonly reason: string;
};

/** {@link AgentEngine.compile}'s answer: the engine's own options, or a typed refusal. */
export type EngineCompileResult<TCompiled> =
  { readonly ok: true; readonly compiled: TCompiled } | EngineRefusal;

/** What the runner supplies around one run. Nothing here comes from a tenant. */
export type EngineStartContext = {
  /** Spec §20's durable mirror. Absent means the transcript lives only inside the sandbox. */
  readonly sessionStore?: EngineSessionStore | undefined;
  /** Spec §14.3's `POST /interrupt`, and the only cancellation this port offers. */
  readonly abortController?: AbortController | undefined;
};

/**
 * One in-flight run.
 *
 * The only thing that crosses this boundary is {@link EngineFrame} — the closed `agent.*`
 * vocabulary of `@indx-workspace/contracts`, with `engine` widened for the reason that type's
 * own doc comment gives. That is the ENG-03 claim held by a type: a runner streaming this
 * connection cannot accidentally put an engine-native event name on the wire, because it never
 * receives one.
 */
export type EngineConnection = {
  /** The neutral frames of this run, in the order the engine produced them. */
  readonly frames: AsyncIterable<EngineFrame>;
  /**
   * The engine's own session id **as the run reported it**, not as the request asked for it.
   *
   * Rejects when the stream ends without one. There is no third outcome: a session id invented
   * from the request would be the identity a later resume is keyed by, asserted because nothing
   * contradicted it.
   */
  readonly engineSessionId: Promise<string>;
  /** Raise the cancellation signal. Resolving does not mean the engine has stopped. */
  interrupt(): Promise<void>;
  /** See {@link SessionDurabilityVerdict}. Meaningful once `frames` has been exhausted. */
  sessionDurability(): SessionDurabilityVerdict;
};

/**
 * One engine, behind the port.
 *
 * `TCompiled` is the adapter's own options type. It is a type parameter rather than `unknown` so
 * that an adapter's tests — and this package's conformance kit — can read what a compile
 * produced without a cast, while the runner, which never looks inside it, can hold an
 * `AgentEngine<unknown>`.
 */
export type AgentEngine<TCompiled = unknown> = {
  /** The {@link EngineRunRequest.engine} value this adapter answers to. */
  readonly id: string;
  /** The adapter's own version string. Opaque to the platform; reported, never compared. */
  readonly version: string;
  /** What this engine can honour of the platform's portable configuration (ENG-02). */
  readonly capabilities: EngineCapabilities;
  /**
   * The directory, relative to `cwd`, this engine keeps its own configuration in — and which the
   * platform therefore refuses to materialise a tenant file into.
   *
   * `.claude` for the Claude Agent SDK. Declared by the adapter rather than hard-coded in the
   * runner, because the rule is "do not let a tenant write into the engine's own config
   * directory" and only the engine knows which directory that is.
   */
  readonly protectedConfigDirectory: string;
  /**
   * Where this engine's skills go: one entry per file of every {@link EngineSkillGrant}, at a
   * path relative to the run's `cwd`.
   *
   * Pure, and it writes nothing. The division is deliberate and is ENG-04b's answer to *"the
   * runner still writes the files, engine-neutrally, but hands skills to the adapter"*: writing
   * safely into a sandbox is a filesystem problem the runner has already solved once (symlink
   * refusal, read-only modes, removing what a revoked assignment left behind), and **where** a
   * skill goes is the only part of it that differs per engine. So the adapter answers the
   * engine-specific question and the runner does the engine-neutral work.
   *
   * Every path returned must normalise inside {@link protectedConfigDirectory}. `skillPlacementVerdict`
   * checks it before anything is written, and the conformance kit fails an adapter that does not.
   */
  placeSkills(request: EngineRunRequest): readonly EngineSkillFile[];
  /** Pure. See the header for why this is separate from {@link start}. */
  compile(request: EngineRunRequest): EngineCompileResult<TCompiled>;
  /**
   * Start one run. Throws only for a programming fault; a request this engine will not run is a
   * {@link EngineRefusal} from {@link compile}, and the runner calls `compile` first.
   */
  start(request: EngineRunRequest, context?: EngineStartContext): EngineConnection;
};
