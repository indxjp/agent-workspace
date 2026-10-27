/**
 * **The** import site of Mastra and the two AI SDK providers it is handed (ENG-10, #309; spec §42,
 * ADR-0065 D2.3).
 *
 * The only file in the repository allowed to import `@mastra/core`, `@mastra/mcp`,
 * `@mastra/memory`, and — besides the OpenAI Agents adapter's own boundary — `@ai-sdk/anthropic`
 * and `@ai-sdk/openai`; `tests/no-sdk-import.test.ts` holds the set equality. Everything decided
 * about a run is decided before this file is reached: `./compile.ts` produced a plain
 * configuration, and this file turns it into Mastra objects and nothing more (ADR-0084):
 *
 *   * a plain `Agent` — never `Harness`, `createCodingAgent()` or a Mastra wrapper of another
 *     engine — with no `Mastra` instance around it, so there is no server, no storage and no
 *     observability registry for anything to export through;
 *   * the model as an **explicit** AI SDK provider instance at the gateway (`createAnthropic` with
 *     the run token as its bearer, or `createOpenAI` with the run token as its key), never a
 *     `"provider/model"` string, which Mastra's router resolves from provider keys in the env;
 *   * a `Workspace` whose tools are all disabled but the plan's, over a `LocalFilesystem` subclass
 *     that refuses every write the grants forbid (`./workspace.ts`, `./guard.ts`) and — when the
 *     plan offers commands — a `LocalSandbox` running in the request's environment, not the
 *     runner's `process.env`. The runtime driver is the isolation boundary; no remote sandbox;
 *   * the platform's skills, from `.mastra/skills/<name>`, as workspace skills;
 *   * connectors as `MCPClient` servers, a stdio server's environment built from the request's
 *     alone and a remote server's requests confined to its own host;
 *   * `Memory` over a storage whose only domain is `memory`: Mastra's in-process domain,
 *     journalled into the platform's store and seeded from it on a resume (`./session.ts`), with
 *     semantic recall, working memory and title generation off.
 *
 * Mastra reads two switches from the process environment when its modules load, so the modules are
 * imported lazily, after {@link MASTRA_PROCESS_ENVIRONMENT} is in place: `MASTRA_TELEMETRY_DISABLED`
 * turns off its PostHog usage telemetry, and `MASTRA_OFFLINE` its model-catalogue refresh.
 */
import { randomUUID } from 'node:crypto';

import type * as AnthropicProviderModule from '@ai-sdk/anthropic';
import type * as OpenAiProviderModule from '@ai-sdk/openai';
import type * as MastraAgentModule from '@mastra/core/agent';
import type * as MastraStorageModule from '@mastra/core/storage';
import type * as MastraToolsModule from '@mastra/core/tools';
import type * as MastraWorkspaceModule from '@mastra/core/workspace';
import type * as MastraMcpModule from '@mastra/mcp';
import type * as MastraMemoryModule from '@mastra/memory';

import {
  OUTPUT_SCHEMA_UNSATISFIED,
  OUTPUT_SCHEMA_UNSATISFIED_MESSAGE,
} from '@indx-workspace/contracts/runs';
import {
  credentialRejectedError,
  executeRunSkillScript,
  isGatewayTokenRefusal,
  RUN_SKILL_SCRIPT_TOOL,
  skillScriptToolDescription,
  type SkillScriptSetup,
} from '@agent-workspace/engine';

import {
  MASTRA_SUBAGENT_TOOL_PREFIX,
  mastraProviderSpec,
  type MastraCompiled,
  type MastraMcpServer,
  type MastraSubagent,
} from './compile.js';
import { addMastraUsage, type MastraEvent, type MastraUsage } from './frames.js';
import { mastraResolvedWriteVerdict } from './guard.js';
import {
  messageEntry,
  threadEntry,
  type MastraJsonRecord,
  type MastraMemoryJournal,
} from './session.js';
import { MASTRA_SKILL_SCRIPT_INPUT, nodeSkillScriptHost } from './skill-script.js';
import { MASTRA_ALWAYS_DISABLED_TOOLS } from './tools.js';
import {
  mastraRelativeSubtreeVerdict,
  mastraRemoveVerdict,
  mastraWriteVerdict,
} from './workspace.js';

/** The pinned Mastra release. `engine.test.ts` holds it to this package's manifest. */
export const MASTRA_CORE_VERSION = '1.79.0';

/**
 * What the runner process's environment must say before Mastra loads (ADR-0084 D4). Each is read
 * by Mastra itself, and each only ever turns something off.
 */
export const MASTRA_PROCESS_ENVIRONMENT: Readonly<Record<string, string>> = {
  MASTRA_TELEMETRY_DISABLED: '1',
  MASTRA_OFFLINE: '1',
};

