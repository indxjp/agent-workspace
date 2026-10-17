/**
 * The A2A v0.3 wire contracts a published agent speaks (ADR-0135).
 *
 * Strict for what the control plane emits; `.passthrough()` for what it accepts from external
 * clients, because A2A is a deliberately extensible external protocol and a client that adds a
 * field must not be refused for it. Every field the server reads is still validated.
 */
import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';

/**
 * The card's `protocolVersion`. Verified against A2A v0.3.0
 * (`__fixtures__/a2a-spec.v0_3_0.agent-card.json`): the field is a free string whose default is
 * '0.3.0'. We emit that default, which is also what Google's REST registration examples for
 * Gemini Enterprise use (only its console sample shows '0.3').
 * P8 and U3b read this constant; change only here.
 */
export const A2A_PROTOCOL_VERSION = '0.3.0';

const MetadataSchema = z.record(z.string(), z.unknown());

export const A2aTextPartSchema = z.object({
  kind: z.literal('text'),
  text: z.string(),
  metadata: MetadataSchema.optional(),
});
export type A2aTextPart = z.infer<typeof A2aTextPartSchema>;

/** File and data parts are parsed only so they can be refused with `-32005`. */
const A2aOtherPartSchema = z.object({ kind: z.enum(['file', 'data']) }).passthrough();

export const A2aPartSchema = z.union([A2aTextPartSchema, A2aOtherPartSchema]);
export type A2aPart = z.infer<typeof A2aPartSchema>;

export const A2aMessageSchema = z
  .object({
    kind: z.literal('message'),
    messageId: z.string().min(1).max(256),
    role: z.enum(['user', 'agent']),
    parts: z.array(A2aPartSchema).min(1).max(64),
    contextId: z.string().optional(),
    taskId: z.string().optional(),
    metadata: MetadataSchema.optional(),
  })
  .passthrough();
export type A2aMessage = z.infer<typeof A2aMessageSchema>;

/** A message the server emits: text parts only. */
export const A2aAgentMessageSchema = z
  .object({
    kind: z.literal('message'),
    messageId: z.string().min(1),
    role: z.enum(['user', 'agent']),
    parts: z.array(A2aTextPartSchema).min(1),
    contextId: z.string().optional(),
    taskId: z.string().optional(),
  })
  .strict();
export type A2aAgentMessage = z.infer<typeof A2aAgentMessageSchema>;

export const A2A_TASK_STATES = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'canceled',
  'failed',
  'rejected',
  'auth-required',
  'unknown',
] as const;
export const A2aTaskStateSchema = z.enum(A2A_TASK_STATES);
export type A2aTaskState = z.infer<typeof A2aTaskStateSchema>;

export const A2aTaskStatusSchema = z
  .object({
    state: A2aTaskStateSchema,
    message: A2aAgentMessageSchema.optional(),
    timestamp: IsoDateTimeSchema.optional(),
  })
  .strict();
export type A2aTaskStatus = z.infer<typeof A2aTaskStatusSchema>;

export const A2aArtifactSchema = z
  .object({
    artifactId: z.string(),
    name: z.string().optional(),
    parts: z.array(A2aTextPartSchema).min(1),
  })
  .strict();
export type A2aArtifact = z.infer<typeof A2aArtifactSchema>;

export const A2aTaskSchema = z
  .object({
    kind: z.literal('task'),
    id: z.string(),
    contextId: z.string(),
    status: A2aTaskStatusSchema,
    artifacts: z.array(A2aArtifactSchema).optional(),
    history: z.array(A2aAgentMessageSchema).optional(),
  })
  .strict();
export type A2aTask = z.infer<typeof A2aTaskSchema>;

export const A2aStatusUpdateEventSchema = z
  .object({
    kind: z.literal('status-update'),
    taskId: z.string(),
    contextId: z.string(),
    status: A2aTaskStatusSchema,
    final: z.boolean(),
  })
  .strict();
export type A2aStatusUpdateEvent = z.infer<typeof A2aStatusUpdateEventSchema>;

export const A2aArtifactUpdateEventSchema = z
  .object({
    kind: z.literal('artifact-update'),
    taskId: z.string(),
    contextId: z.string(),
    artifact: A2aArtifactSchema,
    append: z.boolean().optional(),
    lastChunk: z.boolean().optional(),
  })
  .strict();
