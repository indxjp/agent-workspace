import type { PlatformCapabilities } from '@indx-workspace/contracts/platforms';

import type { PlatformTarget } from '../../port.js';
import { EjectOptionsSchema, type EjectOptions } from '../eject/project.js';
import { compileEjectClaude } from './compile.js';

const EJECT_CLAUDE_CAPABILITIES: PlatformCapabilities = {
  description: 'mapped',
  instructions: 'native',
  model: 'native',
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
  limits: 'native',
};

/** A standalone TypeScript project that runs the agent on the Claude Agent SDK. */
export const ejectClaudeAgentSdkTarget: PlatformTarget<EjectOptions> = {
  id: 'eject-claude-agent-sdk',
  displayName: 'Claude Agent SDK project',
  docsUrl: 'https://code.claude.com/docs/en/agent-sdk/typescript',
  capabilities: EJECT_CLAUDE_CAPABILITIES,
  optionsSchema: EjectOptionsSchema,
  compile: compileEjectClaude,
};