type MastraModules = {
  readonly agent: typeof MastraAgentModule;
  readonly storage: typeof MastraStorageModule;
  readonly tools: typeof MastraToolsModule;
  readonly workspace: typeof MastraWorkspaceModule;
  readonly memory: typeof MastraMemoryModule;
  readonly anthropic: typeof AnthropicProviderModule;
  readonly openai: typeof OpenAiProviderModule;
};

let loading: Promise<MastraModules> | null = null;

/** The provider base-URL variables whose empty value is removed before the providers load. */
const EMPTIED_BASE_URLS: readonly string[] = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'];

/**
 * The environment Mastra sees when it loads, from whatever the runner's process held: every
 * {@link MASTRA_PROCESS_ENVIRONMENT} switch set, an empty `ANTHROPIC_BASE_URL` /
 * `OPENAI_BASE_URL` removed, and every other variable kept. Pure; `loadMastra` installs it.
 *
 * An empty base URL is removed because each provider package builds a default instance when it
 * loads and refuses an empty base URL there, and an empty value means "unset". The adapter never
 * reads either — every provider it builds is given its base URL.
 */
export function mastraInstalledEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const installed: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (EMPTIED_BASE_URLS.includes(name) && value === '') continue;
    installed[name] = value;
  }
  return { ...installed, ...MASTRA_PROCESS_ENVIRONMENT };
}

/** Put {@link mastraInstalledEnvironment} in place in the process, then import Mastra. Idempotent. */
function loadMastra(): Promise<MastraModules> {
  loading ??= (async () => {
    const installed = mastraInstalledEnvironment(process.env);
    for (const name of Object.keys(process.env)) {
      if (!(name in installed)) delete process.env[name];
    }
    for (const [name, value] of Object.entries(installed)) process.env[name] = value;
    const [agent, storage, tools, workspace, memory, anthropic, openai] = await Promise.all([
      import('@mastra/core/agent'),
      import('@mastra/core/storage'),
      import('@mastra/core/tools'),
      import('@mastra/core/workspace'),
      import('@mastra/memory'),
      import('@ai-sdk/anthropic'),
      import('@ai-sdk/openai'),
    ]);
    return { agent, storage, tools, workspace, memory, anthropic, openai };
  })();
  return loading;
}

/** What a run needs from the engine around it. */
export type MastraRunDeps = {
  /** The stream this run's thread is journalled into, or `null` without a session store. */
  readonly journal: MastraMemoryJournal | null;
  readonly signal: AbortSignal;
  /** The `fetch` the model providers use. The global one unless a test supplies its own. */
  readonly fetch?: typeof globalThis.fetch | undefined;
};

/** How a run is started. A parameter of the engine so the conformance kit can replay events. */
export type MastraRunStarter = (
  compiled: MastraCompiled,
  prompt: string,
  deps: MastraRunDeps,
) => AsyncIterable<MastraEvent>;

type LanguageModel = ReturnType<typeof AnthropicProviderModule.createAnthropic>;

/**
 * The model, as an explicit provider instance at the gateway. Never a routed string. The decision
 * is `mastraProviderSpec`'s; this function only acts on it.
 */
function modelFor(
  modules: MastraModules,
  compiled: MastraCompiled,
  fetch: typeof globalThis.fetch | undefined,
): ReturnType<LanguageModel> {
  const { connection, agent } = compiled;
  const spec = mastraProviderSpec(connection);
  const transport = fetch === undefined ? {} : { fetch };
  if (spec.factory === 'createAnthropic') {
    return modules.anthropic.createAnthropic({
      baseURL: spec.baseURL,
      authToken: connection.token,
      ...transport,
    })(agent.model);
  }
  const openai = modules.openai.createOpenAI({
    baseURL: spec.baseURL,
    apiKey: connection.token,
    ...transport,
  });
  return spec.method === 'responses' ? openai.responses(agent.model) : openai.chat(agent.model);
}

/**
 * Refuse a write the grants forbid, on the named path and then on the resolved one. With
 * `subtree`, also refuse a path whose subtree holds a read-only grant or `.mastra`, on both
 * spellings: removing or moving a directory takes everything under it.
 */
async function assertWritable(
  compiled: MastraCompiled,
  input: string,
  subtree: 'subtree' | 'path' = 'path',
): Promise<void> {
  const named =
    subtree === 'subtree'
      ? mastraRemoveVerdict(compiled.workspace, input)
      : mastraWriteVerdict(compiled.workspace, input);
  if (!named.ok) throw new Error(`write refused: ${named.reason}`);
  const resolved = await mastraResolvedWriteVerdict(compiled.workspace, named.relative);
  if (!resolved.ok) throw new Error(`write refused: ${resolved.reason}`);
  if (subtree === 'path') return;
  const held = mastraRelativeSubtreeVerdict(compiled.workspace, resolved.relative);
  if (!held.ok) throw new Error(`write refused: ${held.reason}`);
}

