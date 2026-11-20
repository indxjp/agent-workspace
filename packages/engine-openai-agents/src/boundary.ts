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

import type { OpenAiAgentsCompiled, OpenAiAgentsMcpServer } from './compile.js';
import {
  bearerTokenOf,
  createUsageMeter,
  mcpConnectionOf,
  modelSettingsOf,
  rejectedKeyFailure,
  type OpenAiAgentsUsageMeter,
} from './boundary-support.js';
import { skillScriptToolSpec, workspaceToolSpec, type ToolContext } from './boundary-tool-specs.js';
import type { OpenAiAgentsEvent } from './frames.js';
import type { EngineStoreSession } from './session.js';

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

/** The model this run talks to. The endpoint and the bearer are the only connection inputs. */
async function modelFor(
  compiled: OpenAiAgentsCompiled,
  model: string | null = compiled.agent.model,
): Promise<Model> {
  const { connection } = compiled;
  const token = bearerTokenOf(connection.authorization);
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

/** What every compiled function tool runs against. */
function toolContextOf(compiled: OpenAiAgentsCompiled, signal: AbortSignal): ToolContext {
  return { workspace: compiled.workspace, env: compiled.env, signal, applyDiff };
}

/**
 * One SDK function tool per compiled name, and `run_skill_script` on the main agent when the run
 * offers it (ADR-0137). Nothing outside the compiled list is built.
 */
function toolsFor(
  compiled: OpenAiAgentsCompiled,
  signal: AbortSignal,
  subagentNames?: readonly OpenAiAgentsToolName[],
): Tool[] {
  const context = toolContextOf(compiled, signal);
  const specs = (subagentNames ?? compiled.agent.tools).map((name) =>
    workspaceToolSpec(name, context),
  );
  const { skillScript } = compiled;
  if (skillScript !== null && subagentNames === undefined) {
    specs.push(skillScriptToolSpec(skillScript, signal));
  }
  return specs.map((spec) => tool(spec));
}

function mcpServerFor(
  server: OpenAiAgentsMcpServer,
  env: Readonly<Record<string, string>>,
): MCPServer {
  const connection = mcpConnectionOf(server, env);
  if (connection.transport === 'stdio') return new MCPServerStdio(connection.options);
  return connection.transport === 'http'
    ? new MCPServerStreamableHttp(connection.options)
    : new MCPServerSSE(connection.options);
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

/** One `Agent.asTool` per subagent (ADR-0133 D14): a nested run whose usage is metered, not a turn. */
async function delegatesFor(
  compiled: OpenAiAgentsCompiled,
  deps: OpenAiAgentsRunDeps,
  servers: readonly MCPServer[],
  meter: OpenAiAgentsUsageMeter,
): Promise<Tool[]> {
  const modelSettings = modelSettingsOf(compiled.agent.modelSettings);
  const delegates: Tool[] = [];
  for (const subagent of compiled.subagents) {
    const delegate = new Agent({
      name: subagent.name,
      instructions: subagent.instructions,
      model: await modelFor(compiled, subagent.model),
      tools: toolsFor(compiled, deps.signal, subagent.tools),
      mcpServers: [...servers],
      modelSettings,
    });
    delegates.push(
      delegate.asTool({
        toolName: subagent.toolName,
        toolDescription: subagent.description,
        onStream: ({ event }) => {
          if (event.type === 'raw_model_stream_event') meter.record(event.data, false);
        },
        ...(compiled.limits.maxTurns === null
          ? {}
          : { runOptions: { maxTurns: compiled.limits.maxTurns } }),
      }),
    );
  }
  return delegates;
}

async function mainAgentFor(
  compiled: OpenAiAgentsCompiled,
  deps: OpenAiAgentsRunDeps,
  servers: readonly MCPServer[],
  meter: OpenAiAgentsUsageMeter,
) {
  const delegates = await delegatesFor(compiled, deps, servers, meter);
  return new Agent({
    name: compiled.agent.name,
    instructions: compiled.agent.instructions,
    model: await modelFor(compiled),
    tools: [...toolsFor(compiled, deps.signal), ...delegates],
    mcpServers: [...servers],
    modelSettings: modelSettingsOf(compiled.agent.modelSettings),
    // `strict: false`: the provider sees the caller's schema as written; the answer is checked
    // after the stream, because the SDK only JSON-parses a plain JSON Schema.
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
}

/** How the SDK run ended, before the abort signal has the last word. */
type RunOutcome = {
  readonly stopReason: 'end_turn' | 'max_turns' | 'cancelled';
  readonly unsatisfied: boolean;
  readonly output?: { readonly text: string; readonly structured: unknown };
};

/** The outcome a run's error stands for, or the error itself re-thrown when it is a real failure. */
function outcomeOfError(error: unknown, outputSchema: unknown, signal: AbortSignal): RunOutcome {
  // The SDK raises this when the final text is not JSON; it is the only structured-output
  // failure it reports, so with a schema asked for it is the model's answer that was wrong.
  if (error instanceof ModelBehaviorError && outputSchema !== null) {
    return { stopReason: 'end_turn', unsatisfied: true };
  }
  if (error instanceof MaxTurnsExceededError)
    return { stopReason: 'max_turns', unsatisfied: false };
  if (signal.aborted) return { stopReason: 'cancelled', unsatisfied: false };
  throw rejectedKeyFailure(error) ?? error;
}

/** Stream one SDK run as plain events; returns how it ended. */
async function* streamRun(
  agent: Awaited<ReturnType<typeof mainAgentFor>>,
  prompt: string,
  compiled: OpenAiAgentsCompiled,
  deps: OpenAiAgentsRunDeps,
  meter: OpenAiAgentsUsageMeter,
): AsyncGenerator<OpenAiAgentsEvent, RunOutcome, void> {
  const runner = new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false });
  try {
    const result = await runner.run(agent, prompt, {
      stream: true,
      signal: deps.signal,
      ...(compiled.limits.maxTurns === null ? {} : { maxTurns: compiled.limits.maxTurns }),
      ...(deps.session === null ? {} : { session: asSdkSession(deps.session) }),
    });
    for await (const event of result) {
      const plain = toEvent(event);
      if (plain.kind === 'raw_model_stream_event') meter.record(plain.data, true);
      yield plain;
    }
    await result.completed;
    const failure: unknown = result.error;
    if (failure !== null && failure !== undefined) {
      throw failure instanceof Error
        ? failure
        : new Error('the run failed with a non-Error value.');
    }
    const output = finalAnswer(result.newItems, result.finalOutput, compiled.outputSchema);
    return output === null
      ? { stopReason: 'end_turn', unsatisfied: true }
      : { stopReason: 'end_turn', unsatisfied: false, output };
  } catch (error) {
    return outcomeOfError(error, compiled.outputSchema, deps.signal);
  }
}

/**
 * Run one compiled agent on the real SDK, yielding plain events and, last, `run_completed`.
 *
 * A turn limit reached is `max_turns` and an abort is `cancelled`, each as a terminal event; any
 * other failure is re-thrown, so the runner reports it as the run's error rather than as a turn
 * that ended normally.
 *
 * **The budget is the gateway's (ADR-0162).** This adapter enforces no spend cap: the gateway
 * refuses a model call once the run's settled cost reaches its spend ceiling and ends the run
 * `run_budget_reached` itself, so the refused call surfaces here as a failed model call.
 */
export async function* startOpenAiAgentsRun(
  compiled: OpenAiAgentsCompiled,
  prompt: string,
  deps: OpenAiAgentsRunDeps,
): AsyncGenerator<OpenAiAgentsEvent, void, void> {
  setTracingDisabled(true);
  const servers = compiled.mcpServers.map((server) => mcpServerFor(server, compiled.env));
  const meter = createUsageMeter();
  try {
    for (const server of servers) await server.connect();
    const agent = await mainAgentFor(compiled, deps, servers, meter);
    const outcome = yield* streamRun(agent, prompt, compiled, deps, meter);
    const stopReason = deps.signal.aborted ? 'cancelled' : outcome.stopReason;
    yield {
      kind: 'run_completed',
      stopReason,
      turns: meter.turns(),
      usage: meter.usage(),
      ...(stopReason === 'end_turn' && outcome.output !== undefined
        ? { output: outcome.output }
        : {}),
    };
    // After the frames, so the usage of the run that missed its schema is still recorded.
    if (outcome.unsatisfied && stopReason === 'end_turn') {
      throw new Error(`${OUTPUT_SCHEMA_UNSATISFIED}: ${OUTPUT_SCHEMA_UNSATISFIED_MESSAGE}`);
    }
  } finally {
    for (const server of servers) await server.close().catch(() => undefined);
  }
}
