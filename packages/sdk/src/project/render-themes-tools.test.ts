import { expect, it } from 'vitest';

import {
  SETUP_THEMES,
  THEME_RECOMMENDATIONS,
  withRecommendedAnswers,
  type SetupAnswers,
} from '@indx-workspace/contracts/setup';
import { selectAllowedOperations } from '@indx-workspace/contracts/tool-connectors';

import { setupSecretNames } from './render.js';
import {
  contentsOf,
  literalOf,
  ORDERS_ANSWERS,
  rendered,
  renderError,
} from './render.test-support.js';

it("writes the recommended theme support's instructions, greeting and prompts (#543)", () => {
  const files = rendered({});
  const { content } = THEME_RECOMMENDATIONS.support;
  const surface = contentsOf(files, 'surfaces/main.ts');
  expect(literalOf(contentsOf(files, 'agents/assistant.ts'), 'instructions')).toBe(
    content.instructions,
  );
  expect(literalOf(surface, 'greeting')).toBe(content.greeting);
  expect(surface).toContain(
    `  parts: {\n    greeting: 'Hi! How can I help you today?',\n    suggestedPrompts: [\n` +
      `      'I have a question about my account',\n`,
  );
  expect(contentsOf(files, 'agent-workspace.yaml')).toBe(
    contentsOf(rendered({ 'setup.theme': 'blank' }), 'agent-workspace.yaml'),
  );
});

it.each(SETUP_THEMES)('renders theme %s with prompts exactly when it has some', (theme) => {
  const surface = contentsOf(rendered({ 'setup.theme': theme }), 'surfaces/main.ts');
  const { content } = THEME_RECOMMENDATIONS[theme];
  expect(surface.includes('suggestedPrompts')).toBe(content.prompts.length > 0);
  expect(surface.includes('greeting')).toBe(content.greeting !== undefined);
});

it.each(['assistant', 'a-much-longer-agent-name'])(
  "aligns the starter README's file map once the agent is named %s (BH061-075)",
  (agentName) => {
    const readme = contentsOf(
      rendered({ 'setup.theme': 'automation', 'content.agentName': agentName }),
      'README.md',
    );
    const map = /```text\n([\s\S]*?)```/u.exec(readme)?.[1] ?? '';
    const columns = map
      .trimEnd()
      .split('\n')
      .map((line) => /^\S+ +/u.exec(line)?.[0].length);
    expect(new Set(columns).size).toBe(1);
  },
);

it('writes an OpenAPI tool the agent imports and lists, and names its secret (#543)', () => {
  const files = rendered(ORDERS_ANSWERS);
  expect(files.map((file) => file.path)).toStrictEqual([
    'agent-workspace.yaml',
    'agents/assistant.ts',
    'surfaces/main.ts',
    'tools/orders.ts',
    'README.md',
    'evals/assistant.yaml',
    'AGENTS.md',
    'skills/refund-policy/SKILL.md',
  ]);
  expect(contentsOf(files, 'tools/orders.ts')).toBe(
    `import { openapiTool, secret } from '@indx-workspace/sdk/define';

export default openapiTool({
  name: 'orders',
  spec: 'apis/orders.openapi.json',
  auth: secret('ORDERS_TOKEN'),
  allow: ['GET /**'],
});
`,
  );
  const agent = contentsOf(files, 'agents/assistant.ts');
  expect(agent).toContain(
    `from '@indx-workspace/sdk/define';\n\nimport ordersTool from '../tools/orders';\n\n`,
  );
  expect(agent).toContain('  tools: [\n    ordersTool,\n  ],\n');
  expect(setupSecretNames(withRecommendedAnswers(ORDERS_ANSWERS))).toStrictEqual([
    'ANTHROPIC_API_KEY',
    'ORDERS_TOKEN',
  ]);
});

it("admits a GET-only document's operation with every rule of the rendered allow list (#603)", () => {
  const rules = /allow: \[(.*)\],/.exec(
    contentsOf(rendered(ORDERS_ANSWERS), 'tools/orders.ts'),
  )?.[1];
  if (rules === undefined) throw new Error('tools/orders.ts renders no allow list');
  const allow = rules.split(', ').map((rule) => rule.slice(1, -1));
  const getOnly = [{ method: 'get', path: '/orders/{orderNumber}', operationId: 'getOrder' }];
  expect(selectAllowedOperations(allow, getOnly)).toStrictEqual({
    admitted: getOnly,
    refusals: [],
  });
});

it('names an OpenAPI tool after the last non-empty path segment of an https document', () => {
  const name = (document: string): readonly string[] =>
    setupSecretNames(
      withRecommendedAnswers({
        'content.internalTools': ['openapi'],
        'content.openapiDocument': document,
      }),
    );
  expect(name('https://api.example.com/v1/')).toContain('V1_TOKEN');
  expect(name('https://api.example.com')).toContain('API_TOKEN');
});

it('names an OpenAPI tool from an https document after its file name', () => {
  const answers = {
    'content.internalTools': ['openapi'],
    'content.openapiDocument': 'https://api.example.com/v1/billing.yaml?v=2',
  } as const satisfies SetupAnswers;
  expect(rendered(answers).map((file) => file.path)).toContain('tools/billing.ts');
  expect(setupSecretNames(withRecommendedAnswers(answers))).toStrictEqual([
    'ANTHROPIC_API_KEY',
    'BILLING_TOKEN',
  ]);
});

it('writes the PostgreSQL tool with its URL as the secret POSTGRES_URL', () => {
  const files = rendered({ ...ORDERS_ANSWERS, 'content.internalTools': ['openapi', 'postgres'] });
  expect(files.map((file) => file.path).slice(3, 5)).toStrictEqual([
    'tools/orders.ts',
    'tools/postgres.ts',
  ]);
  expect(contentsOf(files, 'tools/postgres.ts')).toContain(
    "  url: secret('POSTGRES_URL'),\n  readOnly: true,\n",
  );
  expect(contentsOf(files, 'agents/assistant.ts')).toContain(
    '  tools: [\n    ordersTool,\n    postgresTool,\n  ],\n',
  );
});

it.each(['aw', '2024'])('refuses the document %s.json, whose secret is refused', (name) => {
  const error = renderError(() =>
    rendered({ 'content.internalTools': ['openapi'], 'content.openapiDocument': `${name}.json` }),
  );
  expect(error.message).toContain(`tools/${name}.ts could not be rendered`);
});

it('switches on the permissions the answers name, in contract order', () => {
  const files = rendered({ 'content.permissions': ['runCommands', 'readFiles'] });
  expect(contentsOf(files, 'agents/assistant.ts')).toContain(
    '  permissions: {\n    readFiles: true,\n    runCommands: true,\n  },\n',
  );
});
