/**
 * **The** import site of the OpenAI Agents SDK (ENG-09, #308; spec §42, ADR-0065 D2.3).
 *
 * The only file in the repository allowed to import `@openai/agents`, `@openai/agents-extensions`
 * and `@ai-sdk/anthropic` — `tests/no-sdk-import.test.ts` holds the set equality, and this adapter's
 * row in its table names all three against this one file (ADR-0074 records why the Anthropic path
 * lives here rather than in a second boundary file: it is four lines, and a second allow-listed
 * file would be a second place for an SDK type to leak from).
 *
 * Everything decided about a run is decided before this file is reached: `./compile.ts` produced a
 * plain configuration, and this file turns it into SDK objects and nothing more —
 *
 *   * a model: `OpenAIProvider` for the two OpenAI dialects, `aisdk(createAnthropic(…))` for
 *     Anthropic Messages, both pointed at the gateway's `/v1` with the run token as a bearer;
 *   * a plain `Agent` (never `SandboxAgent`, never a handoff, a guardrail or `needsApproval` —
 *     ADR-0074, ADR-0065 D9) with one function tool per compiled tool name, and one
 *     `Agent.asTool` per subagent (ADR-0133 D14: a nested run, not a handoff);
 *   * the connectors, as `MCPServerStdio` / `MCPServerStreamableHttp` / `MCPServerSSE`;
 *   * a `Runner` with tracing disabled, after `setTracingDisabled(true)` has run.
 *
 * and turns each `RunStreamEvent` into the plain {@link OpenAiAgentsEvent} `./frames.ts` maps.
 */
import type { OpenAiAgentsToolName } from '@indx-workspace/contracts/agents';
import {
  OUTPUT_SCHEMA_UNSATISFIED,
  OUTPUT_SCHEMA_UNSATISFIED_MESSAGE,
} from '@indx-workspace/contracts/runs';
import {
  Agent,
  MaxTurnsExceededError,
  MCPServerSSE,
  MCPServerStdio,
  MCPServerStreamableHttp,
  ModelBehaviorError,
  OpenAIProvider,
  RunMessageOutputItem,
  Runner,
  applyDiff,
  setTracingDisabled,
  tool,
  type JsonSchemaDefinition,
  type MCPServer,
  type Model,
  type RunStreamEvent,
  type Session,
  type Tool,
} from '@openai/agents';
import { aisdk } from '@openai/agents-extensions/ai-sdk';
import { z } from 'zod';

import {
  credentialRejectedError,
  executeRunSkillScript,
  isGatewayTokenRefusal,
  RUN_SKILL_SCRIPT_TOOL,
  skillScriptToolDescription,
} from '@agent-workspace/engine';

import type { OpenAiAgentsCompiled, OpenAiAgentsMcpServer } from './compile.js';
import {
  applyPatch,
  listWorkspaceFiles,
  readWorkspaceFile,
  runShell,
  searchWorkspaceFiles,
} from './executors.js';
import { openAiAgentsBudgetSpent } from './budget.js';
import { addResponseUsage, type OpenAiAgentsEvent, type OpenAiAgentsUsage } from './frames.js';
import type { EngineStoreSession } from './session.js';
import { nodeSkillScriptHost, OPENAI_AGENTS_SKILL_SCRIPT_INPUT } from './skill-script.js';

/**
 * The run's answer: the last assistant message's text, and the SDK's parsed `finalOutput` when a
 * schema was asked for. `null` when that value does not satisfy the schema.
 */
function finalAnswer(
  items: readonly unknown[],
  finalOutput: unknown,
  schema: Readonly<Record<string, unknown>> | null,
): { readonly text: string; readonly structured: unknown } | null {
  const message = items.findLast((item) => item instanceof RunMessageOutputItem);
  const text = message instanceof RunMessageOutputItem ? message.content : '';
  if (schema === null) return { text, structured: null };
  return z.fromJSONSchema(schema).safeParse(finalOutput).success
    ? { text, structured: finalOutput }
    : null;
}

/**
 * The failure a run ends with when a model call came back `401` or `403` from the provider
 * (issue #690), or `null` for any other error. The adapter never holds the model key, so this is
 * the first moment it can see the key is wrong. A gateway refusal of the run token carries a
 * `token_*` code (`packages/gateway/src/auth.ts`) and is left alone, so nobody is told to replace
 * a good key. Only the status is read: no key and no provider text reaches the message.
 */
