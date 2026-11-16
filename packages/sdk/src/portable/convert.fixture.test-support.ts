import {
  AgentVersionBodySchema,
  AgentVersionToolBundleSchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';

import { ENGINE_IDS } from '@indx-workspace/contracts/engines';
import type { PortableAgentInput } from '@indx-workspace/contracts/portable-agent';
import {
  ProjectDocumentSchema,
  type ProjectDocument,
} from '@indx-workspace/contracts/project-file';
import {
  DefinitionError,
  defineAgent,
  defineTool,
  mcp,
  openapiTool,
  secret,
  skill,
  toAgentVersionBody,
  toolDefinitionsOf,
  z,
  type DefineAgentInput,
  type OpenApiToolDefinition,
} from '../define/index.js';
import { defineAgentFromPortable, type PortableAgentContext } from './index.js';
const [claude, openai, pi, mastra] = ENGINE_IDS;
export { claude, openai, pi, mastra };

export const NO_PERMISSIONS = {
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

export const ALL_PERMISSIONS = {
  readFiles: true,
  writeFiles: true,
  runCommands: true,
  unrestrictedNetwork: true,
};

export const PROJECT: ProjectDocument = ProjectDocumentSchema.parse({
  apiVersion: 'agentworkspace.dev/v2',
  kind: 'Project',
  name: 'support-desk',
  models: {
    anthropic: { provider: 'anthropic', credential: { secret: 'ANTHROPIC_API_KEY' } },
    'azure-gpt': {
      provider: 'azure-openai',
      credential: { secret: 'AZURE_KEY' },
      baseUrl: 'https://azure.example.com',
      deployment: 'gpt',
      apiVersion: '2024-01-01',
    },
    'claude-eu': { provider: 'anthropic', credential: { secret: 'EU_KEY' } },
  },
  connectors: {
    zendesk: {
      url: 'https://zendesk.example.com/mcp',
      auth: { scheme: 'bearer', credential: { secret: 'ZENDESK_TOKEN' } },
    },
    events: { url: 'https://events.example.com/sse', transport: 'sse' },
    plain: { url: 'https://plain.example.com/mcp', transport: 'http' },
    keyed: {
      url: 'https://keyed.example.com/mcp',
      auth: { scheme: 'api-key', credential: { secret: 'KEYED_TOKEN' } },
    },
  },
  environments: {
    local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } },
  },
});

export const MINIMAL: DefineAgentInput = { name: 'assistant', instructions: 'Answer briefly.' };

export const getOrder = defineTool({
  name: 'get_order',
  description: 'Look up an order by its id',
  input: z.object({ id: z.string() }),
  run: './tools/get-order.run.ts',
});

export const ordersApi = openapiTool({
  name: 'orders-api',
  spec: 'openapi/orders.json',
  allow: ['GET /orders/*'],
  baseUrl: 'https://api.example.com',
  auth: secret('ORDERS_TOKEN'),
});

export const SAMPLE_PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: true,
};

export const SAMPLE = defineAgent({
  name: 'support-triage',
  instructions: 'Triage tickets.',
  model: { connection: 'anthropic', id: 'claude-sonnet-4-6' },
  permissions: SAMPLE_PERMISSIONS,
  tools: [mcp('zendesk'), ordersApi, getOrder],
  skills: [skill('refund-policy')],
  limits: { maxTurns: 20, maxBudgetUsd: 1.5 },
});

export const BASE_BODY = toAgentVersionBody(defineAgent(MINIMAL));

export function bodyWith(
  body: AgentVersionBody,
  definition: Record<string, unknown>,
  rest: Record<string, unknown> = {},
): AgentVersionBody {
  return AgentVersionBodySchema.parse({
    ...body,
    ...rest,
    definition: { ...body.definition, ...definition },
  });
}

export function thrown(run: () => unknown): DefinitionError {
  try {
    run();
  } catch (error) {
    if (error instanceof DefinitionError) return error;
    throw error;
  }
  throw new Error('expected a DefinitionError');
}

export function namesOf(tools: readonly { readonly kind: string }[]): readonly string[] {
  return tools.flatMap((tool) =>
    'name' in tool && typeof tool.name === 'string' ? [tool.name] : [],
  );
}

export const DIGEST = 'a'.repeat(64);

export const BUNDLE_KEYS = Object.keys(AgentVersionToolBundleSchema.unwrap().shape);

export const ORDERS_DEFINITION: OpenApiToolDefinition = toolDefinitionsOf(
  defineAgent({ ...MINIMAL, tools: [ordersApi] }),
).flatMap((tool) => (tool.kind === 'openapi' ? [tool] : []))[0] as OpenApiToolDefinition;

export const PORTABLE: PortableAgentInput = {
  apiVersion: 'agentworkspace.dev/v1',
  kind: 'Agent',
  name: 'assistant',
  instructions: 'Answer briefly.',
  permissions: NO_PERMISSIONS,
};

export function fromPortable(
  extra: Partial<PortableAgentInput>,
  context?: Pick<PortableAgentContext, 'models'>,
) {
  return defineAgentFromPortable({ ...PORTABLE, ...extra }, context);
}
