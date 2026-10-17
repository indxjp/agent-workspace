/**
 * The pi compile step: the port's neutral request in, a plain configuration out (ENG-08, #307).
 *
 * **Pure, and SDK-free.** The result is JSON — no pi class, no function — so the conformance kit
 * can compare two compiles byte for byte, the Lean replay can read it, and `./boundary.ts` is the
 * only code that turns it into a `ModelRuntime`, a pinned `ResourceLoader`, a `SessionManager` and
 * `createAgentSession` options. Everything this engine refuses is refused **here**, as a typed
 * value, before any output frame (ADR-0070 D1).
 *
 * ## What is compiled
 *
 * | Portable input                    | Compiled                                                |
 * | --------------------------------- | ------------------------------------------------------- |
 * | `instructions`                    | `agent.appendSystemPrompt` — appended to pi's own prompt |
 * | `model`                           | `agent.model`, or pi's own Anthropic default             |
 * | the four `permissions`            | `agent.tools` and `networkEgress` (`./tools.ts`)         |
 * | file grants                       | `workspace.grants`, enforced by the tool guard           |
 * | granted skills                    | `resources.skills` — the only skills the loader returns  |
 * | `limits.maxTurns`                 | `limits.maxTurns`, counted on `turn_end` by the adapter  |
 * | `limits.maxBudgetUsd`             | `limits.budget`, priced by the port's provisional table  |
 * | the gateway connection            | `connection` — base URL, bearer header, placeholder key  |
 *
 * ## What is refused, by code
 *
 * * `engine_policy_invalid` — an arm `PiRunPolicy` cannot read; a grant that does not normalise
 *   or lands in {@link PI_PROTECTED_CONFIG_DIRECTORY}.
 * * `engine_capability_unsupported` — a connector (`mcp: false`: pi has no MCP client, and a
 *   bridge would be an emulation, ADR-0081), a `maxBudgetUsd` on a model the provisional price
 *   table cannot price (ADR-0074 D7), or a wire protocol other than Anthropic Messages.
 * * `engine_credential_refused` — no gateway connection, or a credential-shaped variable in the
 *   environment that is not this run's token (spec A.11).
 *
 * ## Why the model's `Authorization` header, and a placeholder key (ADR-0081 D2)
 *
 * The gateway authenticates one header, `Authorization: Bearer <run token>`
 * (`packages/gateway/src/auth.ts`), and pi-ai's Anthropic client sends its API key as `x-api-key`.
 * pi models are data, and a model's `headers` are sent verbatim by that client, so the run token
 * travels as the model's `authorization` header. pi still insists on *some* key for the provider,
 * so {@link PI_GATEWAY_API_KEY_PLACEHOLDER} is set as the provider's runtime key: it is a fixed,
 * public string that authenticates nothing, which is exactly what the gateway fixture proves.
 */
import type { PiThinkingLevel, PiToolName } from '@indx-workspace/contracts/agents';
import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import {
  normaliseRequestGrants,
  parsePolicyArm,
  provisionalBudget,
  refuse,
  requireGateway,
  sandboxRefusal,
  subagentsRefusal,
  type EngineCompileResult,
  type EngineRefusal,
  type EngineRunRequest,
  type ProvisionalModelPrice,
} from '@agent-workspace/engine';

import { PiRunPolicy } from './policy.js';
import { piToolPlan } from './tools.js';
import type { PiWorkspace } from './workspace.js';

/** The engine id this adapter answers to. */
export const PI_ENGINE_ID = 'pi';

/**
 * The directory, relative to `cwd`, this adapter reserves for itself: pi's own project directory
 * name. Skills are placed under it and the pinned loader reads them from it; a tenant file never
 * lands in it, so a grant cannot plant a skill, an extension or a `settings.json` there.
 */
export const PI_PROTECTED_CONFIG_DIRECTORY = '.pi';

/** Where, under {@link PI_PROTECTED_CONFIG_DIRECTORY}, the platform's skills are placed. */
export const PI_SKILLS_DIRECTORY = `${PI_PROTECTED_CONFIG_DIRECTORY}/skills`;

