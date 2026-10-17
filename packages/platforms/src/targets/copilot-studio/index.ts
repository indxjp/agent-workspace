import type { PlatformTarget } from '../../port.js';
import { compileCopilotStudio } from './compile.js';
import { importCopilotStudio } from './import.js';
import { CopilotStudioOptionsSchema, type CopilotStudioOptions } from './options.js';

export { CopilotStudioOptionsSchema, type CopilotStudioOptions } from './options.js';

/**
 * Microsoft Copilot Studio, standard harness with generative orchestration: a `pac copilot`
 * workspace (`agent/`) plus one custom-connector definition per remote MCP server (`connectors/`).
 * The tenant-verified shapes and `connectionreferences.mcs.yml` are follow-ups (#970).
 */
export const copilotStudioTarget: PlatformTarget<CopilotStudioOptions> = {
  id: 'copilot-studio',
  displayName: 'Microsoft Copilot Studio',
  docsUrl:
    'https://learn.microsoft.com/en-us/microsoft-copilot-studio/visual-studio-code-extension-overview',
  capabilities: {
    description: 'mapped',
    instructions: 'native',
    model: 'mapped',
    engine: 'unsupported',
    permissions: 'mapped',
    mcpRemote: 'mapped',
    mcpStdio: 'unsupported',
    codeTools: 'mapped',
    openapiTools: 'unsupported',
    builtinTools: 'mapped',
    skills: 'unsupported',
    knowledgeFiles: 'native',
    knowledgeUrls: 'mapped',
    knowledgeConnectors: 'unsupported',
    subagents: 'mapped',
    limits: 'unsupported',
  },
  optionsSchema: CopilotStudioOptionsSchema,
  compile: compileCopilotStudio,
  import: importCopilotStudio,
};
