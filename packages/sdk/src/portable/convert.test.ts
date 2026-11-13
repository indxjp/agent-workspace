import { expect, it } from 'vitest';

import { claudeBaseToolPolicyFor } from '@indx-workspace/contracts/agents';

import { ProjectDocumentSchema } from '@indx-workspace/contracts/project-file';
import {
  defineAgent,
  defineSurface,
  files,
  mcp,
  skill,
  toAgentVersionBody,
} from '../define/index.js';
import {
  portableFromAgentVersionBody,
  toPortableAgent,
  type PortableAgentContext,
} from './index.js';
import {
  claude,
  PROJECT,
  MINIMAL,
  getOrder,
  SAMPLE_PERMISSIONS,
  SAMPLE,
  bodyWith,
  namesOf,
  DIGEST,
  BUNDLE_KEYS,
} from './convert.fixture.test-support.js';

it('turns support-triage into the expected PortableAgent with no drops', () => {
  const { value, dropped } = toPortableAgent(SAMPLE, { project: PROJECT });
  expect(dropped).toEqual([]);
  expect(value).toEqual({
    apiVersion: 'agentworkspace.dev/v1',
    kind: 'Agent',
    name: 'support-triage',
    instructions: 'Triage tickets.',
    model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
    engine: claude,
    permissions: SAMPLE_PERMISSIONS,
    tools: [
      {
        kind: 'mcp',
        name: 'zendesk',
        transport: 'streamable-http',
        url: 'https://zendesk.example.com/mcp',
        auth: { scheme: 'bearer', secretRef: 'ZENDESK_TOKEN' },
      },
      {
        kind: 'openapi',
        name: 'orders-api',
        specRef: 'openapi/orders.json',
        allow: ['GET /orders/*'],
        baseUrl: 'https://api.example.com',
        auth: { secretRef: 'ORDERS_TOKEN' },
      },
      {
        kind: 'code',
        name: 'get_order',
        description: 'Look up an order by its id',
        inputSchema: getOrder.inputSchema,
      },
    ],
    skills: [{ name: 'refund-policy', path: 'skills/refund-policy' }],
    knowledge: [],
    subagents: [],
    limits: { maxTurns: 20, maxBudgetUsd: 1.5 },
    extensions: { engines: { [claude]: { tools: claudeBaseToolPolicyFor(SAMPLE_PERMISSIONS) } } },
  });
});

it('gives the model no provider when the project does not declare the connection', () => {
  const { value } = toPortableAgent(SAMPLE, {
    project: ProjectDocumentSchema.parse({ ...PROJECT, models: undefined }),
  });
  expect(value.model).toEqual({ id: 'claude-sonnet-4-6' });
});

it('is purity-safe: the input is not changed and the output is frozen', () => {
  const before = structuredClone(toAgentVersionBody(SAMPLE));
  const result = toPortableAgent(SAMPLE, { project: PROJECT });
  expect(toAgentVersionBody(SAMPLE)).toEqual(before);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.value)).toBe(true);
  expect(Object.isFrozen(result.dropped)).toBe(true);

  const dropping = toPortableAgent(defineAgent({ ...MINIMAL, files: [files('docs/a.md')] }));
  expect(dropping.dropped).toHaveLength(1);
  expect(Object.isFrozen(dropping.dropped[0])).toBe(true);
});

