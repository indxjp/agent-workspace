import { expect, it } from 'vitest';

import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';

import { parseProjectFile } from './parse.js';
import { setupSecretNames } from './render.js';
import { contentsOf, rendered } from './render.test-support.js';

it('writes no model connection for anthropic', () => {
  expect(contentsOf(rendered({}), 'agent-workspace.yaml')).not.toContain('models');
});

it('writes models.default for openai, with its key by secret reference', () => {
  const yaml = contentsOf(rendered({ 'admin.modelProvider': 'openai' }), 'agent-workspace.yaml');
  expect(yaml).toContain('# `aw dev` reads the model key from OPENAI_API_KEY in its own');
  // openai runs on the provider's own defaults: no endpoint, deployment or version is written.
  expect(yaml).not.toContain('your-');
  const { project } = parseProjectFile(yaml);
  expect('models' in project && project.models).toStrictEqual({
    default: { provider: 'openai', credential: { secret: 'OPENAI_API_KEY' } },
  });
  expect(setupSecretNames(withRecommendedAnswers({ 'admin.modelProvider': 'openai' }))).toEqual([
    'OPENAI_API_KEY',
  ]);
});

it('writes the endpoint answered with --model-base-url, not a placeholder', () => {
  const yaml = contentsOf(
    rendered({
      'admin.modelProvider': 'openai-compatible',
      'admin.modelBaseUrl': 'http://localhost:11434/v1',
    }),
    'agent-workspace.yaml',
  );
  expect(yaml).not.toContain('your-');
  const { project } = parseProjectFile(yaml);
  expect('models' in project && project.models).toStrictEqual({
    default: {
      provider: 'openai-compatible',
      credential: { secret: 'OPENAI_API_KEY' },
      baseUrl: 'http://localhost:11434/v1',
    },
  });
});

it('writes the endpoint for anthropic-compatible, which asks for one (BH061-044)', () => {
  const yaml = contentsOf(
    rendered({
      'admin.modelProvider': 'anthropic-compatible',
      'admin.modelBaseUrl': 'https://llm-proxy.example.com',
    }),
    'agent-workspace.yaml',
  );
  const { project } = parseProjectFile(yaml);
  expect('models' in project && project.models).toStrictEqual({
    default: {
      provider: 'anthropic-compatible',
      credential: { secret: 'ANTHROPIC_API_KEY' },
      baseUrl: 'https://llm-proxy.example.com',
    },
  });
});

it.each(['anthropic-compatible', 'openai-compatible', 'azure-openai'] as const)(
  'refuses %s without --model-base-url instead of writing a placeholder endpoint',
  (provider) => {
    expect(() => rendered({ 'admin.modelProvider': provider })).toThrow(
      `--model-base-url is required when --provider is ${provider}`,
    );
  },
);

it('writes placeholders for the settings azure-openai requires, and says so', () => {
  const yaml = contentsOf(
    rendered({
      'admin.modelProvider': 'azure-openai',
      'admin.modelBaseUrl': 'https://my-resource.openai.azure.com/',
    }),
    'agent-workspace.yaml',
  );
  expect(yaml).toContain('# Replace each `your-` value under models.default before `aw dev`.\n');
  const { project } = parseProjectFile(yaml);
  expect('models' in project && project.models).toStrictEqual({
    default: {
      provider: 'azure-openai',
      credential: { secret: 'AZURE_OPENAI_API_KEY' },
      baseUrl: 'https://my-resource.openai.azure.com/',
      apiVersion: 'your-api-version',
      deployment: 'your-deployment',
    },
  });
});
