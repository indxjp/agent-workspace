/**
 * The OpenAI Agents compile step: the port's neutral request in, a plain configuration out
 * (ENG-09, #308).
 *
 * **Pure, and SDK-free.** The result is JSON — no SDK class, no client, no function — so the
 * conformance kit can compare two compiles byte for byte, the Lean replay can read it, and
 * `./boundary.ts` is the only code that turns it into `Agent`, `OpenAIProvider`, `aisdk()` and
 * MCP server objects. Everything this engine refuses is refused **here**, as a typed value, before
 * any output frame (ADR-0070 D1).
 *
 * ## What is compiled
 *
 * | Portable input                    | Compiled                                             |
 * | --------------------------------- | ---------------------------------------------------- |
 * | `instructions`, `name`, `model`   | `agent.instructions`, `agent.name`, `agent.model`     |
 * | the four `permissions`            | `agent.tools` and `networkEgress` (`./tools.ts`)      |
 * | file grants                       | `workspace.grants`, enforced by the Editor            |
 * | connectors                        | `mcpServers` (stdio, streamable HTTP, SSE)            |
 * | `limits.maxTurns`                 | `limits.maxTurns`, the SDK's native `maxTurns`        |
 * | `limits.maxBudgetUsd`             | `limits.budget`, priced by `./budget.ts` (provisional) |
 * | the gateway connection            | `connection` — endpoint, protocol and bearer          |
 *
 * ## What is refused, by code
 *
 * * `engine_policy_invalid` — an arm `OpenAiAgentsRunPolicy` cannot read; a grant that does not
 *   normalise or lands in {@link OPENAI_AGENTS_PROTECTED_CONFIG_DIRECTORY}; a connector record this
 *   adapter cannot read.
 * * `engine_capability_unsupported` — a skill (`skills: false`, ADR-0074), a fork, a
 *   `maxBudgetUsd` on a model the provisional price table cannot price (ADR-0074 D7), a wire protocol this engine does not speak, an
 *   MCP tool whose policy asks for a human approval (no HITL, ADR-0065 D9), or an Anthropic-family
 *   connection with no model named.
 * * `engine_credential_refused` — no gateway connection, or a credential-shaped variable in the
 *   environment that is not this run's token (spec A.11).
 */
import type {
  OpenAiAgentsReasoningEffort,
  OpenAiAgentsToolName,
} from '@indx-workspace/contracts/agents';
import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import {
  forkRefusal,
  subagentBudgetRefusal,
  subagentsRefusal,
  subagentToolNames,
  normaliseRequestGrants,
  parsePolicyArm,
  refuse,
  requireGateway,
  sandboxRefusal,
  skillScriptSetup,
  type EngineCompileResult,
  type EngineRefusal,
  type EngineRunRequest,
  type SkillScriptSetup,
} from '@agent-workspace/engine';
import { z } from 'zod';

import {
  OPENAI_AGENTS_PRICES_CHECKED_ON,
  openAiAgentsPriceFor,
  type OpenAiAgentsBudget,
} from './budget.js';
import { OpenAiAgentsRunPolicy } from './policy.js';
import { openAiAgentsToolPlan } from './tools.js';
import type { OpenAiAgentsWorkspace } from './workspace.js';

/** The engine id this adapter answers to. */
export const OPENAI_AGENTS_ENGINE_ID = 'openai-agents';

/**
 * The directory, relative to `cwd`, this adapter reserves for itself.
 *
 * The SDK keeps no configuration on disk, and this engine has no skills, so nothing is written
 * there today. It is reserved anyway, because the port's rule is "a tenant file never lands in the
 * engine's own directory" and an engine that declared none could never grow one without a tenant's
 * file already sitting in it.
 */
export const OPENAI_AGENTS_PROTECTED_CONFIG_DIRECTORY = '.openai-agents';

/** The protocols this adapter speaks, in the order compose prefers them (ADR-0065 D7). */
export const OPENAI_AGENTS_WIRE_PROTOCOLS =
  ENGINE_CATALOGUE['openai-agents'].capabilities.wireProtocols;
export type OpenAiAgentsWireProtocol = (typeof OPENAI_AGENTS_WIRE_PROTOCOLS)[number];

/**
 * How the compiled run reaches its model. `endpoint` is the gateway's `/v1` prefix and nothing
 * else: every model request the SDK issues is `endpoint` + a protocol path, and `authorization`
 * is the run token as a bearer (`packages/gateway/src/auth.ts` accepts only that header).
 */