/** Mastra's `LocalFilesystem`, with every mutating call checked against the run's grants first. */
function grantedFilesystem(
  modules: MastraModules,
  compiled: MastraCompiled,
): MastraWorkspaceModule.LocalFilesystem {
  const { LocalFilesystem } = modules.workspace;
  type Fs = MastraWorkspaceModule.LocalFilesystem;
  class GrantedFilesystem extends LocalFilesystem {
    override async writeFile(...args: Parameters<Fs['writeFile']>): Promise<void> {
      await assertWritable(compiled, args[0]);
      return super.writeFile(...args);
    }
    override async appendFile(...args: Parameters<Fs['appendFile']>): Promise<void> {
      await assertWritable(compiled, args[0]);
      return super.appendFile(...args);
    }
    override async deleteFile(...args: Parameters<Fs['deleteFile']>): Promise<void> {
      await assertWritable(compiled, args[0], 'subtree');
      return super.deleteFile(...args);
    }
    override async copyFile(...args: Parameters<Fs['copyFile']>): Promise<void> {
      await assertWritable(compiled, args[1], 'subtree');
      return super.copyFile(...args);
    }
    override async moveFile(...args: Parameters<Fs['moveFile']>): Promise<void> {
      await assertWritable(compiled, args[0], 'subtree');
      await assertWritable(compiled, args[1], 'subtree');
      return super.moveFile(...args);
    }
    override async mkdir(...args: Parameters<Fs['mkdir']>): Promise<void> {
      await assertWritable(compiled, args[0]);
      return super.mkdir(...args);
    }
    override async rmdir(...args: Parameters<Fs['rmdir']>): Promise<void> {
      await assertWritable(compiled, args[0], 'subtree');
      return super.rmdir(...args);
    }
  }
  return new GrantedFilesystem({ basePath: compiled.workspace.cwd, contained: true });
}

/** The workspace: the plan's tools and nothing else, the platform's skills, and a local sandbox. */
function workspaceFor(
  modules: MastraModules,
  compiled: MastraCompiled,
  id = `agent-workspace-${compiled.memory.threadId}`,
): MastraWorkspaceModule.Workspace {
  const { Workspace, LocalSandbox } = modules.workspace;
  const offersCommands = compiled.agent.tools.includes('mastra_workspace_execute_command');
  const tools: MastraWorkspaceModule.WorkspaceToolsConfig = { enabled: false };
  for (const name of compiled.agent.tools) tools[name] = { enabled: true };
  for (const name of MASTRA_ALWAYS_DISABLED_TOOLS) tools[name] = { enabled: false };
  return new Workspace({
    id,
    filesystem: grantedFilesystem(modules, compiled),
    ...(offersCommands
      ? {
          sandbox: new LocalSandbox({
            workingDirectory: compiled.workspace.cwd,
            env: { ...compiled.env },
          }),
        }
      : {}),
    ...(compiled.agent.skillTools
      ? { skills: compiled.skills.names.map((name) => `${compiled.skills.directory}/${name}`) }
      : {}),
    tools,
  });
}

function dateField(record: MastraJsonRecord, field: string): Date {
  const value = record[field];
  const date = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`a stored Mastra memory record has no readable ${JSON.stringify(field)}.`);
  }
  return date;
}

type StorageThread = Parameters<MastraStorageModule.InMemoryMemory['saveThread']>[0]['thread'];
type StorageMessage = Parameters<
  MastraStorageModule.InMemoryMemory['saveMessages']
>[0]['messages'][number];

/**
 * A thread record read back from the store, as Mastra's storage takes it. `readMastraThread` has
 * checked it is this thread's; only its dates need reviving from their JSON spelling.
 */
function restoredThread(record: MastraJsonRecord): StorageThread {
  const { id, resourceId, title, metadata } = record;
  if (typeof id !== 'string' || typeof resourceId !== 'string') {
    throw new Error('a stored Mastra thread has no id or resource id.');
  }
  return {
    id,
    resourceId,
    ...(typeof title === 'string' ? { title } : {}),
    ...(typeof metadata === 'object' && metadata !== null
      ? { metadata: { ...(metadata as Readonly<Record<string, unknown>>) } }
      : {}),
    createdAt: dateField(record, 'createdAt'),
    updatedAt: dateField(record, 'updatedAt'),
  };
}

/**
 * A message read back from the store. It is a `MastraDBMessage` this adapter journalled
 * (`messageEntry` serialised one) and `readMastraThread` has checked it belongs to this thread, so
 * the one assertion below restores a shape this file wrote; only `createdAt` changes spelling.
 */
function restoredMessage(record: MastraJsonRecord): StorageMessage {
  const restored = { ...record, createdAt: dateField(record, 'createdAt') };
  return restored as unknown as StorageMessage;
}

/**
 * Mastra's in-process memory domain, journalled into the platform's store (ADR-0084 D2): every
 * thread and message Mastra saves is appended to the thread's stream before the call resolves.
 * Nothing is deleted from inside a run; deletion is the platform's session API.
 */
