import type { PlatformCapabilities } from '@indx-workspace/contracts/platforms';

import type { PlatformTarget } from '../../port.js';
import { EjectOptionsSchema, type EjectOptions } from '../eject/project.js';
import { compileEjectMastra } from './compile.js';

const EJECT_MASTRA_CAPABILITIES: PlatformCapabilities = {
  description: 'native',
  instructions: 'native',
  model: 'mapped',
  engine: 'mapped',
  permissions: 'native',
  mcpRemote: 'native',
  mcpStdio: 'native',
  codeTools: 'native',
  openapiTools: 'unsupported',
  builtinTools: 'mapped',
  skills: 'native',
  knowledgeFiles: 'unsupported',
  knowledgeUrls: 'unsupported',
  knowledgeConnectors: 'unsupported',
  subagents: 'mapped',
  limits: 'mapped',
};

/** A standalone TypeScript project that runs the agent on Mastra. */
export const ejectMastraTarget: PlatformTarget<EjectOptions> = {
  id: 'eject-mastra',
  displayName: 'Mastra project',
  docsUrl: 'https://mastra.ai/reference/agents/agent',
  capabilities: EJECT_MASTRA_CAPABILITIES,
  optionsSchema: EjectOptionsSchema,
  compile: compileEjectMastra,
};