export type OpenAiAgentsModelConnection = {
  readonly protocol: OpenAiAgentsWireProtocol;
  /** `'openai'` for the two OpenAI dialects (`OpenAIProvider`), `'aisdk-anthropic'` for Messages. */
  readonly client: 'openai' | 'aisdk-anthropic';
  readonly endpoint: string;
  readonly authorization: string;
};

/** One connector, as the boundary hands it to `MCPServerStdio` / `…StreamableHttp` / `…SSE`. */
export type OpenAiAgentsMcpServer =
  | {
      readonly name: string;
      readonly transport: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly timeoutMs: number | null;
      readonly blockedTools: readonly string[];
    }
  | {
      readonly name: string;
      readonly transport: 'http' | 'sse';
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly timeoutMs: number | null;
      readonly blockedTools: readonly string[];
    };

/** A compiled subagent, exposed to the parent as a tool. `model` is the parent's when it names none. */
export type OpenAiAgentsSubagent = {
  readonly name: string;
  /** The `Agent.asTool` name the parent calls it by: `subagent_<sanitised name>`, unique. */
  readonly toolName: string;
  readonly description: string;
  readonly instructions: string;
  readonly model: string | null;
  readonly tools: readonly OpenAiAgentsToolName[];
};

/** The compiled configuration. JSON by construction. */
export type OpenAiAgentsCompiled = {
  readonly engine: typeof OPENAI_AGENTS_ENGINE_ID;
  readonly agent: {
    readonly name: string;
    readonly instructions: string;
    /** `null` is the SDK's own default model; only OpenAI-family connections accept it. */
    readonly model: string | null;
    readonly tools: readonly OpenAiAgentsToolName[];
    readonly modelSettings: {
      readonly reasoningEffort: OpenAiAgentsReasoningEffort | null;
      readonly parallelToolCalls: boolean | null;
    };
  };
  /** One `Agent.asTool` per portable subagent, each on its own narrower tool set. */
  readonly subagents: readonly OpenAiAgentsSubagent[];
  readonly connection: OpenAiAgentsModelConnection;
  readonly networkEgress: boolean;
  readonly mcpServers: readonly OpenAiAgentsMcpServer[];
  readonly limits: {
    readonly maxTurns: number | null;
    /** The provisional cap and its rates, or `null` when the run carries no cap (ADR-0074 D7). */
    readonly budget: OpenAiAgentsBudget | null;
  };
  readonly workspace: OpenAiAgentsWorkspace;
  /**
   * `run_skill_script` (ADR-0137): the tool's setup, or `null`. Always `null` until this engine
   * declares skills, because a granted skill is refused at compile.
   */
  readonly skillScript: SkillScriptSetup | null;
  /** The environment the Shell executor and stdio connectors run with. */
  readonly env: Readonly<Record<string, string>>;
  /** Which session items a run starts from. `fresh` clears nothing and reads nothing. */
  readonly session: {
    readonly mode: 'fresh' | 'resume';
    readonly engineSessionId: string;
    readonly projectKey: string;
  };
  /** Always `true`. Stated in the configuration so a replay can assert it (ADR-0074). */
  readonly tracingDisabled: true;
};

const McpToolPolicy = z
  .object({
    name: z.string().min(1),
    permission_policy: z.enum(['always_allow', 'always_ask', 'always_deny']).optional(),
    org_max_permission: z.enum(['allow', 'ask', 'blocked']).optional(),
  })
  .strict();

const McpTimeout = z.number().int().min(1000).optional();

/**
 * The connector record `packages/core`'s `McpServerConfig` stores, restated as a parse. Restated
 * rather than imported because this adapter may not depend on `packages/core`; `compile.test.ts`
 * holds the two to the same accepted and refused shapes.
 */
const McpServerRecord = z.union([
  z
    .object({
      type: z.enum(['http', 'sse']),
      url: z.url(),
      headers: z.record(z.string().min(1), z.string()).optional(),
      tools: z.array(McpToolPolicy).optional(),
      timeout: McpTimeout,
      alwaysLoad: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('stdio').optional(),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string().min(1), z.string()).optional(),
      timeout: McpTimeout,
      alwaysLoad: z.boolean().optional(),
    })
    .strict(),
]);

