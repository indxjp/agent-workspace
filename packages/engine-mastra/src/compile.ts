/**
 * The Mastra compile step: the port's neutral request in, a plain configuration out (ENG-10, #309).
 *
 * **Pure, and SDK-free.** The result is JSON — no Mastra class, no provider, no function — so the
 * conformance kit can compare two compiles byte for byte, the Lean replay can read it, and
 * `./boundary.ts` is the only code that turns it into an `Agent`, a `Workspace`, a `Memory`, an
 * `MCPClient` and an AI SDK provider. Everything this engine refuses is refused **here**, as a typed
 * value, before any output frame (ADR-0070 D1).
 *
 * ## What is compiled
 *
 * | Portable input                    | Compiled                                                  |
 * | --------------------------------- | --------------------------------------------------------- |
 * | `name`, `instructions`            | `agent.name`, `agent.instructions` (`Agent.instructions`) |
 * | `model`                           | `agent.model`, or this adapter's default for the protocol |
 * | the four `permissions`            | `agent.tools`, `networkEgress` (`./tools.ts`)              |
 * | file grants                       | `workspace.grants`, enforced by the filesystem wrapper    |
 * | granted skills                    | `skills` — the workspace skill directories                |
 * | connectors                        | `mcpServers` — `MCPClient` server definitions             |
 * | `limits.maxTurns`                 | `limits.maxSteps`, Mastra's native `maxSteps`             |
 * | `limits.maxBudgetUsd`             | `limits.budget`, priced by the port's provisional table   |
 * | the gateway connection            | `connection` — an explicit AI SDK provider at the gateway |
 * | the session                       | `memory` — one thread over the platform's store           |
 *
 * ## What is refused, by code
 *
 * * `engine_policy_invalid` — an arm `MastraRunPolicy` cannot read; a grant that does not
 *   normalise or lands in {@link MASTRA_PROTECTED_CONFIG_DIRECTORY}; a connector record this
 *   adapter cannot read.
 * * `engine_capability_unsupported` — a fork (`fork: false`), a `maxBudgetUsd` on a model the
 *   provisional price table cannot price (ADR-0074 D7), a wire protocol this engine does not speak,
 *   or a connector tool whose policy asks for a human approval (no HITL, ADR-0065 D9).
 * * `engine_credential_refused` — no gateway connection, a credential-shaped variable in the
 *   environment that is not this run's token (spec A.11), or a database connection variable
 *   (ADR-0084 D2: the sandbox has no database).
 *
 * ## What is fixed, whatever the request says (ADR-0084)
 *
 * The model is always an explicit provider instance pointed at the gateway, never a
 * `"provider/model"` string (Mastra's model router reads provider keys from the environment and
 * would bypass the gateway). Semantic recall, working memory and thread-title generation are off
 * (each is an extra model or embedding call outside the run's model connection). Telemetry and
 * every observability exporter are off. Each is stated in the compiled value so a replay can assert
 * it rather than trust it.
 */
import type { MastraToolName } from '@indx-workspace/contracts/agents';
import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import {
  forkRefusal,
  normaliseRequestGrants,
  parsePolicyArm,
  provisionalBudget,
  refuse,
  requireGateway,
  sandboxRefusal,
  skillScriptSetup,
  subagentBudgetRefusal,
  subagentsRefusal,
  subagentToolNames,
  type EngineCompileResult,
  type EngineRefusal,
  type EngineRunRequest,
  type ProvisionalModelPrice,
  type SkillScriptSetup,
} from '@agent-workspace/engine';
import { z } from 'zod';

import { MastraRunPolicy } from './policy.js';
import { mastraToolPlan } from './tools.js';
import type { MastraWorkspace } from './workspace.js';

/** The engine id this adapter answers to. */
export const MASTRA_ENGINE_ID = 'mastra';

/**
 * The directory, relative to `cwd`, this adapter reserves for itself. Skills are placed under it
 * and the workspace reads them from it; a tenant file never lands in it, and the filesystem wrapper
 * refuses every write into it.
 */
export const MASTRA_PROTECTED_CONFIG_DIRECTORY = '.mastra';