function journalledMemoryDomain(
  modules: MastraModules,
  db: MastraStorageModule.InMemoryDB,
  journal: MastraMemoryJournal | null,
): MastraStorageModule.InMemoryMemory {
  const { InMemoryMemory } = modules.storage;
  type Domain = MastraStorageModule.InMemoryMemory;
  const record = async (entries: Parameters<MastraMemoryJournal['record']>[0]): Promise<void> => {
    if (journal !== null) await journal.record(entries);
  };
  class JournalledMemory extends InMemoryMemory {
    override async saveThread(
      ...args: Parameters<Domain['saveThread']>
    ): ReturnType<Domain['saveThread']> {
      const saved = await super.saveThread(...args);
      await record([threadEntry(saved)]);
      return saved;
    }
    override async updateThread(
      ...args: Parameters<Domain['updateThread']>
    ): ReturnType<Domain['updateThread']> {
      const updated = await super.updateThread(...args);
      await record([threadEntry(updated)]);
      return updated;
    }
    override async saveMessages(
      ...args: Parameters<Domain['saveMessages']>
    ): ReturnType<Domain['saveMessages']> {
      const saved = await super.saveMessages(...args);
      await record(saved.messages.map(messageEntry));
      return saved;
    }
    override async updateMessages(
      ...args: Parameters<Domain['updateMessages']>
    ): ReturnType<Domain['updateMessages']> {
      const updated = await super.updateMessages(...args);
      await record(updated.map(messageEntry));
      return updated;
    }
    override deleteThread(): Promise<void> {
      return Promise.reject(
        new Error('a Mastra run does not delete its thread; the platform does.'),
      );
    }
    override deleteMessages(): Promise<void> {
      return Promise.reject(new Error('a Mastra run does not delete messages; the platform does.'));
    }
  }
  return new JournalledMemory({ db });
}

/** The thread a resume continues, loaded from the store and replayed into the in-process domain. */
async function seedResumedThread(
  modules: MastraModules,
  compiled: MastraCompiled,
  db: MastraStorageModule.InMemoryDB,
  journal: MastraMemoryJournal | null,
): Promise<void> {
  if (compiled.memory.mode !== 'resume') return;
  const { threadId } = compiled.memory;
  if (journal === null) {
    throw new Error(
      `Mastra thread ${threadId} can only be resumed from the session store, and this run has none; refusing to start a new conversation in its place.`,
    );
  }
  const loaded = await journal.load();
  if (loaded === null) throw new Error(`the session store holds no Mastra thread ${threadId}.`);
  if (!loaded.ok) throw new Error(loaded.reason);
  // Replayed through a plain domain over the same db, so the seed is not journalled a second time.
  const seed = new modules.storage.InMemoryMemory({ db });
  await seed.saveThread({ thread: restoredThread(loaded.state.thread) });
  await seed.saveMessages({ messages: loaded.state.messages.map(restoredMessage) });
}

/** `Memory` over the journalled domain, with every model-calling feature off. */
function memoryFor(
  modules: MastraModules,
  compiled: MastraCompiled,
  domain: MastraStorageModule.InMemoryMemory,
): MastraMemoryModule.Memory {
  const storage = new modules.storage.MastraCompositeStore({
    id: 'agent-workspace-session-store',
    domains: { memory: domain },
  });
  return new modules.memory.Memory({
    storage,
    options: {
      lastMessages: compiled.memory.lastMessages,
      semanticRecall: compiled.memory.semanticRecall,
      workingMemory: { enabled: compiled.memory.workingMemory },
      generateTitle: compiled.memory.generateTitle,
    },
  });
}

/** One connector as `MCPClient` takes it. */
function mcpServerDefinition(server: MastraMcpServer): MastraMcpModule.MastraMCPServerDefinition {
  const timeout = server.timeoutMs === null ? {} : { timeout: server.timeoutMs };
  if (server.transport === 'stdio') {
    return {
      command: server.command,
      args: [...server.args],
      env: { ...server.env },
      inheritDefaultEnv: false,
      ...timeout,
    };
  }
  const url = new URL(server.url);
  return {
    url,
    requestInit: { headers: { ...server.headers } },
    allowedHosts: [url.host],
    ...timeout,
  };
}

type McpTools = Awaited<ReturnType<MastraMcpModule.MCPClient['listTools']>>;

/** The connectors' tools, minus the ones a connector's policy blocks. */
async function connectorTools(
  client: MastraMcpModule.MCPClient,
  servers: readonly MastraMcpServer[],
): Promise<McpTools> {
  const blocked = new Set(
    servers.flatMap((server) => server.blockedTools.map((tool) => `${server.name}_${tool}`)),
  );
  const listed = await client.listTools();
  return Object.fromEntries(Object.entries(listed).filter(([name]) => !blocked.has(name)));
}

