import { z } from 'zod';

/**
 * The **engines** a deployment can run an agent on (ADR-0065). An engine is the harness that turns
 * an agent definition and a prompt into model calls, tool calls and a stream of events.
 *
 * This is deliberately not the same word as a *model provider*. `runs.provider` and
 * `MODEL_PROVIDERS` (`./runs.ts`) name who serves the model; the list here names what runs the
 * agent loop. `AgentPolicy` is discriminated by {@link EngineIdSchema}, so a second engine is an
 * added arm rather than a renamed field.
 *
 * `claude-agent-sdk`; since ENG-09 (#308, ADR-0074), `openai-agents`; since ENG-08 (#307,
 * ADR-0081), `pi`; and since ENG-10 (#309, ADR-0084), `mastra`. Later units append — the order is the wire order and is not re-sorted, because `formal/AgentWorkspace/Contracts/Engines.lean`
 * transcribes it position by position.
 */
export const ENGINE_IDS = ['claude-agent-sdk', 'openai-agents', 'pi', 'mastra'] as const;
export type EngineId = (typeof ENGINE_IDS)[number];
export const EngineIdSchema = z.enum(ENGINE_IDS);

/** The engine an agent with no stored policy runs on (ADR-0065). The one spelling of the default. */
export const DEFAULT_ENGINE_ID = 'claude-agent-sdk' satisfies EngineId;

/** Whether `value` is an engine id the contracts publish. */
export function isEngineId(value: string): value is EngineId {
  return EngineIdSchema.safeParse(value).success;
}

/**
 * The HTTP dialect an engine speaks to reach the gateway. Today every engine speaks
 * `anthropic-messages`; the other two are the ingresses the gateway serves (#304) and exist here
 * so a capability can name a protocol an engine cannot yet be asked for.
 */
export const WIRE_PROTOCOLS = [
  'anthropic-messages',
  'openai-responses',
  'openai-chat-completions',
] as const;
export type WireProtocol = (typeof WIRE_PROTOCOLS)[number];
export const WireProtocolSchema = z.enum(WIRE_PROTOCOLS);

/**
 * Who enforces a limit: the engine itself (`native`) or the platform's adapter around it
 * (`adapter`). `maxBudget` adds `none` because an engine may offer no place to enforce a budget at
 * all, in which case the cap is a workspace-level refusal rather than a per-run one.
 */
export const ENGINE_LIMIT_ENFORCEMENTS = ['native', 'adapter'] as const;
export type EngineLimitEnforcement = (typeof ENGINE_LIMIT_ENFORCEMENTS)[number];
export const EngineLimitEnforcementSchema = z.enum(ENGINE_LIMIT_ENFORCEMENTS);

export const ENGINE_BUDGET_ENFORCEMENTS = ['native', 'adapter', 'none'] as const;
export type EngineBudgetEnforcement = (typeof ENGINE_BUDGET_ENFORCEMENTS)[number];
export const EngineBudgetEnforcementSchema = z.enum(ENGINE_BUDGET_ENFORCEMENTS);

/**
 * What one engine can honour of the platform's portable agent configuration (#299's "portable core
 * vs engine-native" table).
 *
 * Every field answers a question the control plane must be able to ask *before* a run starts, so
 * that an agent whose configuration an engine cannot honour is **refused, never silently
 * narrowed**: an agent with connectors on an engine whose `mcp` is `false` is a typed refusal, not
 * a run without its connectors. The refusal itself arrives in a later unit; this contract is the
 * vocabulary it is stated in.
 *
 * `wireProtocols` is non-empty: an engine that can reach no gateway ingress cannot run anything,
 * and `[]` would read as "any" to a careless consumer.
 */
export const EngineCapabilitiesSchema = z
  .object({
    /** MCP connectors can be handed to the engine. */
    mcp: z.boolean(),
    /** `SKILL.md` skills can be materialised for the engine. */
    skills: z.boolean(),
    /** A subagent the agent names can be delegated to within the run. */
    subagents: z.boolean(),
    /** A session can be continued from a previously reported engine session id. */
    resume: z.boolean(),
    /** A session can be branched from an earlier point rather than only continued. */
    fork: z.boolean(),
    /** A turn in flight can be cancelled without losing the session. */
    interrupt: z.boolean(),
    /** Assistant text arrives as deltas rather than only as whole messages. */
    streamingText: z.boolean(),
    /** The engine reports the model's reasoning separately from its answer. */
    reasoning: z.boolean(),
    maxTurns: EngineLimitEnforcementSchema,
    maxBudget: EngineBudgetEnforcementSchema,
    wireProtocols: z.array(WireProtocolSchema).min(1).readonly(),
  })
  .strict()
  .readonly();
export type EngineCapabilities = z.infer<typeof EngineCapabilitiesSchema>;

/**
 * One engine as a deployment offers it.
 *
 * `installed` is not decoration. A control plane knows the *catalogue* of engines the contracts
 * describe, while a runtime image carries only the adapters it was built with, so a descriptor can
 * legitimately be advertised as known-but-absent. `version` is the adapter's own version string,
 * opaque to the platform and reported for support rather than compared.
 */
export const EngineDescriptorSchema = z
  .object({
    id: EngineIdSchema,
    displayName: z.string().min(1),
    version: z.string().min(1),
    capabilities: EngineCapabilitiesSchema,
    installed: z.boolean(),
  })
  .strict()
  .readonly();
export type EngineDescriptor = z.infer<typeof EngineDescriptorSchema>;