export type A2aArtifactUpdateEvent = z.infer<typeof A2aArtifactUpdateEventSchema>;

export const A2aMessageSendParamsSchema = z
  .object({
    message: A2aMessageSchema,
    configuration: z
      .object({
        acceptedOutputModes: z.array(z.string()).optional(),
        historyLength: z.number().int().min(0).max(100).optional(),
        pushNotificationConfig: z.unknown().optional(),
        blocking: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    metadata: MetadataSchema.optional(),
  })
  .passthrough();
export type A2aMessageSendParams = z.infer<typeof A2aMessageSendParamsSchema>;

export const A2aTaskQueryParamsSchema = z
  .object({
    id: z.string().min(1),
    historyLength: z.number().int().min(0).max(100).optional(),
  })
  .passthrough();

export const A2aTaskIdParamsSchema = z.object({ id: z.string().min(1) }).passthrough();

const A2aJsonRpcIdSchema = z.union([z.string(), z.number().int(), z.null()]);

export const A2aJsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: A2aJsonRpcIdSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();
export type A2aJsonRpcRequest = z.infer<typeof A2aJsonRpcRequestSchema>;

/** One JSON-RPC answer: a `message/send` body, or the `data:` of one `message/stream` frame. */
export const A2aJsonRpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: A2aJsonRpcIdSchema, result: z.unknown() }).strict(),
  z
    .object({
      jsonrpc: z.literal('2.0'),
      id: A2aJsonRpcIdSchema,
      error: z
        .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
        .strict(),
    })
    .strict(),
]);
export type A2aJsonRpcResponse = z.infer<typeof A2aJsonRpcResponseSchema>;

export const A2A_ERROR_CODES = {
  parse_error: -32700,
  invalid_request: -32600,
  method_not_found: -32601,
  invalid_params: -32602,
  internal_error: -32603,
  task_not_found: -32001,
  task_not_cancelable: -32002,
  push_notification_not_supported: -32003,
  unsupported_operation: -32004,
  content_type_not_supported: -32005,
} as const;

export const A2aAgentCardSchema = z
  .object({
    protocolVersion: z.literal(A2A_PROTOCOL_VERSION),
    name: z.string().min(1),
    description: z.string().min(1),
    url: z.string().url(),
    preferredTransport: z.literal('JSONRPC'),
    version: z.string().min(1),
    capabilities: z
      .object({ streaming: z.literal(true), pushNotifications: z.literal(false) })
      .strict(),
    defaultInputModes: z.array(z.string()).min(1),
    defaultOutputModes: z.array(z.string()).min(1),
    skills: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            tags: z.array(z.string()),
            examples: z.array(z.string().min(1).max(500)).max(10).optional(),
          })
          .strict(),
      )
      .min(1),
    securitySchemes: z
      .object({
        awBearer: z.object({ type: z.literal('http'), scheme: z.literal('bearer') }).strict(),
      })
      .strict(),
    security: z.array(z.object({ awBearer: z.array(z.string()).length(0) }).strict()).length(1),
  })
  .strict();
export type A2aAgentCard = z.infer<typeof A2aAgentCardSchema>;

/**
 * Pure; the one card builder the control plane serves and the gemini-enterprise translator (P8) emits.
 * `name` is the agent's identifier (skill id, generated description); `displayName` only relabels the
 * card and its skill.
 */
export function buildA2aAgentCard(input: {
  readonly name: string;
  readonly displayName?: string;
  readonly description: string | null;
  readonly url: string;
  readonly version: string;
  readonly examples?: readonly string[];
}): A2aAgentCard {
  const description = input.description ?? `${input.name} — an Agent Workspace agent`;
  const label = input.displayName ?? input.name;
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: label,
    description,
    url: input.url,
    preferredTransport: 'JSONRPC',
    version: input.version,
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: input.name,
        name: label,
        description,
        tags: ['agent-workspace'],
        ...(input.examples === undefined ? {} : { examples: [...input.examples] }),
      },
    ],
    securitySchemes: { awBearer: { type: 'http', scheme: 'bearer' } },
    security: [{ awBearer: [] }],
  };
}
