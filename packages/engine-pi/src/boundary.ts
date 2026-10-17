/**
 * **The** import site of the pi coding agent (ENG-08, #307; spec §42, ADR-0065 D2.3).
 *
 * The only file in the repository allowed to import `@earendil-works/pi-coding-agent` —
 * `tests/no-sdk-import.test.ts` holds the set equality. Everything decided about a run is decided
 * before this file is reached: `./compile.ts` produced a plain configuration, and this file turns
 * it into pi objects and nothing more. **pi is configured, never patched** (ADR-0081 D1):
 *
 *   * a `ModelRuntime` with in-memory credentials, no `models.json` and no catalogue refresh, whose
 *     Anthropic provider is re-pointed at the gateway and given a placeholder runtime key — the run
 *     token travels as the model's own `authorization` header (ADR-0081 D2);
 *   * a **pinned** `ResourceLoader` that returns the platform's skills from `.pi/skills` and the
 *     agent's instructions as an appended system prompt, and nothing else: no extension, no prompt
 *     template, no theme, no `AGENTS.md`, nothing from `~/.pi`, `~/.agents` or project discovery
 *     (ADR-0081 D3);
 *   * an in-memory `SettingsManager` and an in-memory `SessionManager`, seeded from the store on a
 *     resume or a fork and mirrored back into it on every `turn_end` (`./session.ts`);
 *   * pi's own built-in tools, allow-listed by `compile`; `bash` replaced by pi's own bash tool
 *     definition with a `spawnHook` that runs it in the request's environment instead of the
 *     runner's `process.env`;
 *   * pi-agent-core's `beforeToolCall`, wrapped with the platform's guard (`./workspace.ts`,
 *     `./guard.ts`), so a write into a read-only grant is blocked as a tool error.
 *
 * and turns each `AgentSessionEvent` into the plain {@link PiEvent} `./frames.ts` maps.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createAgentSession,
  createBashToolDefinition,
  createExtensionRuntime,
  defineTool,
  loadSkillsFromDir,
  ModelRuntime,
  parseSessionEntries,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
  type CreateModelRuntimeOptions,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';

import { credentialRejectedError, isGatewayTokenRefusal } from '@agent-workspace/engine';

import {
  PI_GATEWAY_API_KEY_PLACEHOLDER,
  PI_GATEWAY_PROVIDER,
  PI_DEFAULT_ANTHROPIC_MODEL,
  type PiCompiled,
} from './compile.js';
import { addPiUsage, type PiEvent, type PiUsage } from './frames.js';
import { resolvedPathVerdict } from './guard.js';
import {
  forkPiStream,
  piFileEntries,
  type PiFileEntry,
  type PiSessionMirror,
  type PiStreamVerdict,
} from './session.js';
import { piToolCallVerdict } from './workspace.js';

/** The pinned pi version. `engine.test.ts` holds it to this package's manifest. */
export const PI_CODING_AGENT_VERSION = '1.1.0';

/**
 * The in-memory `SettingsManager` every run starts from: install telemetry off (no file I/O to
 * report against), and cache warming off, since a warming request is pi spending the run's budget
 * on its own schedule rather than the model's (ADR-0081 D3).
 */
function piSettingsManager(): SettingsManager {
  return SettingsManager.inMemory({ enableInstallTelemetry: false, cacheWarming: 'off' });
}

/** The settings a run starts from, read back through pi's own getters, in platform-owned types. */
export type PiRunSettings = {
  readonly cacheWarming: string;
  readonly installTelemetry: boolean;
};

/**
 * What `piSettingsManager()` hands pi, as pi itself reports it. Exported for the adapter's tests;
 * pi's `SettingsManager` stays private to this file, so no emitted declaration names the SDK.
 */
export function piRunSettings(): PiRunSettings {
  const settings = piSettingsManager();
  return {
    cacheWarming: settings.getCacheWarmingMode(),
    installTelemetry: settings.getEnableInstallTelemetry(),
  };
}

type PiModel = NonNullable<CreateAgentSessionOptions['model']>;
/**
 * The failure a run ends with when the model call came back `401` or `403` from the provider
 * (issue #690), or `null` for any other error. pi reports a failed call as one string, the status
 * then the body (`401 {...}`), so the status is read from its start. The adapter never holds the
 * model key, so this is the first moment it can see the key is wrong. A gateway refusal of the run
 * token carries a `token_*` code (`packages/gateway/src/auth.ts`) and is left alone, so nobody is
 * told to replace a good key. No key and no provider text reaches the message.
 */