/** Where, under {@link MASTRA_PROTECTED_CONFIG_DIRECTORY}, the platform's skills are placed. */
export const MASTRA_SKILLS_DIRECTORY = `${MASTRA_PROTECTED_CONFIG_DIRECTORY}/skills`;

/**
 * The protocols this adapter speaks, in the order compose prefers them. Mastra takes any AI SDK
 * provider, so it speaks each connection's native dialect and the gateway never translates.
 */
export const MASTRA_WIRE_PROTOCOLS = ENGINE_CATALOGUE.mastra.capabilities.wireProtocols;
export type MastraWireProtocol = (typeof MASTRA_WIRE_PROTOCOLS)[number];

/**
 * The model a run that names none is given, per protocol family. Mastra has no default model of
 * its own (an `Agent` requires one), so the adapter names one; both are rows of the provisional
 * price table, so a cap on a run that names no model can still be enforced.
 */
export const MASTRA_DEFAULT_MODELS: Readonly<Record<'anthropic' | 'openai', string>> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5',
};

/**
 * How many earlier messages of the thread Mastra's memory replays into a run (its `lastMessages`).
 * Fixed rather than configurable: the arm carries no memory option (ADR-0084 D3).
 */
export const MASTRA_MEMORY_LAST_MESSAGES = 40;

/**
 * How the compiled run reaches its model. `baseUrl` is the gateway's `/v1` prefix and nothing else;
 * the AI SDK provider appends the protocol's path (`/messages`, `/responses`, `/chat/completions`),
 * and `authorization` is the run token as a bearer. `api` names the provider factory the boundary
 * calls; there is no string routing.
 */
export type MastraModelConnection = {
  readonly protocol: MastraWireProtocol;
  readonly api: 'anthropic.messages' | 'openai.responses' | 'openai.chat';
  readonly baseUrl: string;
  readonly token: string;
  readonly authorization: string;
};

/** One connector, as the boundary hands it to `MCPClient({ servers })`. */
export type MastraMcpServer =
  | {
      readonly name: string;
      readonly transport: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      /** The complete subprocess environment: the request's, plus the record's own. */
      readonly env: Readonly<Record<string, string>>;
      readonly timeoutMs: number | null;
      readonly blockedTools: readonly string[];
    }
  | {
      readonly name: string;
      readonly transport: 'http';
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly timeoutMs: number | null;
      readonly blockedTools: readonly string[];
    };

/** A compiled cap: the limit, and the rates each step's usage is priced with. JSON, so it compiles. */
export type MastraBudget = {
  readonly maxBudgetUsd: number;
  readonly model: string;
  readonly price: ProvisionalModelPrice;
};

/**
 * The prefix Mastra puts before a sub-agent's `agents` key to name its delegation tool. Not in the
 * declarations; `boundary.test.ts` asserts it at runtime.
 */
export const MASTRA_SUBAGENT_TOOL_PREFIX = 'agent-';

/** A compiled subagent. `model` is the parent's when the subagent names none. */
export type MastraSubagent = {
  readonly name: string;
  /** Its delegation tool, `agent-<sanitised name>`, unique; the `agents` key is the rest of it. */
  readonly toolName: string;
  readonly description: string;
  readonly instructions: string;
  readonly model: string;
  readonly tools: readonly MastraToolName[];
};