function rejectedKeyFailure(error: unknown): Error | null {
  if (typeof error !== 'object' || error === null) return null;
  // The OpenAI client names the status `status`, the AI SDK's Anthropic client `statusCode`.
  const status = 'status' in error ? error.status : 'statusCode' in error ? error.statusCode : null;
  if (status !== 401 && status !== 403) return null;
  const code = 'code' in error ? error.code : null;
  const body = 'responseBody' in error ? error.responseBody : null;
  const gatewayRefusal =
    (typeof code === 'string' && code.startsWith('token_')) ||
    (typeof body === 'string' && isGatewayTokenRefusal(body));
  return gatewayRefusal ? null : credentialRejectedError(status);
}

/** The pinned SDK version. `engine.test.ts` holds it to this package's manifest. */
export const OPENAI_AGENTS_SDK_VERSION = '0.21.0';

type OpenAiAgentsPin<Fact extends true> = Fact;
type AsToolOptions = NonNullable<Parameters<Agent['asTool']>[0]>;

/**
 * The `@openai/agents` `.d.ts` facts the subagent mapping rests on, checked by the compiler against
 * the pinned package: `Agent.asTool` takes a tool name and description, a stream handler that
 * receives the nested run's events (the only place its usage is visible), and run options.
 * The default `{input: string}` parameters are not in the declarations; `boundary.test.ts`
 * asserts them at runtime.
 */
type OpenAiAgentsSubagentDeclarationPins = [
  OpenAiAgentsPin<string extends NonNullable<AsToolOptions['toolName']> ? true : false>,
  OpenAiAgentsPin<string extends NonNullable<AsToolOptions['toolDescription']> ? true : false>,
  OpenAiAgentsPin<
    NonNullable<AsToolOptions['onStream']> extends (...args: never[]) => unknown ? true : false
  >,
  OpenAiAgentsPin<
    { maxTurns: number } extends NonNullable<AsToolOptions['runOptions']> ? true : false
  >,
  OpenAiAgentsPin<ReturnType<Agent['asTool']> extends Tool ? true : false>,
];

// Its type names no SDK module, so the emitted declarations stay free of one; it exists to use the pins.
export const OPENAI_AGENTS_SUBAGENT_DECLARATIONS_PINNED =
  true satisfies OpenAiAgentsSubagentDeclarationPins extends readonly true[] ? true : never;

// Tracing is off before anything else in this module can run (ADR-0074): the SDK exports traces
// to OpenAI's dashboard by default, which is egress the gateway never sees. Every run repeats it
// and also passes `tracingDisabled: true` to its `Runner`, so no ordering of imports can undo it.
setTracingDisabled(true);

/**
 * `EngineStoreSession` as the SDK's `Session`. The member names and arities are the SDK's; the
 * item type is widened to a plain record on our side because `./session.ts` may not name the SDK's
 * `AgentInputItem`. `session.test.ts` drives every member through a real run's items.
 */
function asSdkSession(session: EngineStoreSession): Session {
  const members: Pick<
    Session,
    'getSessionId' | 'getItems' | 'addItems' | 'popItem' | 'clearSession'
  > = {
    getSessionId: () => session.getSessionId(),
    getItems: async (limit) =>
      (await session.getItems(limit)) as Awaited<ReturnType<Session['getItems']>>,
    addItems: (items) => session.addItems(items),
    popItem: async () => (await session.popItem()) as Awaited<ReturnType<Session['popItem']>>,
    clearSession: () => session.clearSession(),
  };
  return members;
}

function tokenOf(authorization: string): string {
  return authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : authorization;
}

/** The model this run talks to. The endpoint and the bearer are the only connection inputs. */
async function modelFor(
  compiled: OpenAiAgentsCompiled,
  model: string | null = compiled.agent.model,
): Promise<Model> {
  const { connection } = compiled;
  const token = tokenOf(connection.authorization);
  if (connection.client === 'aisdk-anthropic') {
    // Loaded here, not at the top of the module: `@ai-sdk/anthropic` builds a default provider when
    // it is first evaluated and throws if `ANTHROPIC_BASE_URL` is set but empty, which would make
    // importing this adapter fail for every run, OpenAI-family ones included.
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    // `authToken`, not `apiKey`: the AI SDK sends `apiKey` as `x-api-key`, and the gateway reads
    // only `Authorization: Bearer <run token>` (`packages/gateway/src/auth.ts`).
    const anthropic = createAnthropic({ baseURL: connection.endpoint, authToken: token });
    // `AiSdkModel` is the SDK's `Model`; its declaration differs only under this repository's
    // `exactOptionalPropertyTypes` (`rawUsage?: … | undefined` against `rawUsage?: …`), which is
    // a property of the two packages' `.d.ts`, not of the object.
    return aisdk(anthropic(model ?? '')) as Model;
  }
  const provider = new OpenAIProvider({
    apiKey: token,
    baseURL: connection.endpoint,
    useResponses: connection.protocol === 'openai-responses',
  });
  return provider.getModel(model ?? undefined);
}