function rejectedKeyFailure(errorMessage: string): Error | null {
  const status = /^(401|403)(?![0-9])/u.exec(errorMessage)?.[1];
  return status === undefined || isGatewayTokenRefusal(errorMessage)
    ? null
    : credentialRejectedError(status);
}

type PiCredentialStore = NonNullable<CreateModelRuntimeOptions['credentials']>;

/**
 * The credential store pi's model runtime is given: one that holds nothing and accepts nothing.
 * The run token is the only credential a run has, it travels as the model's `authorization`
 * header, and pi's default store is `~/.pi/agent/auth.json` — a host file this adapter never reads.
 */
const NO_STORED_CREDENTIALS: PiCredentialStore = {
  read: () => Promise.resolve(undefined),
  list: () => Promise.resolve([]),
  modify: () =>
    Promise.reject(
      new Error('the pi adapter stores no credential; the run token travels as a header.'),
    ),
  delete: () => Promise.resolve(),
};

/** What a run needs from the engine around it. */
export type PiRunDeps = {
  /** The stream this run's session is mirrored into, or `null` without a session store. */
  readonly mirror: PiSessionMirror | null;
  /** The parent of a fork, read from the store; `null` unless the run is a fork with a store. */
  readonly loadParent: (() => Promise<PiStreamVerdict | null>) | null;
  readonly signal: AbortSignal;
};

/** How a run is started. A parameter of the engine so the conformance kit can replay events. */
export type PiRunStarter = (
  compiled: PiCompiled,
  prompt: string,
  deps: PiRunDeps,
) => AsyncIterable<PiEvent>;

/** The session lines a run starts from: none, the resumed stream, or a copy of the parent. */
async function initialLines(compiled: PiCompiled, deps: PiRunDeps): Promise<PiFileEntry[]> {
  const { session } = compiled;
  if (session.mode === 'fresh') return [];
  if (session.mode === 'resume') {
    if (deps.mirror === null) {
      throw new Error(
        `pi session ${session.engineSessionId} can only be resumed from the session store, and this run has none; refusing to start a new conversation in its place.`,
      );
    }
    const loaded = await deps.mirror.load();
    if (loaded === null) {
      throw new Error(`the session store holds no pi session ${session.engineSessionId}.`);
    }
    if (!loaded.ok) throw new Error(loaded.reason);
    return [...loaded.entries];
  }
  const parentId = session.parentSessionId ?? '';
  if (deps.loadParent === null) {
    throw new Error(
      `pi session ${parentId} can only be forked from the session store, and this run has none.`,
    );
  }
  const parent = await deps.loadParent();
  if (parent === null) throw new Error(`the session store holds no pi session ${parentId}.`);
  if (!parent.ok) throw new Error(parent.reason);
  return [
    ...forkPiStream(parent.entries, {
      engineSessionId: session.engineSessionId,
      parentSessionId: parentId,
      cwd: compiled.workspace.cwd,
      timestamp: new Date().toISOString(),
    }),
  ];
}

/**
 * What a prompt-cache write costs, as a multiple of the model's input rate. Anthropic bills a
 * five-minute cache write at 1.25× the input rate (the one-hour TTL at 2×; pi-ai asks for the
 * five-minute one), and pi-ai caches the system prompt and history every turn, so pricing a write
 * at the plain input rate would let a run pass its `maxBudgetUsd` cap by a quarter of its
 * cache-write spend before `max_budget` fired.
 */
const PI_CACHE_WRITE_INPUT_MULTIPLIER = 1.25;

/**
 * The model, as data: pi's catalogue entry for the named Anthropic model (or its default's, for a
 * model the catalogue does not list), re-pointed at the gateway with the run token as its bearer,
 * and priced with the provisional table when the run carries a cap.
 */
function modelFor(compiled: PiCompiled, runtime: ModelRuntime): PiModel {
  const { connection, agent, limits } = compiled;
  const listed =
    runtime.getModel(PI_GATEWAY_PROVIDER, agent.model) ??
    runtime.getModel(PI_GATEWAY_PROVIDER, PI_DEFAULT_ANTHROPIC_MODEL);
  if (listed === undefined) {
    throw new Error(
      `pi ${PI_CODING_AGENT_VERSION} lists no Anthropic model to describe ${agent.model} with.`,
    );
  }
  const price = limits.budget?.price;
  return {
    ...listed,
    id: agent.model,
    name: agent.model,
    baseUrl: connection.baseUrl,
    headers: { ...(listed.headers ?? {}), authorization: connection.headers.authorization },
    ...(price === undefined
      ? {}
      : {
          cost: {
            input: Number(price.inputUsdPerMillion),
            output: Number(price.outputUsdPerMillion),
            cacheRead: Number(price.cachedInputUsdPerMillion),
            cacheWrite: Number(price.inputUsdPerMillion) * PI_CACHE_WRITE_INPUT_MULTIPLIER,
          },
        }),
  };
}