/** The compiled configuration. JSON by construction. */
export type MastraCompiled = {
  readonly engine: typeof MASTRA_ENGINE_ID;
  readonly agent: {
    readonly name: string;
    readonly instructions: string;
    readonly model: string;
    readonly tools: readonly MastraToolName[];
    readonly skillTools: boolean;
    /** `null` is Mastra's own default. */
    readonly toolCallConcurrency: number | null;
  };
  /** Mastra's `agents`: one delegate per portable subagent, each on its own narrower workspace. */
  readonly subagents: readonly MastraSubagent[];
  readonly connection: MastraModelConnection;
  readonly networkEgress: boolean;
  readonly mcpServers: readonly MastraMcpServer[];
  readonly limits: {
    /** Mastra's `maxSteps`; `null` is its own default. */
    readonly maxSteps: number | null;
    /** The provisional cap and its rates, or `null` when the run carries no cap (ADR-0074 D7). */
    readonly budget: MastraBudget | null;
  };
  readonly workspace: MastraWorkspace;
  /** The skill directories the workspace discovers `SKILL.md` in, one per granted skill. */
  readonly skills: { readonly directory: string; readonly names: readonly string[] };
  /** `run_skill_script` (ADR-0137): the tool's setup, or `null` when it is not offered. */
  readonly skillScript: SkillScriptSetup | null;
  /** The environment `execute_command` and stdio connectors run with. Never `process.env`. */
  readonly env: Readonly<Record<string, string>>;
  /** Memory over the platform's engine-scoped store (ADR-0084 D2). */
  readonly memory: {
    readonly mode: 'fresh' | 'resume';
    /** Mastra's `thread`: the engine session id, which is the platform session id. */
    readonly threadId: string;
    /** Mastra's `resource`: the tenant namespace the thread belongs to. */
    readonly resourceId: string;
    readonly projectKey: string;
    readonly lastMessages: number;
    readonly semanticRecall: false;
    readonly workingMemory: false;
    readonly generateTitle: false;
  };
  /** Always off. Stated so a replay can assert it (ADR-0084 D4). */
  readonly observability: { readonly telemetry: false; readonly exporters: readonly [] };
};

/**
 * Environment variables that carry a database connection: the ones Mastra's storage adapters and
 * their drivers read (`DATABASE_URL`, `*_DATABASE_URL`, libpq's `PG*`, LibSQL/Turso). The sandbox
 * never holds one (ADR-0084 D2: memory goes through the platform's store), so a request whose
 * environment carries one is refused rather than handed to a subprocess that could open a database.
 */
const DATABASE_ENV =
  /^(?:(?:\w+_)?DATABASE_URL|PG(?:HOST|HOSTADDR|PORT|USER|PASSWORD|PASSFILE|DATABASE|SERVICE)|(?:LIBSQL|TURSO)_\w+)$/u;

/** The first database-connection variable in `env`, or `null`. */
export function databaseEnvName(env: Readonly<Record<string, string>>): string | null {
  return Object.keys(env).find((name) => DATABASE_ENV.test(name.toUpperCase())) ?? null;
}

/** The provider factory each protocol is reached through. */
const PROVIDER_API: Readonly<Record<MastraWireProtocol, MastraModelConnection['api']>> = {
  'anthropic-messages': 'anthropic.messages',
  'openai-responses': 'openai.responses',
  'openai-chat-completions': 'openai.chat',
};

/**
 * The model connection for one gateway and protocol. The whole of the egress rule: the base URL is
 * the gateway's and nothing else, and the bearer is the run token.
 */
export function mastraModelConnection(
  gateway: { readonly baseUrl: string; readonly token: string },
  protocol: MastraWireProtocol,
): MastraModelConnection {
  return {
    protocol,
    api: PROVIDER_API[protocol],
    baseUrl: `${gateway.baseUrl.replace(/\/+$/u, '')}/v1`,
    token: gateway.token,
    authorization: `Bearer ${gateway.token}`,
  };
}

/**
 * How `./boundary.ts#modelFor` builds the model: which AI SDK factory, which option carries the run
 * token, which method picks the dialect, and the base URL. Plain data, so the formal replay checks
 * the decision the boundary acts on rather than a shape the test builds itself.
 */
export type MastraProviderSpec = {
  readonly factory: 'createAnthropic' | 'createOpenAI';
  /** `createAnthropic` sends `authToken` as `Authorization: Bearer`; `createOpenAI` its `apiKey`. */
  readonly option: 'authToken' | 'apiKey';
  readonly method: 'messages' | 'responses' | 'chat';
  readonly baseURL: string;
};

/**
 * The provider a compiled connection is handed to Mastra as. Always an explicit provider instance
 * at the connection's own base URL, never a `"provider/model"` string. This scopes *model*
 * requests only: an HTTP connector's `MCPClient` legitimately reaches its own host.
 */
export function mastraProviderSpec(connection: MastraModelConnection): MastraProviderSpec {
  switch (connection.api) {
    case 'anthropic.messages':
      return {
        factory: 'createAnthropic',
        option: 'authToken',
        method: 'messages',
        baseURL: connection.baseUrl,
      };
    case 'openai.responses':
      return {
        factory: 'createOpenAI',
        option: 'apiKey',
        method: 'responses',
        baseURL: connection.baseUrl,
      };
    case 'openai.chat':
      return {
        factory: 'createOpenAI',
        option: 'apiKey',
        method: 'chat',
        baseURL: connection.baseUrl,
      };
  }
}

