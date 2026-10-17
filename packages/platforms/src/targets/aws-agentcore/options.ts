import { z } from 'zod';

/** The AgentCore CLI's credential-name pattern; every portable `secretRef` is a subset of it. */
export const AGENTCORE_CREDENTIAL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/u;

/** The AWS partition a region belongs to; the partition is the second field of every ARN. */
export function partitionOf(region: string): 'aws' | 'aws-cn' | 'aws-us-gov' {
  if (region.startsWith('cn-')) return 'aws-cn';
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  return 'aws';
}

const GATEWAY_ARN_PATTERN = /^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:gateway\/.+$/u;

/**
 * Anthropic API id → Bedrock inference profile id. Only rows confirmed on an AWS page; anything
 * else needs `options.model`.
 */
export const BEDROCK_CLAUDE_MODEL_IDS: Readonly<Record<string, string>> = {
  // harness-models.md (the harness default)
  'claude-sonnet-4-6': 'global.anthropic.claude-sonnet-4-6',
  // aws/agentcore-cli@dd6304e examples/AgentCoreCliReviewer/app/PRReviewer/harness.json (verbatim
  // in vendor-fixtures/agentcore-cli-dd6304e/)
  'claude-opus-4-7': 'us.anthropic.claude-opus-4-7',
  // harness-models.md
  'claude-opus-4-5-20251101': 'us.anthropic.claude-opus-4-5-20251101-v1:0',
};

export const AwsAgentCoreOptionsSchema = z.strictObject({
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/u),
  accountId: z.string().regex(/^\d{12}$/u),
  /** Overrides the derived harness name (`support-triage` → `support_triage`). */
  harnessName: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/u)
    .optional(),
  /** Overrides the derived project name (`support-triage` → `SupportTriage`). */
  projectName: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]{0,22}$/u)
    .optional(),
  /** Overrides the model mapping entirely. */
  model: z
    .strictObject({
      provider: z.enum(['bedrock', 'open_ai', 'gemini', 'lite_llm']),
      modelId: z.string().min(1),
      apiKeyCredential: z.string().regex(AGENTCORE_CREDENTIAL_NAME_PATTERN).optional(),
    })
    .superRefine((model, context) => {
      if (
        (model.provider === 'open_ai' || model.provider === 'gemini') &&
        model.apiKeyCredential === undefined
      ) {
        context.addIssue({
          code: 'custom',
          path: ['apiKeyCredential'],
          message: `${model.provider} needs an API key credential`,
        });
      }
    })
    .optional(),
  /** `s3://bucket/prefix/`: the publish executor uploads the skills here. */
  skillsS3Uri: z
    .string()
    .regex(/^s3:\/\/[a-z0-9.-]{3,63}\/(?:[^/]+\/)*$/u)
    .optional(),
  /** A gateway that exposes the AgentCore Web Search connector (us-east-1 only). */
  webSearchGatewayArn: z.string().regex(GATEWAY_ARN_PATTERN).optional(),
  /** OpenAPI tool name → the gateway that already fronts that API as an OpenAPI target. */
  openapiGateways: z.record(z.string(), z.string().regex(GATEWAY_ARN_PATTERN)).optional(),
});
export type AwsAgentCoreOptions = z.infer<typeof AwsAgentCoreOptionsSchema>;
