import type { PlatformCapabilities } from '@indx-workspace/contracts/platforms';

import type { PlatformTarget } from '../../port.js';
import { compileAwsAgentCore } from './compile.js';
import { importAwsAgentCore } from './import.js';
import { AwsAgentCoreOptionsSchema, type AwsAgentCoreOptions } from './options.js';

export { BEDROCK_CLAUDE_MODEL_IDS, AwsAgentCoreOptionsSchema } from './options.js';
export type { AwsAgentCoreOptions } from './options.js';

export const AWS_AGENTCORE_CAPABILITIES: PlatformCapabilities = {
  description: 'unsupported',
  instructions: 'native',
  model: 'mapped',
  engine: 'unsupported',
  permissions: 'mapped',
  mcpRemote: 'native',
  mcpStdio: 'unsupported',
  codeTools: 'mapped',
  openapiTools: 'mapped',
  builtinTools: 'mapped',
  skills: 'mapped',
  knowledgeFiles: 'unsupported',
  knowledgeUrls: 'unsupported',
  knowledgeConnectors: 'unsupported',
  subagents: 'unsupported',
  limits: 'mapped',
};

/** The platform id and the `aws-agentcore` runtime driver id are separate namespaces (ADR-0133 D1). */
export const awsAgentCoreTarget: PlatformTarget<AwsAgentCoreOptions> = {
  id: 'aws-agentcore',
  displayName: 'AWS Bedrock AgentCore (harness)',
  docsUrl: 'https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.md',
  capabilities: AWS_AGENTCORE_CAPABILITIES,
  optionsSchema: AwsAgentCoreOptionsSchema,
  compile: compileAwsAgentCore,
  import: importAwsAgentCore,
};
