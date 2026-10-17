import type { PlatformTarget } from '../../port.js';
import { compileGeminiEnterprise } from './compile.js';
import { GeminiEnterpriseOptionsSchema, type GeminiEnterpriseOptions } from './options.js';

export { GeminiEnterpriseOptionsSchema, type GeminiEnterpriseOptions } from './options.js';
export {
  GeminiAgentRegistrationSchema,
  buildRegistrationRequest,
  type GeminiAgentRegistration,
  type GeminiRegistrationRequest,
} from './registration.js';

/**
 * Gemini Enterprise: registers the root agent as a remote A2A v0.3 agent. Emits the Agent Card
 * (`agent-card.json`) built by the contracts card builder and the REST request
 * (`register-agent.request.json`) that creates the registration; the agent keeps running on the
 * Agent Workspace deployment, so almost nothing is dropped.
 *
 * Compile only, by design: a registration holds just a card pointing at a remote endpoint, with
 * no instructions, tools or skills to recover, so there is no importer. A root with no
 * description gets a generated card description, and the report says so with a `mapped` verdict
 * on `<root>.description`.
 *
 * The card's keys are pinned to the A2A v0.3.0 spec fixture in contracts, and the registration body
 * to `__golden__/vendor-fixtures/SOURCE.md`.
 */
export const geminiEnterpriseTarget: PlatformTarget<GeminiEnterpriseOptions> = {
  id: 'gemini-enterprise',
  displayName: 'Gemini Enterprise',
  docsUrl: 'https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-a2a-agent',
  capabilities: {
    description: 'native',
    instructions: 'mapped',
    model: 'mapped',
    engine: 'mapped',
    permissions: 'mapped',
    mcpRemote: 'mapped',
    mcpStdio: 'unsupported',
    codeTools: 'mapped',
    openapiTools: 'mapped',
    builtinTools: 'mapped',
    skills: 'mapped',
    knowledgeFiles: 'mapped',
    knowledgeUrls: 'mapped',
    knowledgeConnectors: 'mapped',
    subagents: 'mapped',
    limits: 'mapped',
  },
  optionsSchema: GeminiEnterpriseOptionsSchema,
  compile: compileGeminiEnterprise,
};