it('accounts for every field of the body: carried in value, or listed in dropped', () => {
  const surface = defineSurface({ name: 'main', agent: 'support-triage' });
  const agent = defineAgent({
    ...MINIMAL,
    name: 'support-triage',
    files: [files('docs/a.md')],
    tools: [mcp('zendesk')],
    skills: [skill('refund-policy')],
  });
  const body = bodyWith(
    toAgentVersionBody(agent, { surfaces: [surface] }),
    {
      agent: { ...toAgentVersionBody(agent).definition.agent, runtimeProfileName: 'profile' },
      resources: {
        ...toAgentVersionBody(agent).definition.resources,
        connectors: ['zendesk', 'aw-dev-tools'],
      },
    },
    {
      description: 'Triages tickets.',
      subagents: [{ name: 'billing' }],
      knowledge: [{ kind: 'connector', name: 'zendesk' }],
      toolBundles: [
        {
          tool: 'full_tool',
          digest: DIGEST,
          description: 'A code tool the agent uses.',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          timeoutMs: 1000,
          secrets: ['ORPHAN_TOKEN'],
          allowedDomains: ['api.example.com'],
        },
      ],
    },
  );
  const context: PortableAgentContext = { connectors: PROJECT.connectors };
  const { value, dropped } = portableFromAgentVersionBody(body, context);

  // A field not listed here fails the test, so a field added to the body needs a verdict.
  const verdicts: Record<string, 'carried' | 'dropped' | 'pin'> = {
    'definition.apiVersion': 'carried',
    'definition.kind': 'carried',
    'definition.policySource': 'carried',
    'definition.agent.name': 'carried',
    'definition.agent.instructions': 'carried',
    'definition.agent.permissions': 'carried',
    'definition.agent.model': 'carried',
    'definition.agent.modelConnectionName': 'carried',
    'definition.agent.runtimeProfileName': 'dropped',
    'definition.policy.engine': 'carried',
    'definition.policy.tools': 'carried',
    'definition.policy.skills': 'carried',
    'definition.policy.limits': 'carried',
    'definition.resources.files': 'dropped',
    'definition.resources.skills': 'carried',
    'definition.resources.connectors': 'carried',
    surfaces: 'dropped',
    description: 'carried',
    subagents: 'carried',
    knowledge: 'carried',
    'toolBundles.0.tool': 'carried',
    'toolBundles.0.digest': 'pin',
    'toolBundles.0.description': 'carried',
    'toolBundles.0.inputSchema': 'carried',
    'toolBundles.0.outputSchema': 'dropped',
    'toolBundles.0.timeoutMs': 'dropped',
    'toolBundles.0.secrets': 'dropped',
    'toolBundles.0.allowedDomains': 'dropped',
  };
  const leaves = Object.keys(body).flatMap((key): string[] => {
    if (key === 'definition') {
      return Object.entries(body.definition).flatMap(([part, field]) =>
        typeof field === 'object'
          ? Object.keys(field).map((name) => `definition.${part}.${name}`)
          : [`definition.${part}`],
      );
    }
    if (key === 'toolBundles') {
      return (body.toolBundles ?? []).flatMap((_bundle, index) =>
        BUNDLE_KEYS.map((name) => `toolBundles.${index}.${name}`),
      );
    }
    return [key];
  });
  for (const leaf of leaves) {
    const verdict = verdicts[leaf];
    expect(verdict, `${leaf} has no verdict`).toBeDefined();
    if (verdict === 'dropped') {
      expect(
        dropped.some(
          (entry) =>
            entry.path === leaf ||
            entry.path.startsWith(`${leaf}.`) ||
            leaf.startsWith(`${entry.path}.`),
        ),
        `${leaf} is not in dropped`,
      ).toBe(true);
    }
  }
  // The fixture bundle sets every field, so each one's verdict is exercised.
  expect(Object.keys(body.toolBundles?.[0] ?? {}).sort()).toEqual([...BUNDLE_KEYS].sort());
  expect(namesOf(value.tools)).toEqual(['zendesk', 'full_tool']);
  expect(value.description).toBe('Triages tickets.');
  expect(value.subagents).toEqual([{ name: 'billing' }]);
  expect(value.knowledge).toEqual([{ kind: 'connector', name: 'zendesk' }]);
  expect(dropped.map((entry) => entry.path).sort()).toEqual([
    'definition.agent.runtimeProfileName',
    'definition.resources.files.0',
    'surfaces.0',
    'toolBundles.0.allowedDomains',
    'toolBundles.0.outputSchema',
    'toolBundles.0.secrets',
    'toolBundles.0.timeoutMs',
  ]);
});