/**
 * pi's global configuration directory for this run, under the protected directory instead of
 * `~/.pi/agent`. Every pi service the adapter constructs is handed an explicit in-memory or
 * pinned value, so nothing is read from it; naming it keeps pi's default (`$HOME/.pi/agent`) from
 * ever being the fallback.
 */
export const PI_AGENT_DIRECTORY = `${PI_PROTECTED_CONFIG_DIRECTORY}/agent`;

/** The protocols this adapter speaks. The gateway serves pi only Anthropic Messages today. */
export const PI_WIRE_PROTOCOLS = ENGINE_CATALOGUE.pi.capabilities.wireProtocols;
export type PiWireProtocol = (typeof PI_WIRE_PROTOCOLS)[number];

/**
 * The model a run names none of: pi's own default for its Anthropic provider
 * (`defaultModelPerProvider.anthropic` in `@earendil-works/pi-coding-agent` 1.1.0). Restated
 * because pi does not export it; `boundary.test.ts` holds the two equal.
 */
export const PI_DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';

/** The pi provider every model call goes through: pi's Anthropic provider, re-pointed. */
export const PI_GATEWAY_PROVIDER = 'anthropic';

/** The API key pi's provider is given. Public, fixed, and never an authenticator (see header). */
export const PI_GATEWAY_API_KEY_PLACEHOLDER = 'agent-workspace-gateway-uses-the-bearer-header';

/**
 * How the compiled run reaches its model. `baseUrl` is the gateway's and nothing else — pi-ai's
 * Anthropic client appends `/v1/messages` — and `headers.authorization` is the run token.
 */
export type PiModelConnection = {
  readonly protocol: PiWireProtocol;
  readonly provider: typeof PI_GATEWAY_PROVIDER;
  readonly baseUrl: string;
  readonly headers: { readonly authorization: string };
  readonly apiKey: typeof PI_GATEWAY_API_KEY_PLACEHOLDER;
};

/** A compiled cap: the limit, and the rates pi prices each response with. JSON, so it compiles. */
export type PiBudget = {
  readonly maxBudgetUsd: number;
  readonly model: string;
  readonly price: ProvisionalModelPrice;
};

/** The compiled configuration. JSON by construction. */
export type PiCompiled = {
  readonly engine: typeof PI_ENGINE_ID;
  readonly agent: {
    readonly name: string;
    /** Appended to pi's own system prompt, never a replacement of it. Empty means nothing. */
    readonly appendSystemPrompt: string;
    readonly model: string;
    readonly thinkingLevel: PiThinkingLevel;
    readonly tools: readonly PiToolName[];
  };
  readonly connection: PiModelConnection;
  readonly networkEgress: boolean;
  readonly limits: {
    readonly maxTurns: number | null;
    /** The provisional cap and its rates, or `null` when the run carries no cap (ADR-0074 D7). */
    readonly budget: PiBudget | null;
  };
  readonly workspace: PiWorkspace;
  /**
   * What the pinned resource loader may return, and nothing else (ADR-0081 D3): the skills the
   * platform placed, from the one directory it placed them in. No extension, prompt template,
   * theme or context file is ever loaded.
   */
  readonly resources: {
    readonly skillsDirectory: string;
    readonly skills: readonly string[];
    readonly agentDirectory: string;
  };
  /** The environment `bash` runs with. Never the runner's own `process.env`. */
  readonly env: Readonly<Record<string, string>>;
  /** Which stream a run starts from, and under which id pi's session runs. */
  readonly session: {
    readonly mode: 'fresh' | 'resume' | 'fork';
    readonly engineSessionId: string;
    /** The session a fork copies; `null` unless `mode` is `fork`. */
    readonly parentSessionId: string | null;
    readonly projectKey: string;
  };
};

/**
 * The model connection for one gateway. The whole of the egress rule: the base URL is the
 * gateway's and nothing else, and the bearer is the run token.
 */
export function piModelConnection(gateway: {
  readonly baseUrl: string;
  readonly token: string;
}): PiModelConnection {
  return {
    protocol: 'anthropic-messages',
    provider: PI_GATEWAY_PROVIDER,
    baseUrl: gateway.baseUrl.replace(/\/+$/u, ''),
    headers: { authorization: `Bearer ${gateway.token}` },
    apiKey: PI_GATEWAY_API_KEY_PLACEHOLDER,
  };
}