/**
 * The capabilities an agent's *assignments* can demand of its engine, and therefore the values an
 * `engine_capability_unsupported` refusal names.
 *
 * These are the keys of {@link EngineCapabilitiesSchema} that a saved agent can already be in
 * breach of: a connector demands `mcp`, a skill demands `skills`, a subagent demands `subagents`.
 * The rest of the capability set describes what a *run* may ask for (`resume`, `interrupt`, a turn
 * cap …) and is not decided at save time, so naming it in this refusal would be a promise the
 * save-time check does not keep.
 */
export const ENGINE_CAPABILITY_KEYS = ['mcp', 'skills', 'subagents'] as const;
export type EngineCapabilityKey = (typeof ENGINE_CAPABILITY_KEYS)[number];
export const EngineCapabilityKeySchema = z.enum(ENGINE_CAPABILITY_KEYS);

/**
 * The body of `GET /api/engines` (ENG-02c): every engine this deployment registers, in the
 * catalogue's order.
 *
 * Enveloped rather than a bare array, as §4 of `docs/sdk/04-api-specification.md` requires of every
 * list route, so a later release can add a sibling field without changing the body's JSON type.
 * The SDK's `engines.list()` unwraps it, so a caller sees the array either way.
 */
export const EngineListResponseSchema = z
  .object({ engines: z.array(EngineDescriptorSchema).readonly() })
  .strict()
  .readonly();
export type EngineListResponse = z.infer<typeof EngineListResponseSchema>;

/**
 * Problem codes the engine vocabulary owns, with the status each one travels under.
 *
 * `unsupported_engine` is a `400`, not a `404`: the caller named an engine in a body it wrote, and
 * the fix is to name one this deployment registers. It replaces `unsupported_policy_provider`,
 * which spoke of a "policy provider" — a phrase that no longer names anything.
 *
 * `session_engine_mismatch` and `engine_capability_unsupported` are ADR-0065 D8's session pinning
 * and D3's "refuse, never ignore", each at the moment a request first meets it;
 * `engine_catalogue_invalid` guards the catalogue `GET /api/engines` publishes.
 */
export const ENGINE_PROBLEM_CODES = {
  /** A parseable body naming an engine this deployment does not register. */
  unsupported_engine: 400,
  /**
   * A run for an agent whose engine differs from the one its session is pinned to. `409`, because
   * nothing about the request is malformed: the session has a history and this run does not belong
   * to it. No run row is created, and the session keeps its engine — switching an existing session
   * to another engine is a non-goal of the engine programme, not an operation with a 4xx.
   */
  session_engine_mismatch: 409,
  /**
   * An agent whose assigned connectors or skills its engine cannot honour. `422`: the body is
   * well-formed and the engine is registered, and it is the *combination* with what this agent is
   * assigned that cannot be honoured. The refusal's `details` carries exactly one entry, an
   * {@link EngineCapabilityKey}, so a client branches on the capability rather than on prose.
   */
  engine_capability_unsupported: 422,
  /**
   * A run whose engine speaks no wire protocol the gateway serves for its model connection's
   * provider (ENG-04, #303).
   *
   * `422` and not `400`, for the same reason `engine_capability_unsupported` is: the request is
   * well-formed, the engine is registered and the model connection is ready — it is the
   * *combination* that cannot be served. An engine reaches its model through the gateway, so an
   * engine that speaks only `anthropic-messages` pointed at a connection the gateway can only
   * forward `openai-responses` to is a run that would fail at its first model call, minutes in,
   * with a provider error nobody can act on. Deciding it at compose turns that into one sentence
   * before any runtime is asked for anything.
   *
   * Today it is delivered as the run's failure rather than as an HTTP response: the model
   * connection is resolved while the run is composed, after its row exists, so the run is recorded
   * `failed` with a public error that begins `engine_model_protocol_unsupported: ` and continues
   * with the reason. The `422` is the status a route-level check answers once the connection is
   * resolved before the row is written.
   */
  engine_model_protocol_unsupported: 422,
  /**
   * A run for an engine this deployment has no runtime image for (ENG-07, #306).
   *
   * `422`, and answered **before any run row exists and before any sandbox is created**: the body
   * is well-formed, the engine is published, the agent is saved — what is missing is an image this
   * deployment configured, and that is a fact about the deployment rather than about the request.
   * It is the same code the runner's `/run` answers for an image that turned out not to carry the
   * adapter it was supposed to (`packages/engine`'s `EngineRefusalCode`), deliberately: the two are
   * one condition observed at two distances, and a caller that learns to handle it in a stream
   * should not have to learn a second name for it at the route.
   *
   * The route can answer it early because `installed` and this refusal read the same configured
   * `engine → image` map (`apps/web/server/engines/images.ts`), so `GET /api/engines` and the run
   * route cannot disagree about which engines a deployment offers.
   */
  engine_not_installed: 422,
  /**
   * This deployment registered an engine {@link EngineDescriptorSchema} cannot express, so the
   * catalogue cannot be published. A `500`, and deliberately not a filtered `200`: dropping the
   * offending descriptor would answer "these are the engines" with a list that is not, and the
   * caller's next decision — which engine to put on an agent — would be taken against it.
   */
  engine_catalogue_invalid: 500,
} as const;
export type EngineProblemCode = keyof typeof ENGINE_PROBLEM_CODES;

// The engine catalogue (ADR-0136) is defined in its own module so that it can read the permission
// keys without a runtime cycle; its public names are published from here.
export {
  ENGINE_CATALOGUE,
  ENGINE_NARROWINGS,
  MCP_TOOL_NAME_FORMS,
  SESSION_STREAM_KEY_SCHEMES,
  engineSettingsSchema,
  isWithholdingEngine,
  mcpToolName,
  type EngineCatalogue,
  type EngineCatalogueEntry,
  type EngineNarrowing,
  type McpToolNameForm,
  type SessionStreamKeyScheme,
  type ToolRulesEngineId,
  type WithholdingEngineId,
} from './engine-catalogue.js';
