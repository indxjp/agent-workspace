/**
 * The small provider contract printed by spec §10. Supporting wire shapes stay deliberately
 * open: provider adapters validate the fields they consume, while the gateway preserves the
 * Anthropic-compatible body for fields it does not interpret.
 */

import type {
  ModelConnectionConfig,
  ModelConnectionConfigField,
} from '@indx-workspace/contracts/models';
import type { RegisteredProviderId } from './providers/registry.js';

export type ModelInfo = {
  id: string;
  type: 'model';
  display_name: string;
  created_at: string;
  [key: string]: unknown;
};

export type AnthropicMessageRequest = {
  model: string;
  [key: string]: unknown;
};

export type AnthropicCountTokensRequest = {
  model: string;
  [key: string]: unknown;
};

type AnthropicCountTokensResponse = {
  input_tokens: number;
};

/**
 * Values resolved from a short-lived gateway token. Provider credentials are supplied here by
 * the gateway authentication layer; provider modules never discover them from process.env.
 */
export type RequestContext = {
  providerId: RegisteredProviderId;
  credential: string;
  requestId: string;
  settings: ModelConnectionConfig;
  /**
   * Headers received from the gateway client for this operation.
   *
   * Providers must select protocol headers from this collection rather than forwarding it
   * wholesale: it also contains the caller's gateway credential, which must never reach the
   * upstream provider. Anthropic-format adapters use it to preserve the open `anthropic-*`
   * capability-header list required by Claude Code.
   */
  requestHeaders?: Headers;
  signal?: AbortSignal;
};

export type ModelCapabilities = {
  streaming: boolean;
  toolUse: boolean;
  thinking: boolean;
  promptCaching: boolean;
  structuredOutput: boolean;
  contextManagement: boolean;
  webSearch: boolean;
  tokenCounting: boolean;
};

export interface ModelProvider {
  id: string;

  listModels(context: RequestContext): Promise<ModelInfo[]>;

  createMessage(request: AnthropicMessageRequest, context: RequestContext): Promise<Response>;

  countTokens?(
    request: AnthropicCountTokensRequest,
    context: RequestContext,
  ): Promise<AnthropicCountTokensResponse>;

  capabilities: ModelCapabilities;
}

/**
 * The dialect a gateway client speaks at the front door, and the vocabulary of
 * `run_usage_records.wire_protocol`. Each value selects one usage extractor (ADR-0068 D5).
 */
export type WireProtocol = 'anthropic-messages' | 'openai-responses' | 'openai-chat-completions';

/** A relayed request body, already parsed and validated far enough to name its model. */
export type ForwardRequest = {
  model: string;
  [key: string]: unknown;
};

/**
 * Passthrough ingress for a dialect the gateway does not translate (ADR-0068 D3).
 *
 * Deliberately a sibling of {@link ModelProvider} rather than a member of it: spec §10 prints that
 * interface member-for-member, and the Anthropic path must not change to add a protocol. The router
 * probes for this interface structurally, so an adapter that does not implement a protocol is what
 * produces `400 protocol_not_supported_for_connection`.
 */
export interface WireProtocolForwarder {
  readonly forwards: ReadonlySet<WireProtocol>;
  forward(
    request: ForwardRequest,
    protocol: WireProtocol,
    context: RequestContext,
  ): Promise<Response>;
}

export type GatewayRoute = {
  readonly method: 'GET' | 'POST';
  readonly path:
    | '/v1/messages'
    | '/v1/messages/count_tokens'
    | '/v1/responses'
    | '/v1/chat/completions'
    | '/v1/models'
    | '/health'
    | '/v1/tools/:connectorId/mcp'
    | '/v1/tool-sandbox/mcp'
    | '/v1/tool-sandbox/endpoint/mcp';
};

export type GatewayRouter = {
  /** The complete public route table. W4-INT-00 compares this table with spec §9. */
  readonly routes: readonly GatewayRoute[];
  fetch(request: Request, context?: RequestContext): Promise<Response>;
};

/**
 * A provider answered a model-list request with a non-2xx status.
 *
 * Thrown by an adapter's `listModels` so the control plane can tell "the provider rejected the
 * key" (`401`/`403`) apart from a rate limit or an outage without parsing an error message. The
 * message names only the provider and the status — never the URL or the credential.
 */
export class ModelDiscoveryHttpError extends Error {
  public readonly status: number;

  public constructor(provider: string, status: number) {
    super(`${provider} model discovery returned HTTP ${String(status)}.`);
    this.name = 'ModelDiscoveryHttpError';
    this.status = status;
  }
}

/**
 * A stored model connection lacks a config field its provider requires (for example an Azure row
 * saved before `apiVersion` became mandatory). The router answers it with a typed 409. The message
 * names only the provider id and the field name, never a value.
 */
export class ModelConnectionIncompleteError extends Error {
  public readonly field: ModelConnectionConfigField;

  public constructor(provider: string, field: ModelConnectionConfigField) {
    super(
      `The ${provider} model connection is missing config.${field}; set it on the model connection and retry.`,
    );
    this.name = 'ModelConnectionIncompleteError';
    this.field = field;
  }
}
