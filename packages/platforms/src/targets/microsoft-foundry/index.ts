import type { PlatformCapabilities } from '@indx-workspace/contracts/platforms';

import type { PlatformTarget } from '../../port.js';
import { compileFoundry } from './compile.js';
import { importFoundry } from './import.js';
import { FoundryOptionsSchema, type FoundryOptions } from './wire.js';

export * from './wire.js';

const FOUNDRY_CAPABILITIES: PlatformCapabilities = {
  description: 'native',
  instructions: 'native',
  model: 'mapped',
  engine: 'unsupported',
  permissions: 'mapped',
  mcpRemote: 'native',
  mcpStdio: 'unsupported',
  codeTools: 'mapped',
  openapiTools: 'mapped',
  builtinTools: 'native',
  skills: 'unsupported',
  knowledgeFiles: 'mapped',
  knowledgeUrls: 'unsupported',
  knowledgeConnectors: 'unsupported',
  subagents: 'mapped',
  limits: 'unsupported',
};

/** Microsoft Foundry Agent Service prompt agents (hosted agents and Toolboxes are out of scope). */
export const microsoftFoundryTarget: PlatformTarget<FoundryOptions> = {
  id: 'microsoft-foundry',
  displayName: 'Microsoft Foundry Agent Service',
  docsUrl: 'https://learn.microsoft.com/en-us/azure/foundry/agents/overview',
  capabilities: FOUNDRY_CAPABILITIES,
  optionsSchema: FoundryOptionsSchema,
  compile: compileFoundry,
  import: importFoundry,
};