/** A connector tool's approval policy, as `packages/core`'s `McpServerConfig` stores it. */
const ConnectorToolPolicy = z
  .object({
    name: z.string().min(1),
    permission_policy: z.enum(['always_allow', 'always_ask', 'always_deny']).optional(),
    org_max_permission: z.enum(['allow', 'ask', 'blocked']).optional(),
  })
  .strict();

/**
 * The connector records this adapter reads: `packages/core`'s `McpServerConfig`, restated as a
 * parse because an adapter may not depend on `packages/core`. Mastra's `MCPClient` speaks stdio
 * and Streamable HTTP (with an SSE fallback on the same URL), so `sse` is read as `http`.
 */
const RemoteConnector = z
  .object({
    type: z.enum(['http', 'sse']),
    url: z.url(),
    headers: z.record(z.string().min(1), z.string()).optional(),
    tools: z.array(ConnectorToolPolicy).optional(),
    timeout: z.number().int().min(1000).optional(),
    alwaysLoad: z.boolean().optional(),
  })
  .strict();
const LocalConnector = z
  .object({
    type: z.literal('stdio').optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string().min(1), z.string()).optional(),
    timeout: z.number().int().min(1000).optional(),
    alwaysLoad: z.boolean().optional(),
  })
  .strict();

type ConnectorsVerdict = { readonly ok: true; readonly servers: MastraMcpServer[] } | EngineRefusal;

function compileConnector(
  name: string,
  record: unknown,
  env: Readonly<Record<string, string>>,
): MastraMcpServer | EngineRefusal {
  const local = LocalConnector.safeParse(record);
  if (local.success) {
    const { command, args, timeout } = local.data;
    return {
      name,
      transport: 'stdio',
      command,
      args: [...(args ?? [])],
      env: { ...env, ...(local.data.env ?? {}) },
      timeoutMs: timeout ?? null,
      blockedTools: [],
    };
  }
  const remote = RemoteConnector.safeParse(record);
  if (!remote.success) {
    return refuse(
      'engine_policy_invalid',
      `connector ${JSON.stringify(name)} is not a connector record this adapter can read: ${remote.error.message}`,
    );
  }
  const policies = remote.data.tools ?? [];
  const asks = policies.find(
    (policy) => policy.permission_policy === 'always_ask' || policy.org_max_permission === 'ask',
  );
  if (asks !== undefined) {
    return refuse(
      'engine_capability_unsupported',
      `connector ${JSON.stringify(name)} asks for a human approval before ${JSON.stringify(asks.name)}. ${MASTRA_ENGINE_ID} runs no approvals (ADR-0065 D9), so the tool cannot be offered as its policy says.`,
    );
  }
  return {
    name,
    transport: 'http',
    url: remote.data.url,
    headers: { ...(remote.data.headers ?? {}) },
    timeoutMs: remote.data.timeout ?? null,
    blockedTools: policies
      .filter(
        (policy) =>
          policy.permission_policy === 'always_deny' || policy.org_max_permission === 'blocked',
      )
      .map((policy) => policy.name),
  };
}

function compileConnectors(
  records: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string>>,
): ConnectorsVerdict {
  const servers: MastraMcpServer[] = [];
  for (const name of Object.keys(records).sort()) {
    const server = compileConnector(name, records[name], env);
    if ('ok' in server) return server;
    servers.push(server);
  }
  return { ok: true, servers };
}

function memoryFor(request: EngineRunRequest): MastraCompiled['memory'] | EngineRefusal {
  const selector = request.session;
  const fork = forkRefusal(MASTRA_ENGINE_ID, ENGINE_CATALOGUE.mastra.capabilities, selector);
  if (fork !== null) return fork;
  return {
    mode: selector.mode === 'resume' ? 'resume' : 'fresh',
    threadId: selector.mode === 'resume' ? selector.engineSessionId : request.sessionId,
    resourceId: request.projectKey,
    projectKey: request.projectKey,
    lastMessages: MASTRA_MEMORY_LAST_MESSAGES,
    semanticRecall: false,
    workingMemory: false,
    generateTitle: false,
  };
}