function compileMcpServers(
  records: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly servers: OpenAiAgentsMcpServer[] } | EngineRefusal {
  const servers: OpenAiAgentsMcpServer[] = [];
  for (const name of Object.keys(records).sort()) {
    const parsed = McpServerRecord.safeParse(records[name]);
    if (!parsed.success) {
      return refuse(
        'engine_policy_invalid',
        `connector ${JSON.stringify(name)} is not a connector record this adapter can read: ${parsed.error.message}`,
      );
    }
    const record = parsed.data;
    const policies = 'tools' in record ? (record.tools ?? []) : [];
    const asks = policies.find(
      (policy) => policy.permission_policy === 'always_ask' || policy.org_max_permission === 'ask',
    );
    if (asks !== undefined) {
      return refuse(
        'engine_capability_unsupported',
        `connector ${JSON.stringify(name)} asks for a human approval before ${JSON.stringify(asks.name)}. ${OPENAI_AGENTS_ENGINE_ID} runs no approvals (ADR-0065 D9), so the tool cannot be offered as its policy says.`,
      );
    }
    const blockedTools = policies
      .filter(
        (policy) =>
          policy.permission_policy === 'always_deny' || policy.org_max_permission === 'blocked',
      )
      .map((policy) => policy.name);
    const timeoutMs = record.timeout ?? null;
    if ('url' in record) {
      // Remote connectors do not need `unrestrictedNetwork`, as on the Claude engine (Owner
      // decision on #308, ADR-0074 D2): a connector is the author's named endpoint, not the open
      // network the switch governs, and the Claude adapter offers it on the same terms.
      servers.push({
        name,
        transport: record.type,
        url: record.url,
        headers: { ...(record.headers ?? {}) },
        timeoutMs,
        blockedTools,
      });
    } else {
      servers.push({
        name,
        transport: 'stdio',
        command: record.command,
        args: [...(record.args ?? [])],
        env: { ...(record.env ?? {}) },
        timeoutMs,
        blockedTools,
      });
    }
  }
  return { ok: true, servers };
}

/**
 * The model connection for one protocol. The whole of the egress rule: the endpoint is derived
 * from the gateway's base URL and nothing else, and the bearer is the run token.
 */
export function openAiAgentsModelConnection(
  protocol: OpenAiAgentsWireProtocol,
  gateway: { readonly baseUrl: string; readonly token: string },
): OpenAiAgentsModelConnection {
  return {
    protocol,
    client: protocol === 'anthropic-messages' ? 'aisdk-anthropic' : 'openai',
    endpoint: `${gateway.baseUrl.replace(/\/+$/u, '')}/v1`,
    authorization: `Bearer ${gateway.token}`,
  };
}