const PatchParameters = z.object({
  type: z.enum(['create_file', 'update_file', 'delete_file']),
  path: z.string(),
  diff: z.string().nullable(),
  moveTo: z.string().nullable(),
});

/**
 * One SDK function tool per compiled name, and `run_skill_script` on the main agent when the run
 * offers it (ADR-0137). Nothing outside the compiled list is built.
 */
function toolsFor(
  compiled: OpenAiAgentsCompiled,
  signal: AbortSignal,
  subagentNames?: readonly OpenAiAgentsToolName[],
): Tool[] {
  const names = subagentNames ?? compiled.agent.tools;
  const { workspace, env } = compiled;
  const build: Record<OpenAiAgentsToolName, () => Tool> = {
    read_file: () =>
      tool({
        name: 'read_file',
        description: `Read one UTF-8 file. Paths are relative to ${workspace.cwd}.`,
        parameters: z.object({ path: z.string() }),
        execute: ({ path }) => readWorkspaceFile(workspace, path),
      }),
    list_files: () =>
      tool({
        name: 'list_files',
        description: `List one directory. Paths are relative to ${workspace.cwd}; use "." for the root.`,
        parameters: z.object({ path: z.string() }),
        execute: ({ path }) => listWorkspaceFiles(workspace, path),
      }),
    search_files: () =>
      tool({
        name: 'search_files',
        description:
          'Find the lines containing a plain-text query in one file or under a directory.',
        parameters: z.object({ path: z.string(), query: z.string() }),
        execute: ({ path, query }) => searchWorkspaceFiles(workspace, path, query),
      }),
    apply_patch: () =>
      tool({
        name: 'apply_patch',
        description:
          'Create, update or delete one file. `diff` is a V4A diff: for create_file every line starts with "+"; for update_file use "@@" sections with " ", "-" and "+" lines. Use null where a field does not apply.',
        parameters: PatchParameters,
        execute: (input) =>
          applyPatch(
            workspace,
            input.type === 'delete_file'
              ? { type: 'delete_file', path: input.path }
              : input.type === 'create_file'
                ? { type: 'create_file', path: input.path, diff: input.diff ?? '' }
                : {
                    type: 'update_file',
                    path: input.path,
                    diff: input.diff ?? '',
                    moveTo: input.moveTo,
                  },
            applyDiff,
          ),
      }),
    shell: () =>
      tool({
        name: 'shell',
        description: `Run shell commands in ${workspace.cwd}, in order, stopping at the first failure.`,
        parameters: z.object({
          commands: z.array(z.string()),
          timeoutMs: z.number().int().positive().nullable(),
        }),
        execute: ({ commands, timeoutMs }) =>
          runShell(workspace, env, { commands, timeoutMs }, signal),
      }),
  };
  const { skillScript } = compiled;
  return [
    ...names.map((name) => build[name]()),
    ...(skillScript === null || subagentNames !== undefined
      ? []
      : [
          tool({
            name: RUN_SKILL_SCRIPT_TOOL,
            description: skillScriptToolDescription(skillScript),
            parameters: OPENAI_AGENTS_SKILL_SCRIPT_INPUT,
            execute: async (input) => {
              const { text, isError } = await executeRunSkillScript(
                nodeSkillScriptHost,
                skillScript,
                input,
                signal,
              );
              if (isError) throw new Error(text);
              return text;
            },
          }),
        ]),
  ];
}

