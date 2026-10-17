import { PLATFORM_IDS } from '@indx-workspace/contracts/platforms';
import {
  PORTABLE_AGENT_API_VERSION,
  PORTABLE_AGENT_KIND,
  type PortableProjectInput,
} from '@indx-workspace/contracts/portable-agent';

const MODEL = { provider: 'anthropic', id: 'claude-sonnet-4-6' } as const;

/** The sample as a project that has no public tool endpoint, so a code tool has nowhere to run. */
export const SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT: PortableProjectInput = {
  root: 'support-triage',
  agents: [
    {
      apiVersion: PORTABLE_AGENT_API_VERSION,
      kind: PORTABLE_AGENT_KIND,
      name: 'support-triage',
      description: 'Triages customer support tickets and drafts replies.',
      instructions:
        'You triage support tickets.\n\n- Look up the order before answering.\n- Hand billing questions to billing-specialist.',
      model: MODEL,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      tools: [
        {
          kind: 'mcp',
          name: 'zendesk',
          transport: 'streamable-http',
          url: 'https://mcp.example.com/zendesk',
          auth: { scheme: 'bearer', secretRef: 'ZENDESK_TOKEN' },
        },
        { kind: 'mcp', name: 'local-git', transport: 'stdio', command: 'git-mcp' },
        {
          kind: 'code',
          name: 'get_order',
          description: 'Look up an order by its id',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
        {
          kind: 'openapi',
          name: 'orders-api',
          specRef: 'openapi/orders.json',
          allow: ['GET /orders/*'],
        },
        { kind: 'builtin', id: 'web_search' },
        { kind: 'builtin', id: 'code_execution' },
      ],
      skills: [{ name: 'refund-policy', path: 'skills/refund-policy' }],
      knowledge: [
        { kind: 'files', paths: ['knowledge/faq.md'] },
        { kind: 'url', url: 'https://help.example.com' },
      ],
      subagents: [{ name: 'billing-specialist' }],
      limits: { maxTurns: 20, maxBudgetUsd: 2 },
    },
    {
      apiVersion: PORTABLE_AGENT_API_VERSION,
      kind: PORTABLE_AGENT_KIND,
      name: 'billing-specialist',
      description: 'Answers billing and refund questions.',
      instructions: 'You answer billing questions using the refund-policy skill.',
      model: MODEL,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      skills: [{ name: 'refund-policy', path: 'skills/refund-policy' }],
    },
  ],
  skills: [
    {
      name: 'refund-policy',
      files: [
        {
          path: 'SKILL.md',
          content:
            '---\nname: refund-policy\ndescription: When and how to issue refunds\n---\nRefunds within 30 days are approved automatically.\n',
        },
      ],
    },
  ],
  knowledgeFiles: [{ path: 'knowledge/faq.md', content: '# FAQ\n\nOrders ship in 2 days.\n' }],
  openapiSpecs: [
    {
      ref: 'openapi/orders.json',
      content: '{"openapi":"3.1.0","info":{"title":"Orders","version":"1"},"paths":{}}',
    },
  ],
};

/**
 * The programme's shared sample: every platform unit (P2-P8) compiles this project, unchanged,
 * and keeps the result as its golden. It carries each tool kind and transport, each knowledge
 * kind, a skill, a subagent, limits and the public tool endpoint, so a translator has to give
 * every one of them a verdict.
 */
export const SAMPLE_PORTABLE_PROJECT: PortableProjectInput = {
  ...SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
  toolEndpoint: {
    url: 'https://aw.example.com/mcp/projects/acme-support',
    auth: { scheme: 'bearer', secretRef: 'ACME_TOOL_ENDPOINT_TOKEN' },
  },
};

/**
 * The sample's root agent with an `engine` preference, an engine extension and an extension block
 * for every platform. The kit compiles it to check the rules that the shared sample cannot reach:
 * `engine` and `extensions.engines.*` are dropped on a host that runs its own loop, and every
 * platform's extension block but the target's own is dropped. Each block holds a nested value,
 * which the schema does not freeze, so the kit also sees a compile that mutates its input.
 */
export const SAMPLE_PORTABLE_PROJECT_WITH_EXTENSIONS: PortableProjectInput = {
  ...SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
  agents: SAMPLE_PORTABLE_PROJECT.agents.map((agent, index) =>
    index === 0
      ? {
          ...agent,
          engine: 'claude-agent-sdk',
          extensions: {
            engines: { 'claude-agent-sdk': { effort: 'high' } },
            platforms: Object.fromEntries(PLATFORM_IDS.map((id) => [id, { nested: {} }])),
          },
        }
      : agent,
  ),
};