/** The pinned resource loader (ADR-0081 D3). Every member answers from `compiled` alone. */
function pinnedResourceLoader(compiled: PiCompiled): ResourceLoader {
  const skillsDirectory = path.join(compiled.workspace.cwd, compiled.resources.skillsDirectory);
  const granted = new Set(compiled.resources.skills);
  const loaded =
    granted.size === 0
      ? null
      : loadSkillsFromDir({ dir: skillsDirectory, source: 'agent-workspace' });
  const skills = (loaded?.skills ?? []).filter((skill) =>
    granted.has(path.basename(skill.baseDir)),
  );
  const append = compiled.agent.appendSystemPrompt;
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills, diagnostics: loaded?.diagnostics ?? [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => (append.length === 0 ? [] : [append]),
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: () => Promise.resolve(),
  };
}

/** A queue the session's synchronous listener pushes into and the generator drains. */
function eventQueue(): {
  push(event: unknown): void;
  close(): void;
  next(): Promise<{ done: true } | { done: false; value: unknown }>;
} {
  const items: unknown[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  return {
    push(event) {
      items.push(event);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async next() {
      for (;;) {
        if (items.length > 0) return { done: false, value: items.shift() };
        if (closed) return { done: true };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Run one compiled agent on pi, yielding plain events and, last, `run_completed`.
 *
 * `max_turns` (the `turn_end` count reached with work still to do), `max_budget` (pi's priced
 * usage reaching the cap) and `cancelled` (the caller's interrupt) each end the run through
 * `session.abort()` and a terminal event; a model call that failed is re-thrown, so the runner
 * reports it as the run's error rather than as a turn that ended normally.
 */
export async function* startPiRun(
  compiled: PiCompiled,
  prompt: string,
  deps: PiRunDeps,
): AsyncGenerator<PiEvent, void, void> {
  const { workspace, agent, limits } = compiled;
  const lines = await initialLines(compiled, deps);
  // Imported the way pi imports a session file: as JSONL, through pi's own parser.
  const sessionManager = SessionManager.inMemory(
    workspace.cwd,
    { id: compiled.session.engineSessionId },
    lines.length === 0
      ? undefined
      : parseSessionEntries(lines.map((line) => JSON.stringify(line)).join('\n')),
  );
  const runtime = await ModelRuntime.create({
    credentials: NO_STORED_CREDENTIALS,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider(PI_GATEWAY_PROVIDER, { baseUrl: compiled.connection.baseUrl });
  await runtime.setRuntimeApiKey(PI_GATEWAY_PROVIDER, PI_GATEWAY_API_KEY_PLACEHOLDER);

  const env = { ...compiled.env };
  const { session } = await createAgentSession({
    cwd: workspace.cwd,
    agentDir: path.join(workspace.cwd, compiled.resources.agentDirectory),
    model: modelFor(compiled, runtime),
    thinkingLevel: agent.thinkingLevel,
    modelRuntime: runtime,
    resourceLoader: pinnedResourceLoader(compiled),
    settingsManager: piSettingsManager(),
    sessionManager,
    tools: [...agent.tools],
    customTools: agent.tools.includes('bash')
      ? [
          defineTool(
            createBashToolDefinition(workspace.cwd, {
              exposeSessionEnvironment: false,
              spawnHook: (context) => ({ ...context, env: { ...env } }),
            }),
          ),
        ]
      : [],
  });

  // The platform's guard runs before pi's own hook (which forwards to extensions; there are none).
  const piHook = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    const verdict = piToolCallVerdict(workspace, agent.tools, context.toolCall.name, context.args);
    if (!verdict.allow) return { block: true, reason: verdict.reason };
    if (verdict.path !== null) {
      const resolved = await resolvedPathVerdict(workspace, verdict.path, verdict.writes);
      if (!resolved.ok) return { block: true, reason: resolved.reason };
    }
    return piHook === undefined ? undefined : piHook(context, signal);
  };
  // maxTurns: the tools of the last allowed turn finish, and pi-agent-core's `terminate` hint ends
  // the run after that batch, so no request for a turn past the limit is ever sent.
  const piAfter = session.agent.afterToolCall;
  session.agent.afterToolCall = async (context, signal) => {
    const answered = piAfter === undefined ? undefined : await piAfter(context, signal);
    const lastTurn = limits.maxTurns !== null && state.turns + 1 >= limits.maxTurns;
    return lastTurn ? { ...answered, terminate: true } : answered;
  };

  const queue = eventQueue();
  // Written by the session listener, read after the stream drains: an object, so the reads are not
  // narrowed to the initial values by a control-flow analysis that cannot see the listener.
  const state: {
    turns: number;
    usage: PiUsage | null;
    limit: 'max_turns' | 'max_budget' | null;
    lastAssistant: Readonly<Record<string, unknown>> | null;
  } = { turns: 0, usage: null, limit: null, lastAssistant: null };
  let mirrored: Promise<void> = Promise.resolve();
  let mirrorFailure: unknown = null;
  const mirror = (): void => {
    if (deps.mirror === null) return;
    const target = deps.mirror;
    const file = piFileEntries(sessionManager.getHeader(), sessionManager.getEntries());
    mirrored = mirrored
      .then(() => target.persist(file))
      .catch((error: unknown) => {
        mirrorFailure ??= error;
      });
  };
  const stop = (reason: 'max_turns' | 'max_budget'): void => {
    if (state.limit !== null) return;
    state.limit = reason;
    void session.abort();
  };

  const unsubscribe = session.subscribe((event) => {
    queue.push(event);
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      state.lastAssistant = isRecord(event.message) ? event.message : null;
      state.usage = addPiUsage(state.usage, state.lastAssistant?.['usage']);
      if (limits.budget !== null && (state.usage?.costUsd ?? 0) >= limits.budget.maxBudgetUsd) {
        stop('max_budget');
      }
    }
    if (event.type === 'turn_end') {
      state.turns += 1;
      mirror();
      // The last allowed turn ran tools, so pi would have asked the model again: the `terminate`
      // hint below ended the run instead, and that is a max_turns stop.
      const continues = event.toolResults.length > 0;
      if (limits.maxTurns !== null && state.turns >= limits.maxTurns && continues) {
        state.limit ??= 'max_turns';
      }
    }
  });
  const onAbort = (): void => {
    void session.abort();
  };
  if (deps.signal.aborted) onAbort();
  else deps.signal.addEventListener('abort', onAbort, { once: true });

  let failure: unknown = null;
  const running = session
    .prompt(prompt)
    .catch((error: unknown) => {
      failure = error;
    })
    .finally(() => {
      queue.close();
    });

  try {
    for (;;) {
      const item = await queue.next();
      if (item.done) break;
      yield { kind: 'pi', event: item.value };
    }
    await running;
    mirror();
    await mirrored;
    if (mirrorFailure !== null) {
      throw mirrorFailure instanceof Error
        ? mirrorFailure
        : new Error('the session store refused a write with a non-Error value.');
    }

    let stopReason: 'end_turn' | 'max_turns' | 'max_budget' | 'cancelled';
    if (state.limit !== null) stopReason = state.limit;
    else if (deps.signal.aborted) stopReason = 'cancelled';
    else {
      if (failure !== null) {
        throw failure instanceof Error
          ? failure
          : new Error("pi's prompt failed with a non-Error value.");
      }
      const ended = state.lastAssistant;
      if (ended?.['stopReason'] === 'error') {
        const message = ended['errorMessage'];
        const rejected = typeof message === 'string' ? rejectedKeyFailure(message) : null;
        if (rejected !== null) throw rejected;
        throw new Error(
          `pi's model call failed: ${typeof message === 'string' ? message : 'no reason given'}`,
        );
      }
      stopReason = ended?.['stopReason'] === 'aborted' ? 'cancelled' : 'end_turn';
    }
    yield { kind: 'run_completed', stopReason, turns: state.turns, usage: state.usage };
  } finally {
    deps.signal.removeEventListener('abort', onAbort);
    unsubscribe();
    session.dispose();
  }
}

/**
 * pi's own default model for its Anthropic provider, read from the installed package's source.
 * `compile.ts` restates it as `PI_DEFAULT_ANTHROPIC_MODEL` because pi does not export it; the
 * engine test holds the two equal so a pi bump that changes the default fails loudly.
 */
export async function installedPiDefaultAnthropicModel(): Promise<string | null> {
  const entry = import.meta.resolve('@earendil-works/pi-coding-agent');
  const resolver = new URL('./core/model-resolver.js', entry);
  const source = await readFile(resolver, 'utf8');
  return /\banthropic:\s*"([^"]+)"/u.exec(source)?.[1] ?? null;
}