function mcpServerFor(
  server: OpenAiAgentsMcpServer,
  env: Readonly<Record<string, string>>,
): MCPServer {
  const toolFilter =
    server.blockedTools.length === 0 ? undefined : { blockedToolNames: [...server.blockedTools] };
  const timeout = server.timeoutMs ?? undefined;
  if (server.transport === 'stdio') {
    return new MCPServerStdio({
      name: server.name,
      command: server.command,
      args: [...server.args],
      env: { ...env, ...server.env },
      ...(timeout === undefined ? {} : { timeout }),
      ...(toolFilter === undefined ? {} : { toolFilter }),
    });
  }
  const options = {
    name: server.name,
    url: server.url,
    requestInit: { headers: { ...server.headers } },
    ...(timeout === undefined ? {} : { timeout }),
    ...(toolFilter === undefined ? {} : { toolFilter }),
  };
  return server.transport === 'http'
    ? new MCPServerStreamableHttp(options)
    : new MCPServerSSE(options);
}

/** One SDK stream event as plain data. Kept close to the SDK's own names. */
function toEvent(event: RunStreamEvent): OpenAiAgentsEvent {
  if (event.type === 'raw_model_stream_event') {
    return { kind: 'raw_model_stream_event', data: event.data };
  }
  if (event.type === 'run_item_stream_event') {
    const item = event.item as { type: string; rawItem?: unknown; output?: unknown };
    return {
      kind: 'run_item_stream_event',
      name: event.name,
      item: {
        type: item.type,
        rawItem: item.rawItem ?? null,
        ...('output' in item ? { output: item.output } : {}),
      },
    };
  }
  return { kind: 'agent_updated_stream_event', agentName: event.agent.name };
}

/** What a run needs from the engine around it. */
export type OpenAiAgentsRunDeps = {
  readonly session: EngineStoreSession | null;
  readonly signal: AbortSignal;
};

/** How a run is started. A parameter of the engine so the conformance kit can replay events. */
export type OpenAiAgentsRunStarter = (
  compiled: OpenAiAgentsCompiled,
  prompt: string,
  deps: OpenAiAgentsRunDeps,
) => AsyncIterable<OpenAiAgentsEvent>;

/**
 * Run one compiled agent on the real SDK, yielding plain events and, last, `run_completed`.
 *
 * A turn limit reached is `max_turns`, a spent budget is `max_budget` and an abort is `cancelled`,
 * each as a terminal event; any other failure is re-thrown, so the runner reports it as the run's
 * error rather than as a turn that ended normally.
 *
 * **The budget (provisional, ADR-0074 D7, #342).** After every model response the usage the
 * gateway reported back is added up and priced (`./budget.ts`); once the estimate reaches
 * `limits.budget.maxBudgetUsd` the run is aborted through its own signal — so no further model
 * request or tool call starts — and ends `max_budget`.
 */
