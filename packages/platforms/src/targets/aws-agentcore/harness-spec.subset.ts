import { z } from 'zod';

/**
 * Test-only transcription of the keys this target emits from `HarnessSpecSchema`
 * (src/schema/schemas/primitives/harness.ts) and `AgentCoreProjectSpecSchema`
 * (src/schema/schemas/agentcore-project.ts) of github.com/aws/agentcore-cli at commit
 * dd6304eef85dac8135acb01579a1cf41313148e5 (v0.31.1), checked against those files:
 * https://github.com/aws/agentcore-cli/blob/dd6304eef85dac8135acb01579a1cf41313148e5/src/schema/schemas/primitives/harness.ts
 * It also accepts the keys of the verbatim example in vendor-fixtures/agentcore-cli-dd6304e/
 * (`dockerfile`, `tags`, the empty resource arrays), so that file parses with it. Upstream
 * `model` is required; this subset keeps it optional because compile omits it for an agent without
 * a model (see SOURCE.md).
 */
const ToolName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u);

const HarnessToolSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('remote_mcp'),
    name: ToolName,
    config: z.strictObject({
      remoteMcp: z.strictObject({
        url: z.url(),
        headers: z.record(z.string(), z.string()).optional(),
      }),
    }),
  }),
  z.strictObject({
    type: z.literal('agentcore_gateway'),
    name: ToolName,
    config: z.strictObject({
      agentCoreGateway: z.strictObject({
        gatewayArn: z.string().min(1),
        outboundAuth: z.strictObject({ awsIam: z.strictObject({}) }).optional(),
      }),
    }),
  }),
  z.strictObject({ type: z.literal('agentcore_code_interpreter'), name: ToolName }),
  z.strictObject({ type: z.literal('agentcore_browser'), name: ToolName }),
]);

export const HarnessSpecSubsetSchema = z
  .strictObject({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/u),
    model: z
      .strictObject({
        provider: z.enum(['bedrock', 'open_ai', 'gemini', 'lite_llm']),
        modelId: z.string().min(1),
        apiKeyArn: z.string().optional(),
        apiFormat: z.string().optional(),
        temperature: z.number().optional(),
        topP: z.number().optional(),
        maxTokens: z.number().int().min(1).optional(),
      })
      .optional(),
    systemPrompt: z.string().optional(),
    tools: z.array(HarnessToolSchema).optional(),
    skills: z.array(z.strictObject({ s3Uri: z.string().regex(/^s3:\/\//u) })).optional(),
    allowedTools: z
      .array(
        z
          .string()
          .max(64)
          .regex(/^(\*|@?[^/]+(\/[^/]+)?)$/u),
      )
      .optional(),
    memory: z.strictObject({ mode: z.enum(['managed', 'existing', 'disabled']) }).optional(),
    maxIterations: z.number().int().min(1).optional(),
    maxTokens: z.number().int().min(1).optional(),
    timeoutSeconds: z.number().int().min(1).optional(),
    dockerfile: z.string().min(1).optional(),
  })
  .superRefine((spec, context) => {
    const names = (spec.tools ?? []).map((tool) => tool.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: 'custom', path: ['tools'], message: 'tool names must be unique' });
    }
  });

/** Resource arrays this target never fills: the subset accepts them only empty. */
const NoResources = z.array(z.never()).optional();

export const AgentCoreProjectSubsetSchema = z.strictObject({
  $schema: z.literal('https://schema.agentcore.aws.dev/v1/agentcore.json'),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,22}$/u),
  version: z.literal(1),
  managedBy: z.literal('CDK'),
  tags: z.record(z.string(), z.string()).optional(),
  runtimes: NoResources,
  memories: NoResources,
  knowledgeBases: NoResources,
  evaluators: NoResources,
  onlineEvalConfigs: NoResources,
  agentCoreGateways: NoResources,
  policyEngines: NoResources,
  configBundles: NoResources,
  abTests: NoResources,
  datasets: NoResources,
  payments: NoResources,
  credentials: z.array(
    z.strictObject({
      authorizerType: z.literal('ApiKeyCredentialProvider'),
      name: z
        .string()
        .regex(/^[a-zA-Z0-9\-_]+$/u)
        .max(128),
    }),
  ),
  harnesses: z.array(z.strictObject({ name: z.string(), path: z.string() })),
});