/** The session this run's pi session is, and the one a fork copies. */
function sessionFor(request: EngineRunRequest): PiCompiled['session'] | EngineRefusal {
  const selector = request.session;
  if (selector.mode === 'resume') {
    return {
      mode: 'resume',
      engineSessionId: selector.engineSessionId,
      parentSessionId: null,
      projectKey: request.projectKey,
    };
  }
  if (selector.mode === 'fork') {
    if (selector.engineSessionId === request.sessionId) {
      return refuse(
        'engine_policy_invalid',
        `a fork must start a new session; the request forks ${JSON.stringify(selector.engineSessionId)} into itself.`,
      );
    }
    return {
      mode: 'fork',
      engineSessionId: request.sessionId,
      parentSessionId: selector.engineSessionId,
      projectKey: request.projectKey,
    };
  }
  return {
    mode: 'fresh',
    engineSessionId: request.sessionId,
    parentSessionId: null,
    projectKey: request.projectKey,
  };
}

/** Compile one request. Pure. */
export function compilePiRun(request: EngineRunRequest): EngineCompileResult<PiCompiled> {
  const parsed = parsePolicyArm(PI_ENGINE_ID, PiRunPolicy, '{ thinkingLevel? }', request.policy);
  if (!parsed.ok) return parsed;
  const policy = parsed.policy;
  const grants = normaliseRequestGrants(request, PI_PROTECTED_CONFIG_DIRECTORY);
  if (!grants.ok) return grants;

  const connectors = Object.keys(request.portable.mcpServers).sort();
  if (connectors.length > 0) {
    return refuse(
      'engine_capability_unsupported',
      `${PI_ENGINE_ID} declares mcp: false (ADR-0081): pi has no MCP client, so the connector(s) ${connectors.map((name) => JSON.stringify(name)).join(', ')} cannot be honoured. Remove them from the agent or choose an engine with mcp.`,
    );
  }

  const subagents = subagentsRefusal(
    PI_ENGINE_ID,
    ENGINE_CATALOGUE.pi.capabilities,
    request.portable.subagents,
  );
  if (subagents !== null) return subagents;

  const model = request.portable.model ?? PI_DEFAULT_ANTHROPIC_MODEL;
  // ADR-0074 D7, provisional (#342), shared with pi by ADR-0081: the cap is enforced from the usage
  // of each response, priced with the port's table. A cap this adapter cannot price is refused.
  const budget = provisionalBudget(PI_ENGINE_ID, model, request.portable.limits.maxBudgetUsd);
  if (budget !== null && 'ok' in budget) return budget;

  const connection = requireGateway(PI_ENGINE_ID, request, PI_WIRE_PROTOCOLS);
  if (!connection.ok) return connection;
  const { gateway } = connection;

  const sandbox = sandboxRefusal(request.env, gateway.token);
  if (sandbox !== null) return sandbox;

  const session = sessionFor(request);
  if ('ok' in session) return session;

  const hasReadOnlyGrant = grants.grants.some((grant) => grant.access === 'read');
  const plan = piToolPlan(request.portable.permissions, hasReadOnlyGrant);
  const skillNames =
    request.portable.skills.mode === 'allowlist'
      ? request.portable.skills.names
      : request.resources.skills.map((skill) => skill.name);

  return {
    ok: true,
    compiled: {
      engine: PI_ENGINE_ID,
      agent: {
        name: request.portable.name,
        appendSystemPrompt: request.portable.instructions,
        model,
        thinkingLevel: policy.thinkingLevel ?? 'off',
        tools: plan.tools,
      },
      connection: piModelConnection(gateway),
      networkEgress: plan.networkEgress,
      limits: { maxTurns: request.portable.limits.maxTurns, budget },
      workspace: {
        cwd: request.cwd.replace(/\/+$/u, ''),
        grants: grants.grants,
        protectedDirectory: PI_PROTECTED_CONFIG_DIRECTORY,
      },
      resources: {
        skillsDirectory: PI_SKILLS_DIRECTORY,
        skills: [...new Set(skillNames)].sort(),
        agentDirectory: PI_AGENT_DIRECTORY,
      },
      env: { ...request.env },
      session,
    },
  };
}
