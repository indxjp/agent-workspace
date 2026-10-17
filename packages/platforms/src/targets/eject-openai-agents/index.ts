import type { PlatformCapabilities } from '@indx-workspace/contracts/platforms';

import type { PlatformTarget } from '../../port.js';
import { EjectOptionsSchema, type EjectOptions } from '../eject/project.js';
import { compileEjectOpenAiAgents } from './compile.js';

const EJECT_OPENAI_AGENTS_CAPABILITIES: PlatformCapabilities = {
  description: 'native',
  instructions: 'native',
  model: 'mapped',
  engine: 'mapped',
  permissions: 'mapped',
  mcpRemote: 'native',
  mcpStdio: 'native',
  codeTools: 'native',
  openapiTools: 'unsupported',
  builtinTools: 'mapped',
  skills: 'unsupported',
  knowledgeFiles: 'unsupported',
  knowledgeUrls: 'unsupported',
  knowledgeConnectors: 'unsupported',
  subagents: 'mapped',
  limits: 'mapped',
};

/** A standalone TypeScript project that runs the agent on the OpenAI Agents SDK. */
export const ejectOpenAiAgentsTarget: PlatformTarget<EjectOptions> = {
  id: 'eject-openai-agents',
  displayName: 'OpenAI Agents SDK project',
  docsUrl: 'https://openai.github.io/openai-agents-js/',
  capabilities: EJECT_OPENAI_AGENTS_CAPABILITIES,
  optionsSchema: EjectOptionsSchema,
  compile: compileEjectOpenAiAgents,
};