/** `run_skill_script` (ADR-0137), as a Mastra tool; the run's `signal` stops a running script. */
function skillScriptTool(modules: MastraModules, setup: SkillScriptSetup, signal: AbortSignal) {
  return modules.tools.createTool({
    id: RUN_SKILL_SCRIPT_TOOL,
    description: skillScriptToolDescription(setup),
    inputSchema: MASTRA_SKILL_SCRIPT_INPUT,
    execute: async (input) => {
      const { text, isError } = await executeRunSkillScript(
        nodeSkillScriptHost,
        setup,
        input,
        signal,
      );
      if (isError) throw new Error(text);
      return text;
    },
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The failure a run ends with when the model call came back `401` or `403` from the provider
 * (issue #690), or `null` for any other error. The adapter never holds the model key, so this is
 * the first moment it can see the key is wrong. A gateway refusal of the run token carries a
 * `token_*` code (`packages/gateway/src/auth.ts`) and is left alone, so nobody is told to replace
 * a good key. Only the status is read: no key and no provider text reaches the message.
 */
function rejectedKeyFailure(error: unknown): Error | null {
  if (!isRecord(error)) return null;
  const status = error['statusCode'];
  if (status !== 401 && status !== 403) return null;
  const body = error['responseBody'];
  if (typeof body === 'string' && isGatewayTokenRefusal(body)) return null;
  return credentialRejectedError(status);
}

/** What the stream loop has seen. An object, so reads after the loop are not narrowed away. */
type RunState = {
  steps: number;
  lastStepReason: unknown;
  usage: MastraUsage | null;
  limit: 'max_budget' | null;
  finish: unknown;
  errored: boolean;
  /** Set when an error chunk is the provider refusing the key (issue #690). */
  rejection: Error | null;
  /** Set when an error chunk is Mastra's own structured-output check failing (ADR-0143). */
  schemaFailure: boolean;
  /** The validated value of Mastra's `object-result` chunk, once it has arrived. */
  object: { readonly value: unknown } | null;
};

/**
 * Whether `error` is Mastra's structured-output failure: a `MastraError` whose `id` starts
 * `STRUCTURED_OUTPUT_` (schema mismatch, a truncated answer), or the AI SDK's
 * `NoObjectGeneratedError`. Read by id or name, never by message. Mastra's own
 * `isStructuredOutputFormatError` also counts `AI_JSONParseError` and `AI_TypeValidationError`,
 * but the AI SDK raises those for a malformed provider stream chunk too, which is not the answer
 * failing the schema, so they are left as a plain failed run.
 */
function isStructuredOutputError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (typeof error['id'] === 'string' && error['id'].startsWith('STRUCTURED_OUTPUT_')) return true;
  return error['name'] === 'AI_NoObjectGeneratedError';
}

function outputSchemaUnsatisfied(): Error {
  return new Error(`${OUTPUT_SCHEMA_UNSATISFIED}: ${OUTPUT_SCHEMA_UNSATISFIED_MESSAGE}`);
}

/** Fold one chunk into the run's state. Answers `true` when the budget cap has been reached. */
function observe(state: RunState, chunk: unknown, compiled: MastraCompiled): boolean {
  if (!isRecord(chunk)) return false;
  const payload = isRecord(chunk['payload']) ? chunk['payload'] : {};
  if (chunk['type'] === 'error') {
    state.errored = true;
    state.rejection = rejectedKeyFailure(payload['error']);
    state.schemaFailure = isStructuredOutputError(payload['error']);
  }
  if (chunk['type'] === 'object-result') state.object = { value: chunk['object'] };
  if (chunk['type'] === 'finish') state.finish = chunk;
  if (chunk['type'] === 'tool-output') {
    // A subagent's chunks arrive wrapped in its tool call's output. Its steps cost money, so they
    // count against the cap and the usage; they are not the run's own steps, so `steps` and the
    // `maxSteps` reading stay the parent's.
    const inner = payload['output'];
    if (!isRecord(inner) || inner['type'] !== 'step-finish') return false;
    return meterStep(state, isRecord(inner['payload']) ? inner['payload'] : {}, compiled);
  }
  if (chunk['type'] !== 'step-finish') return false;
  state.steps += 1;
  state.lastStepReason = isRecord(payload['stepResult']) ? payload['stepResult']['reason'] : null;
  return meterStep(state, payload, compiled);
}

/** Price one `step-finish` payload into the run's usage. Answers `true` when the cap is reached. */
function meterStep(
  state: RunState,
  payload: Record<string, unknown>,
  compiled: MastraCompiled,
): boolean {
  const output = isRecord(payload['output']) ? payload['output'] : {};
  const budget = compiled.limits.budget;
  state.usage = addMastraUsage(state.usage, output['usage'], budget?.price ?? null);
  return budget !== null && (state.usage?.costUsd ?? 0) >= budget.maxBudgetUsd;
}

/** What {@link mastraStopReason} reads of a drained run. Plain data. */
export type MastraStopInput = {
  /** The `step-finish` chunks seen. */
  readonly steps: number;
  /** The last step's `stepResult.reason`, as Mastra reported it. */
  readonly lastStepReason: unknown;
  /** The compiled `limits.maxSteps`; `null` is Mastra's own default. */
  readonly maxSteps: number | null;
  /** `max_budget` once the priced usage reached the cap. */
  readonly limit: 'max_budget' | null;
  /** The caller interrupted the run. */
  readonly interrupted: boolean;
};

/**
 * The run's stop reason, once the stream has drained without an `error` chunk. The budget cap
 * wins, then the caller's interrupt; otherwise a run whose last allowed step still asked for tools
 * was cut short (`max_turns`) and any other ends `end_turn` — including one that used exactly
 * `maxSteps` steps and stopped on its own.
 */
export function mastraStopReason(
  input: MastraStopInput,
): 'end_turn' | 'max_turns' | 'max_budget' | 'cancelled' {
  if (input.limit !== null) return input.limit;
  if (input.interrupted) return 'cancelled';
  const cutShort =
    input.maxSteps !== null &&
    input.steps >= input.maxSteps &&
    input.lastStepReason === 'tool-calls';
  return cutShort ? 'max_turns' : 'end_turn';
}

/** {@link mastraStopReason} over the loop's state; a drained run with no `finish` is a failure. */
function stopReasonOf(
  state: RunState,
  compiled: MastraCompiled,
  interrupted: boolean,
): 'end_turn' | 'max_turns' | 'max_budget' | 'cancelled' {
  const input: MastraStopInput = {
    steps: state.steps,
    lastStepReason: state.lastStepReason,
    maxSteps: compiled.limits.maxSteps,
    limit: state.limit,
    interrupted,
  };
  if (input.limit === null && !interrupted && state.finish === null) {
    throw new Error("Mastra's stream ended without a finish chunk.");
  }
  return mastraStopReason(input);
}

/** What Mastra's `structuredOutput.schema` takes; the contract fixes the JSON Schema root at `object`. */
type MastraOutputSchema = NonNullable<
  MastraAgentModule.AgentExecutionOptions['structuredOutput']
>['schema'];
type MastraAgentConfig = ConstructorParameters<typeof MastraAgentModule.Agent>[0];
type MastraPin<Fact extends true> = Fact;

/**
 * The `@mastra/core` `.d.ts` facts the subagent mapping rests on, checked by the compiler against
 * the pinned package: a failing element means an upgrade changed one. The delegation tool's name,
 * `agent-<key>`, is not in the declarations; `boundary.test.ts` asserts it at runtime.
 */
type MastraSubagentDeclarationPins = [
  // `AgentConfig.agents` takes a record of sub-agents, and an `Agent` is one.
  MastraPin<
    Record<string, MastraAgentModule.Agent> extends NonNullable<MastraAgentConfig['agents']>
      ? true
      : false
  >,
  MastraPin<MastraAgentModule.Agent extends MastraAgentModule.SubAgent ? true : false>,
  // A per-agent `description` and `workspace`; `getDescription()` feeds the generated tool.
  MastraPin<string extends NonNullable<MastraAgentConfig['description']> ? true : false>,
  MastraPin<
    MastraWorkspaceModule.Workspace extends NonNullable<MastraAgentConfig['workspace']>
      ? true
      : false
  >,
  MastraPin<ReturnType<MastraAgentModule.Agent['getDescription']> extends string ? true : false>,
  // A sub-agent without memory is given the parent's (`SubAgent.__setMemory`), so each has its own.
  MastraPin<'__setMemory' extends keyof MastraAgentModule.SubAgent ? true : false>,
  MastraPin<
    MastraMemoryModule.Memory extends NonNullable<MastraAgentConfig['memory']> ? true : false
  >,
  // A sub-agent's `defaultOptions.maxSteps` caps the `maxSteps` the delegating model asks for.
  MastraPin<
    { maxSteps: number } extends NonNullable<MastraAgentConfig['defaultOptions']> ? true : false
  >,
];

// Its type names no SDK module, so the emitted declarations stay free of one; it exists to use the pins.
export const MASTRA_SUBAGENT_DECLARATIONS_PINNED =
  true satisfies MastraSubagentDeclarationPins extends readonly true[] ? true : never;

/**
 * The compiled run as one subagent sees it: its own name, instructions, model and tools, the
 * parent's grants, environment and connection. A subagent's workspace is built from this view, so
 * it offers the subagent's tools and no more.
 */
function subagentView(compiled: MastraCompiled, subagent: MastraSubagent): MastraCompiled {
  return {
    ...compiled,
    agent: {
      ...compiled.agent,
      name: subagent.name,
      instructions: subagent.instructions,
      model: subagent.model,
      tools: subagent.tools,
      skillTools: false,
    },
  };
}

/** Release the workspaces and the connectors; answer what could not be released, never throw. */
async function release(
  workspaces: readonly MastraWorkspaceModule.Workspace[],
  client: MastraMcpModule.MCPClient | null,
): Promise<readonly unknown[]> {
  const settled = await Promise.allSettled([
    ...workspaces.map((workspace) => workspace.destroy()),
    client === null ? Promise.resolve() : client.disconnect(),
  ]);
  const reasons: unknown[] = [];
  for (const result of settled) if (result.status === 'rejected') reasons.push(result.reason);
  return reasons;
}

/**
 * Run one compiled agent on Mastra, yielding its chunks and, last, `run_completed`.
 *
 * `max_turns` (the last allowed step still asked for tools), `max_budget` (the priced usage
 * reaching the cap, which aborts the stream) and `cancelled` (the caller's interrupt) each end the
 * run with a terminal event. A Mastra `error` chunk is forwarded — it is the run's `agent.result
 * { stopReason: 'error' }` — and no second result follows it. A failure to release the workspace
 * or a connector is thrown after the run's own outcome, beside the run's own error if it had one.
 */
export async function* startMastraRun(
  compiled: MastraCompiled,
  prompt: string,
  deps: MastraRunDeps,
): AsyncGenerator<MastraEvent, void, void> {
  const modules = await loadMastra();
  const db = new modules.storage.InMemoryDB();
  await seedResumedThread(modules, compiled, db, deps.journal);
  const memory = memoryFor(modules, compiled, journalledMemoryDomain(modules, db, deps.journal));
  const workspace = workspaceFor(modules, compiled);
  const delegates = compiled.subagents.map((subagent, index) => {
    const view = subagentView(compiled, subagent);
    return {
      subagent,
      view,
      workspace: workspaceFor(modules, view, `${workspace.id}-subagent-${String(index)}`),
    };
  });
  // Only a run with connectors pays for `@mastra/mcp`; the environment is installed by now.
  const client =
    compiled.mcpServers.length === 0
      ? null
      : new (await import('@mastra/mcp')).MCPClient({
          id: `agent-workspace-${randomUUID()}`,
          servers: Object.fromEntries(
            compiled.mcpServers.map((server) => [server.name, mcpServerDefinition(server)]),
          ),
        });
  const abort = new AbortController();
  const onAbort = (): void => {
    abort.abort(deps.signal.reason);
  };
  if (deps.signal.aborted) onAbort();
  else deps.signal.addEventListener('abort', onAbort, { once: true });
  const state: RunState = {
    steps: 0,
    lastStepReason: null,
    usage: null,
    limit: null,
    finish: null,
    errored: false,
    rejection: null,
    schemaFailure: false,
    object: null,
  };

  async function* run(): AsyncGenerator<MastraEvent, void, void> {
    await Promise.all([
      workspace.init(),
      ...delegates.map((delegate) => delegate.workspace.init()),
    ]);
    const tools = client === null ? {} : await connectorTools(client, compiled.mcpServers);
    const agents = Object.fromEntries(
      delegates.map(({ subagent, view, workspace: delegateWorkspace }, index) => [
        subagent.toolName.slice(MASTRA_SUBAGENT_TOOL_PREFIX.length),
        new modules.agent.Agent({
          id: `agent-workspace-subagent-${String(index)}`,
          name: subagent.name,
          description: subagent.description,
          instructions: subagent.instructions,
          model: modelFor(modules, view, deps.fetch),
          tools,
          workspace: delegateWorkspace,
          // Its own memory, never journalled: an inherited one would write the sub-agent's thread
          // into the session's stream, which a resume then refuses.
          memory: memoryFor(
            modules,
            view,
            new modules.storage.InMemoryMemory({ db: new modules.storage.InMemoryDB() }),
          ),
          // Mastra clamps the `maxSteps` the delegating model asks for to this; none means no cap.
          ...(compiled.limits.maxSteps === null
            ? {}
            : { defaultOptions: { maxSteps: compiled.limits.maxSteps } }),
        }),
      ]),
    );
    const agent = new modules.agent.Agent({
      id: 'agent-workspace',
      name: compiled.agent.name,
      instructions: compiled.agent.instructions,
      model: modelFor(modules, compiled, deps.fetch),
      tools:
        compiled.skillScript === null
          ? tools
          : {
              ...tools,
              [RUN_SKILL_SCRIPT_TOOL]: skillScriptTool(modules, compiled.skillScript, abort.signal),
            },
      ...(delegates.length === 0 ? {} : { agents }),
      workspace,
      memory,
    });
    const streamOptions = {
      memory: { thread: compiled.memory.threadId, resource: compiled.memory.resourceId },
      abortSignal: abort.signal,
      ...(compiled.limits.maxSteps === null ? {} : { maxSteps: compiled.limits.maxSteps }),
      ...(compiled.agent.toolCallConcurrency === null
        ? {}
        : { toolCallConcurrency: compiled.agent.toolCallConcurrency }),
    };
    // 'strict': a mismatch is an `error` chunk, not a silently dropped value. No `model`: the
    // agent's own gateway connection answers.
    const output =
      compiled.outputSchema === null
        ? await agent.stream(prompt, streamOptions)
        : await agent.stream(prompt, {
            ...streamOptions,
            structuredOutput: {
              schema: compiled.outputSchema as MastraOutputSchema,
              errorStrategy: 'strict',
            },
          });
    for await (const typed of output.fullStream) {
      // Read as data from here on: the frame mapper, not Mastra's types, decides what a chunk is.
      const chunk: unknown = typed;
      const overBudget = observe(state, chunk, compiled);
      // `finish` is carried by `run_completed` below, which knows why the run ended.
      if (isRecord(chunk) && chunk['type'] === 'finish') continue;
      yield { kind: 'mastra', chunk };
      if (overBudget && state.limit === null) {
        state.limit = 'max_budget';
        abort.abort(new Error('the run reached its maxBudgetUsd cap'));
      }
    }
    if (state.errored) {
      // No `run_completed` follows an error, so a `finish` Mastra sent after it would otherwise
      // produce no frame; forwarded, it becomes `agent.native` and nothing is dropped.
      if (state.finish !== null) yield { kind: 'mastra', chunk: state.finish };
      // A rejected key fails the run with a message that says so, after its frames.
      if (state.rejection !== null) throw state.rejection;
      if (state.schemaFailure) throw outputSchemaUnsatisfied();
      return;
    }
    const stopReason = stopReasonOf(state, compiled, deps.signal.aborted);
    // Mastra sends no `object-result` for an empty answer and no error either, so a schema asked
    // for and not delivered is a miss all the same.
    const unsatisfied = compiled.outputSchema !== null && state.object === null;
    yield {
      kind: 'run_completed',
      stopReason,
      steps: state.steps,
      usage: state.usage,
      finish: state.finish,
      ...(stopReason === 'end_turn' && !unsatisfied
        ? { output: { text: await output.text, structured: state.object?.value ?? null } }
        : {}),
    };
    if (unsatisfied && stopReason === 'end_turn') throw outputSchemaUnsatisfied();
  }

  let failure: { readonly error: unknown } | null = null;
  let unreleased: readonly unknown[];
  try {
    yield* run();
  } catch (error) {
    failure = { error };
  } finally {
    deps.signal.removeEventListener('abort', onAbort);
    unreleased = await release(
      [workspace, ...delegates.map((delegate) => delegate.workspace)],
      client,
    );
  }
  const releaseFailure =
    unreleased.length === 0
      ? null
      : new AggregateError(unreleased, 'Mastra could not release the run workspace or connectors.');
  if (failure !== null) {
    throw releaseFailure === null
      ? failure.error
      : new AggregateError([failure.error, releaseFailure], 'the Mastra run failed', {
          cause: failure.error,
        });
  }
  if (releaseFailure !== null) throw releaseFailure;
}

/** The environment Mastra would see if it loaded now. Exported for the adapter's tests. */
export function mastraProcessEnvironmentHolds(): boolean {
  return Object.entries(MASTRA_PROCESS_ENVIRONMENT).every(
    ([name, value]) => process.env[name] === value,
  );
}

/**
 * Load Mastra, and the MCP client a run with connectors needs, with its switches in place, without
 * running anything. For the adapter's tests, so no scenario pays the import inside its own budget.
 */
export async function preloadMastra(): Promise<void> {
  await Promise.all([loadMastra(), import('@mastra/mcp')]);
}

/** The copy and move options the guarded filesystem accepts, in platform-owned types. */
export type GrantedCopyOptions = {
  readonly overwrite?: boolean;
  readonly recursive?: boolean;
};

/** The copy and move surface of the guarded filesystem, in platform-owned types. */
export type GrantedFilesystemForTests = {
  readonly copyFile: (src: string, dest: string, options?: GrantedCopyOptions) => Promise<void>;
  readonly moveFile: (src: string, dest: string, options?: GrantedCopyOptions) => Promise<void>;
};

/**
 * The write-guarded filesystem `workspaceFor` builds. For the adapter's tests: Mastra's own
 * `copyFile`/`moveFile` recurse into a directory with raw `fs.copyFile` (`copyDirectory`), writing
 * under the destination without going through any exported workspace tool, so the guard on that
 * destination is exercised here directly rather than through a scripted tool call. Mastra's
 * `LocalFilesystem` stays private to this file, so no emitted declaration names the SDK.
 */
export async function grantedFilesystemForTests(
  compiled: MastraCompiled,
): Promise<GrantedFilesystemForTests> {
  const modules = await loadMastra();
  const filesystem = grantedFilesystem(modules, compiled);
  return {
    copyFile: (src, dest, options) => filesystem.copyFile(src, dest, options),
    moveFile: (src, dest, options) => filesystem.moveFile(src, dest, options),
  };
}
