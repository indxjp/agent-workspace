/**
 * The shape of one `mcpServers` entry (R-01 §9): what core stores and what every engine adapter
 * hands to its SDK. Declared here once, because `packages/contracts` is the package every adapter
 * and core already depend on.
 */
import { z } from 'zod';

export const McpToolPolicySchema = z
  .object({
    name: z.string().min(1),
    permission_policy: z.enum(['always_allow', 'always_ask', 'always_deny']).optional(),
    org_max_permission: z.enum(['allow', 'ask', 'blocked']).optional(),
  })
  .strict();

/** R-01 §9: `timeout` under 1000 ms is ignored by the SDK, so storing one is storing a lie. */
const McpTimeout = z.number().int().min(1000).optional();

export const McpStdioServerConfigSchema = z
  .object({
    type: z.literal('stdio').optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string().min(1), z.string()).optional(),
    timeout: McpTimeout,
    alwaysLoad: z.boolean().optional(),
  })
  .strict();

export const McpHttpServerConfigSchema = z
  .object({
    type: z.literal('http'),
    url: z.url(),
    headers: z.record(z.string().min(1), z.string()).optional(),
    tools: z.array(McpToolPolicySchema).optional(),
    timeout: McpTimeout,
    alwaysLoad: z.boolean().optional(),
  })
  .strict();

export const McpSseServerConfigSchema = McpHttpServerConfigSchema.extend({
  type: z.literal('sse'),
}).strict();

/**
 * R-01 §9: JSON config files accept `"streamable-http"` as an alias for `"http"`, but
 * `McpHttpServerConfigSchema` declares only `"http"` — *"so the platform must normalise to `http`
 * on save"*. Normalising here means a connector imported from a `.mcp.json` is stored in the one
 * spelling the SDK's type accepts.
 */
function normaliseMcpServerConfig(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record['type'] === 'streamable-http') return { ...record, type: 'http' };
  return value;
}

/** A stored record, with no alias normalisation: what an engine adapter validates. */
export const McpServerRecordSchema = z.union([
  McpHttpServerConfigSchema,
  McpSseServerConfigSchema,
  McpStdioServerConfigSchema,
]);

/** What a write accepts: a record, after the `streamable-http` alias is normalised to `http`. */
export const McpServerConfigSchema = z.preprocess(normaliseMcpServerConfig, McpServerRecordSchema);

export type McpServerRecord = z.infer<typeof McpServerRecordSchema>;
export type McpToolPolicy = z.infer<typeof McpToolPolicySchema>;
