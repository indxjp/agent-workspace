import type { PlatformCapabilities } from '@indx-workspace/contracts/platforms';

import type { PlatformTarget } from '../../port.js';
import { compileM365DeclarativeAgent, M365_DECLARATIVE_AGENT_ID } from './compile.js';
import { importM365DeclarativeAgent } from './import.js';
import { M365DeclarativeAgentOptionsSchema, type M365DeclarativeAgentOptions } from './options.js';

export { M365DeclarativeAgentOptionsSchema, type M365DeclarativeAgentOptions };

const CAPABILITIES: PlatformCapabilities = {
  description: 'native',
  instructions: 'native',
  model: 'unsupported',
  engine: 'unsupported',
  permissions: 'mapped',
  mcpRemote: 'mapped',
  mcpStdio: 'unsupported',
  codeTools: 'mapped',
  openapiTools: 'mapped',
  builtinTools: 'mapped',
  skills: 'unsupported',
  knowledgeFiles: 'unsupported',
  knowledgeUrls: 'mapped',
  knowledgeConnectors: 'unsupported',
  subagents: 'unsupported',
  limits: 'unsupported',
};

/** Compiles to an Agents Toolkit project (declarative agent v1.8, API plugin manifests v2.4, Teams app manifest 1.24) and reads one back. */
export const m365DeclarativeAgentTarget: PlatformTarget<M365DeclarativeAgentOptions> = {
  id: M365_DECLARATIVE_AGENT_ID,
  displayName: 'Microsoft 365 Copilot declarative agent',
  docsUrl:
    'https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/declarative-agent-manifest-1.8',
  capabilities: CAPABILITIES,
  optionsSchema: M365DeclarativeAgentOptionsSchema,
  compile: compileM365DeclarativeAgent,
  import: importM365DeclarativeAgent,
};
