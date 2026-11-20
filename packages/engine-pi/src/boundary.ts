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

import {
  PI_GATEWAY_API_KEY_PLACEHOLDER,
  PI_GATEWAY_PROVIDER,
  PI_DEFAULT_ANTHROPIC_MODEL,
  type PiCompiled,
} from './compile.js';
import { addPiUsage, type PiEvent } from './frames.js';
import { resolvedPathVerdict } from './guard.js';
import {
  eventQueue,
  failureSlot,
  initialLines,
  isRecord,
  sessionMirroring,
  stopReasonOf,
  type PiRunDeps,
  type PiRunState,
} from './boundary-run.js';
import { piFileEntries, type PiFileEntry } from './session.js';
import { piToolCallVerdict } from './workspace.js';

export type { PiRunDeps } from './boundary-run.js';

/** How a run is started. A parameter of the engine so the conformance kit can replay events. */
export type PiRunStarter = (
  compiled: PiCompiled,
  prompt: string,
  deps: PiRunDeps,
) => AsyncIterable<PiEvent>;

/** The pinned pi version. `engine.test.ts` holds it to this package's manifest. */
export const PI_CODING_AGENT_VERSION = '1.4.0';

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

/**
 * The model, as data: pi's catalogue entry for the named Anthropic model (or its default's, for a
 * model the catalogue does not list), re-pointed at the gateway with the run token as its bearer.
 * pi's own `cost` rates are left as listed: nothing here prices a cap, the gateway does (ADR-0162).
 */
function modelFor(compiled: PiCompiled, runtime: ModelRuntime): PiModel {
  const { connection, agent } = compiled;
  const listed =
    runtime.getModel(PI_GATEWAY_PROVIDER, agent.model) ??
    runtime.getModel(PI_GATEWAY_PROVIDER, PI_DEFAULT_ANTHROPIC_MODEL);
  if (listed === undefined) {
    throw new Error(
      `pi ${PI_CODING_AGENT_VERSION} lists no Anthropic model to describe ${agent.model} with.`,
    );
  }
  return {
    ...listed,
    id: agent.model,
    name: agent.model,
    baseUrl: connection.baseUrl,
    headers: { ...(listed.headers ?? {}), authorization: connection.headers.authorization },
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

type PiSession = Awaited<ReturnType<typeof createAgentSession>>['session'];
type PiSessionEvent = Parameters<Parameters<PiSession['subscribe']>[0]>[0];

/** The in-memory pi session a run drives, seeded from `lines` the way pi imports a session file. */
async function createRunSession(
  compiled: PiCompiled,
  lines: readonly PiFileEntry[],
): Promise<{ session: PiSession; sessionManager: SessionManager }> {
  const { workspace, agent } = compiled;
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
  return { session, sessionManager };
}

/**
 * Wraps pi-agent-core's tool hooks. The platform's guard runs before pi's own `beforeToolCall`
 * (which forwards to extensions; there are none). maxTurns: the tools of the last allowed turn
 * finish, and pi-agent-core's `terminate` hint ends the run after that batch, so no request for a
 * turn past the limit is ever sent.
 */
function installToolHooks(session: PiSession, compiled: PiCompiled, state: PiRunState): void {
  const { workspace, agent, limits } = compiled;
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
  const piAfter = session.agent.afterToolCall;
  session.agent.afterToolCall = async (context, signal) => {
    const answered = piAfter === undefined ? undefined : await piAfter(context, signal);
    const lastTurn = limits.maxTurns !== null && state.turns + 1 >= limits.maxTurns;
    return lastTurn ? { ...answered, terminate: true } : answered;
  };
}

/** Folds one session event into the run's state; `onTurnEnd` mirrors the session after each turn. */
function observeEvent(
  state: PiRunState,
  event: PiSessionEvent,
  maxTurns: number | null,
  onTurnEnd: () => void,
): void {
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    state.lastAssistant = isRecord(event.message) ? event.message : null;
    state.usage = addPiUsage(state.usage, state.lastAssistant?.['usage']);
  }
  if (event.type !== 'turn_end') return;
  state.turns += 1;
  onTurnEnd();
  // The last allowed turn ran tools, so pi would have asked the model again: the `terminate`
  // hint ended the run instead, and that is a max_turns stop.
  const continues = event.toolResults.length > 0;
  if (maxTurns !== null && state.turns >= maxTurns && continues) state.limit ??= 'max_turns';
}

/**
 * Run one compiled agent on pi, yielding plain events and, last, `run_completed`.
 *
 * `max_turns` (the `turn_end` count reached with work still to do) and `cancelled` (the caller's
 * interrupt) each end the run through `session.abort()` and a terminal event; a spend ceiling is
 * the gateway's (ADR-0162), whose refused call arrives here as a failed model call; a model call that failed is re-thrown, so the runner
 * reports it as the run's error rather than as a turn that ended normally. A stop whose
 * `session.abort()` rejects fails the run the same way, since pi never confirmed it.
 */
export async function* startPiRun(
  compiled: PiCompiled,
  prompt: string,
  deps: PiRunDeps,
): AsyncGenerator<PiEvent, void, void> {
  const lines = await initialLines(compiled, deps);
  const { session, sessionManager } = await createRunSession(compiled, lines);
  // Written by the session listener, read after the stream drains: an object, so the reads are not
  // narrowed to the initial values by a control-flow analysis that cannot see the listener.
  const state: PiRunState = { turns: 0, usage: null, limit: null, lastAssistant: null };
  installToolHooks(session, compiled, state);

  const queue = eventQueue();
  const mirroring = sessionMirroring(deps.mirror, () =>
    piFileEntries(sessionManager.getHeader(), sessionManager.getEntries()),
  );
  // Every abort is awaited after the drain: one pi could not confirm fails the run, like a refused
  // session-store write, rather than reporting a stop that may not have happened.
  const aborts = failureSlot();
  const pendingAborts: Promise<void>[] = [];
  const onAbort = (): void => {
    pendingAborts.push(aborts.track(session.abort()));
  };
  const unsubscribe = session.subscribe((event) => {
    queue.push(event);
    observeEvent(state, event, compiled.limits.maxTurns, mirroring.persist);
  });
  if (deps.signal.aborted) onAbort();
  else deps.signal.addEventListener('abort', onAbort, { once: true });

  let promptFailure: unknown = null;
  const running = session
    .prompt(prompt)
    .catch((error: unknown) => {
      promptFailure = error;
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
    mirroring.persist();
    await mirroring.settle();
    await Promise.all(pendingAborts);
    aborts.raise('pi refused an abort with a non-Error value.');
    const stopReason = stopReasonOf(state, { cancelled: deps.signal.aborted, promptFailure });
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