/** Compile one request. Pure. */
export function compileMastraRun(request: EngineRunRequest): EngineCompileResult<MastraCompiled> {
  const parsed = parsePolicyArm(
    MASTRA_ENGINE_ID,
    MastraRunPolicy,
    '{ toolCallConcurrency? }',
    request.policy,
  );
  if (!parsed.ok) return parsed;
  const grants = normaliseRequestGrants(request, MASTRA_PROTECTED_CONFIG_DIRECTORY);
  if (!grants.ok) return grants;
  const subagents = subagentsRefusal(
    MASTRA_ENGINE_ID,
    ENGINE_CATALOGUE.mastra.capabilities,
    request.portable.subagents,
  );
  if (subagents !== null) return subagents;
  const toolNames = subagentToolNames(
    MASTRA_ENGINE_ID,
    MASTRA_SUBAGENT_TOOL_PREFIX,
    request.portable.subagents,
  );
  if (!toolNames.ok) return toolNames;

  const connection = requireGateway(MASTRA_ENGINE_ID, request, MASTRA_WIRE_PROTOCOLS);
  if (!connection.ok) return connection;
  const { gateway, protocol } = connection;
  const sandbox = sandboxRefusal(request.env, gateway.token);
  if (sandbox !== null) return sandbox;
  const database = databaseEnvName(request.env);
  if (database !== null) {
    return refuse(
      'engine_credential_refused',
      `${MASTRA_ENGINE_ID} keeps memory in the platform's session store and the sandbox holds no database credential (ADR-0084), but the environment carries ${database}.`,
    );
  }

  const model =
    request.portable.model ??
    MASTRA_DEFAULT_MODELS[protocol === 'anthropic-messages' ? 'anthropic' : 'openai'];
  const budget = provisionalBudget(MASTRA_ENGINE_ID, model, request.portable.limits.maxBudgetUsd);
  if (budget !== null && 'ok' in budget) return budget;
  const mispriced = subagentBudgetRefusal(
    MASTRA_ENGINE_ID,
    model,
    request.portable.limits.maxBudgetUsd,
    request.portable.subagents,
  );
  if (mispriced !== null) return mispriced;

  const env = { ...request.env };
  const connectors = compileConnectors(request.portable.mcpServers, env);
  if (!connectors.ok) return connectors;

  const memory = memoryFor(request);
  if ('ok' in memory) return memory;

  const skillNames = [
    ...new Set(
      request.portable.skills.mode === 'allowlist'
        ? request.portable.skills.names
        : request.resources.skills.map((skill) => skill.name),
    ),
  ].sort();
  const hasReadOnlyGrant = grants.grants.some((grant) => grant.access === 'read');
  const plan = mastraToolPlan(
    request.portable.permissions,
    hasReadOnlyGrant,
    skillNames.length > 0,
  );

  return {
    ok: true,
    compiled: {
      engine: MASTRA_ENGINE_ID,
      agent: {
        name: request.portable.name,
        instructions: request.portable.instructions,
        model,
        tools: plan.tools,
        skillTools: plan.skillTools,
        toolCallConcurrency: parsed.policy.toolCallConcurrency ?? null,
      },
      subagents: toolNames.named.map((subagent) => ({
        name: subagent.name,
        toolName: subagent.toolName,
        description: subagent.description,
        instructions: subagent.instructions,
        model: subagent.model ?? model,
        tools: mastraToolPlan(subagent.permissions, hasReadOnlyGrant, false).tools,
      })),
      connection: mastraModelConnection(gateway, protocol),
      networkEgress: plan.networkEgress,
      mcpServers: connectors.servers,
      limits: { maxSteps: request.portable.limits.maxTurns, budget },
      workspace: {
        cwd: request.cwd.replace(/\/+$/u, ''),
        grants: grants.grants,
        protectedDirectory: MASTRA_PROTECTED_CONFIG_DIRECTORY,
      },
      skills: { directory: MASTRA_SKILLS_DIRECTORY, names: skillNames },
      skillScript: skillScriptSetup(request, MASTRA_PROTECTED_CONFIG_DIRECTORY),
      env,
      memory,
      observability: { telemetry: false, exporters: [] },
    },
  };
}