/** Compile one request. Pure. */
export function compileOpenAiAgentsRun(
  request: EngineRunRequest,
): EngineCompileResult<OpenAiAgentsCompiled> {
  const parsed = parsePolicyArm(
    OPENAI_AGENTS_ENGINE_ID,
    OpenAiAgentsRunPolicy,
    '{ reasoningEffort?, parallelToolCalls? }',
    request.policy,
  );
  if (!parsed.ok) return parsed;
  const policy = parsed.policy;
  const grants = normaliseRequestGrants(request, OPENAI_AGENTS_PROTECTED_CONFIG_DIRECTORY);
  if (!grants.ok) return grants;

  const skillNames =
    request.portable.skills.mode === 'allowlist' ? request.portable.skills.names : [];
  const grantedSkills = [
    ...new Set([...request.resources.skills.map((skill) => skill.name), ...skillNames]),
  ];
  if (grantedSkills.length > 0) {
    return refuse(
      'engine_capability_unsupported',
      `${OPENAI_AGENTS_ENGINE_ID} declares skills: false (ADR-0074), so the granted skill(s) ${grantedSkills.map((name) => JSON.stringify(name)).join(', ')} cannot be honoured. Remove them from the agent or choose an engine with skills.`,
    );
  }
  const fork = forkRefusal(
    OPENAI_AGENTS_ENGINE_ID,
    ENGINE_CATALOGUE['openai-agents'].capabilities,
    request.session,
  );
  if (fork !== null) return fork;
  const subagents = subagentsRefusal(
    OPENAI_AGENTS_ENGINE_ID,
    ENGINE_CATALOGUE['openai-agents'].capabilities,
    request.portable.subagents,
  );
  if (subagents !== null) return subagents;
  const toolNames = subagentToolNames(
    OPENAI_AGENTS_ENGINE_ID,
    'subagent_',
    request.portable.subagents,
  );
  if (!toolNames.ok) return toolNames;
  // ADR-0074 D7, provisional (#342): the cap is enforced here from the usage the gateway reports
  // back, priced with `./budget.ts`. A cap this adapter cannot price is refused, never ignored.
  const maxBudgetUsd = request.portable.limits.maxBudgetUsd;
  let budget: OpenAiAgentsBudget | null = null;
  if (maxBudgetUsd !== null) {
    const price = openAiAgentsPriceFor(request.portable.model);
    if (price === null || request.portable.model === null) {
      return refuse(
        'engine_capability_unsupported',
        request.portable.model === null
          ? `${OPENAI_AGENTS_ENGINE_ID} enforces maxBudget from a provisional price table (ADR-0074), and this run names no model to price its ${String(maxBudgetUsd)} USD cap with. Name the model on the agent or the run, or remove the cap.`
          : `${OPENAI_AGENTS_ENGINE_ID} enforces maxBudget from a provisional price table (ADR-0074), (checked ${OPENAI_AGENTS_PRICES_CHECKED_ON}) which has no row for ${JSON.stringify(request.portable.model)}, so a ${String(maxBudgetUsd)} USD cap cannot be enforced. Choose a priced model or remove the cap.`,
      );
    }
    budget = { maxBudgetUsd, model: request.portable.model, price };
    const mispriced = subagentBudgetRefusal(
      OPENAI_AGENTS_ENGINE_ID,
      request.portable.model,
      maxBudgetUsd,
      request.portable.subagents,
    );
    if (mispriced !== null) return mispriced;
  }

  const connection = requireGateway(OPENAI_AGENTS_ENGINE_ID, request, OPENAI_AGENTS_WIRE_PROTOCOLS);
  if (!connection.ok) return connection;
  const { gateway, protocol } = connection;
  if (protocol === 'anthropic-messages' && request.portable.model === null) {
    return refuse(
      'engine_capability_unsupported',
      `${OPENAI_AGENTS_ENGINE_ID} reaches an Anthropic-family connection through the AI SDK adapter, which has no default model; name the model on the agent or the run.`,
    );
  }

  const sandbox = sandboxRefusal(request.env, gateway.token);
  if (sandbox !== null) return sandbox;

  const hasReadOnlyGrant = grants.grants.some((grant) => grant.access === 'read');
  const plan = openAiAgentsToolPlan(request.portable.permissions, hasReadOnlyGrant);

  const mcp = compileMcpServers(request.portable.mcpServers);
  if (!mcp.ok) return mcp;

  const engineSessionId =
    request.session.mode === 'resume' ? request.session.engineSessionId : request.sessionId;

  return {
    ok: true,
    compiled: {
      engine: OPENAI_AGENTS_ENGINE_ID,
      agent: {
        name: request.portable.name,
        instructions: request.portable.instructions,
        model: request.portable.model,
        tools: plan.tools,
        modelSettings: {
          reasoningEffort: policy.reasoningEffort ?? null,
          parallelToolCalls: policy.parallelToolCalls ?? null,
        },
      },
      subagents: toolNames.named.map((subagent) => ({
        name: subagent.name,
        toolName: subagent.toolName,
        description: subagent.description,
        instructions: subagent.instructions,
        model: subagent.model ?? request.portable.model,
        tools: openAiAgentsToolPlan(subagent.permissions, hasReadOnlyGrant).tools,
      })),
      connection: openAiAgentsModelConnection(protocol, gateway),
      networkEgress: plan.networkEgress,
      mcpServers: mcp.servers,
      limits: { maxTurns: request.portable.limits.maxTurns, budget },
      workspace: {
        cwd: request.cwd.replace(/\/+$/u, ''),
        grants: grants.grants,
        protectedDirectory: OPENAI_AGENTS_PROTECTED_CONFIG_DIRECTORY,
      },
      skillScript: skillScriptSetup(request, OPENAI_AGENTS_PROTECTED_CONFIG_DIRECTORY),
      env: { ...request.env },
      session: {
        mode: request.session.mode === 'resume' ? 'resume' : 'fresh',
        engineSessionId,
        projectKey: request.projectKey,
      },
      tracingDisabled: true,
    },
  };
}
