import type { PlatformCapabilities } from '@indx-workspace/contracts/platforms';

import type { PlatformTarget } from '../../port.js';
import { compileClaudeManagedAgents } from './compile.js';
import { importClaudeManagedAgents } from './import.js';
import { ClaudeManagedAgentsOptionsSchema, type ClaudeManagedAgentsOptions } from './options.js';

export {
  AGENT_TOOLSET_TYPE,
  AW_TOOLS_SERVER_NAME,
  CREDENTIAL_PLAN_FILE,
  MAX_MCP_SERVERS_PER_AGENT,
  MAX_PREDEFINED_AGENTS,
  MCP_SERVER_NAME_MAX_LENGTH,
  MCP_SERVER_URL_MAX_LENGTH,
  MULTIAGENT_TYPE,
  compileClaudeManagedAgents,
} from './compile.js';
export { importClaudeManagedAgents };
export { ClaudeManagedAgentsOptionsSchema, type ClaudeManagedAgentsOptions };

const CAPABILITIES: PlatformCapabilities = {
  description: 'native',
  instructions: 'native',
  model: 'native',
  engine: 'unsupported',
  permissions: 'mapped',
  mcpRemote: 'native',
  mcpStdio: 'unsupported',
  codeTools: 'mapped',
  openapiTools: 'unsupported',
  builtinTools: 'mapped',
  skills: 'native',
  knowledgeFiles: 'unsupported',
  knowledgeUrls: 'unsupported',
  knowledgeConnectors: 'unsupported',
  subagents: 'native',
  limits: 'unsupported',
};

export const claudeManagedAgentsTarget: PlatformTarget<ClaudeManagedAgentsOptions> = {
  id: 'claude-managed-agents',
  displayName: 'Claude Managed Agents',
  docsUrl: 'https://platform.claude.com/docs/en/managed-agents/overview',
  capabilities: CAPABILITIES,
  optionsSchema: ClaudeManagedAgentsOptionsSchema,
  compile: compileClaudeManagedAgents,
  import: importClaudeManagedAgents,
};