export async function* startOpenAiAgentsRun(
  compiled: OpenAiAgentsCompiled,
  prompt: string,
  deps: OpenAiAgentsRunDeps,
): AsyncGenerator<OpenAiAgentsEvent, void, void> {
  setTracingDisabled(true);
  const servers = compiled.mcpServers.map((server) => mcpServerFor(server, compiled.env));
  // An object, so reads after the stream loop are not narrowed away by the closure's writes.
  const state: { usage: OpenAiAgentsUsage | null; turns: number; budgetSpent: boolean } = {
    usage: null,
    turns: 0,
    budgetSpent: false,
  };
  // The run's own signal: the caller's interrupt, or this adapter's budget stop.
  const run = new AbortController();
  const forwardAbort = (): void => {
    run.abort(deps.signal.reason);
  };
  if (deps.signal.aborted) forwardAbort();
  else deps.signal.addEventListener('abort', forwardAbort, { once: true });
  // Price one model response into the usage; `ownTurn` is false for a subagent's, which costs money
  // but is not one of the run's turns.
  const meter = (raw: unknown, ownTurn: boolean): void => {
    const data = raw as { type?: unknown; response?: { usage?: unknown } };
    if (data.type !== 'response_done') return;
    if (ownTurn) state.turns += 1;
    state.usage = addResponseUsage(state.usage, data.response?.usage);
    state.budgetSpent =
      compiled.limits.budget !== null &&
      openAiAgentsBudgetSpent(compiled.limits.budget, state.usage);
    // A subagent's stream is drained inside its tool call, so the parent loop cannot stop it.
    if (state.budgetSpent) run.abort(new Error('the run reached its budget cap.'));
  };
  try {
    for (const server of servers) await server.connect();
    const modelSettings = {
      ...(compiled.agent.modelSettings.parallelToolCalls === null
        ? {}
        : { parallelToolCalls: compiled.agent.modelSettings.parallelToolCalls }),
      ...(compiled.agent.modelSettings.reasoningEffort === null
        ? {}
        : { reasoning: { effort: compiled.agent.modelSettings.reasoningEffort } }),
    };
    const delegates: Tool[] = [];
    for (const subagent of compiled.subagents) {
      const delegate = new Agent({
        name: subagent.name,
        instructions: subagent.instructions,
        model: await modelFor(compiled, subagent.model),
        tools: toolsFor(compiled, run.signal, subagent.tools),
        mcpServers: servers,
        modelSettings,
      });
      delegates.push(
        delegate.asTool({
          toolName: subagent.toolName,
          toolDescription: subagent.description,
          onStream: ({ event }) => {
            if (event.type === 'raw_model_stream_event') meter(event.data, false);
          },
          ...(compiled.limits.maxTurns === null
            ? {}
            : { runOptions: { maxTurns: compiled.limits.maxTurns } }),
        }),
      );
    }
    const agent = new Agent({
      name: compiled.agent.name,
      instructions: compiled.agent.instructions,
      model: await modelFor(compiled),
      tools: [...toolsFor(compiled, run.signal), ...delegates],
      mcpServers: servers,
      modelSettings,
      // `strict: false`: the provider sees the caller's schema as written; the answer is checked
      // below, because the SDK only JSON-parses a plain JSON Schema.
      ...(compiled.outputSchema === null
        ? {}
        : {
            outputType: {
              type: 'json_schema',
              name: 'output',
              strict: false,
              // The contract fixes the root at `type: "object"`; the SDK's type wants a strict shape.
              schema: compiled.outputSchema as JsonSchemaDefinition['schema'],
            },
          }),
    });
    const runner = new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false });
    let stopReason: 'end_turn' | 'max_turns' | 'max_budget' | 'cancelled' = 'end_turn';
    let output: { readonly text: string; readonly structured: unknown } | undefined;
    let unsatisfied = false;
    try {
      const result = await runner.run(agent, prompt, {
        stream: true,
        signal: run.signal,
        ...(compiled.limits.maxTurns === null ? {} : { maxTurns: compiled.limits.maxTurns }),
        ...(deps.session === null ? {} : { session: asSdkSession(deps.session) }),
      });
      for await (const event of result) {
        const plain = toEvent(event);
        if (plain.kind === 'raw_model_stream_event') meter(plain.data, true);
        yield plain;
        if (state.budgetSpent) break;
      }
      if (state.budgetSpent) {
        // The abort settles `completed` one way or the other; neither way is the run's error.
        await result.completed.catch(() => undefined);
        stopReason = 'max_budget';
      } else {
        await result.completed;
        const failure: unknown = result.error;
        if (failure !== null && failure !== undefined) {
          throw failure instanceof Error
            ? failure
            : new Error('the run failed with a non-Error value.');
        }
        const answer = finalAnswer(result.newItems, result.finalOutput, compiled.outputSchema);
        if (answer === null) unsatisfied = true;
        else output = answer;
      }
    } catch (error) {
      if (state.budgetSpent) stopReason = 'max_budget';
      // The SDK raises this when the final text is not JSON; it is the only structured-output
      // failure it reports, so with a schema asked for it is the model's answer that was wrong.
      else if (error instanceof ModelBehaviorError && compiled.outputSchema !== null) {
        unsatisfied = true;
      } else if (error instanceof MaxTurnsExceededError) stopReason = 'max_turns';
      else if (deps.signal.aborted) stopReason = 'cancelled';
      else throw rejectedKeyFailure(error) ?? error;
    }
    if (deps.signal.aborted) stopReason = 'cancelled';
    yield {
      kind: 'run_completed',
      stopReason,
      turns: state.turns,
      usage: state.usage,
      ...(stopReason === 'end_turn' && output !== undefined ? { output } : {}),
    };
    // After the frames, so the usage of the run that missed its schema is still recorded.
    if (unsatisfied && stopReason === 'end_turn') {
      throw new Error(`${OUTPUT_SCHEMA_UNSATISFIED}: ${OUTPUT_SCHEMA_UNSATISFIED_MESSAGE}`);
    }
  } finally {
    deps.signal.removeEventListener('abort', forwardAbort);
    for (const server of servers) await server.close().catch(() => undefined);
  }
}
