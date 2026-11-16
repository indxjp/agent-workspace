import type { ModelProvider } from '@indx-workspace/contracts/runs';

// `starterFor` checks the starters root with `node:fs` (typed by `node-fs.d.ts`): `./project` is the
// Node-side subpath, used by aw and create, and this package carries no Node types.

import {
  MODEL_PROVIDER_CONFIG_RULES,
  type ModelConnectionConfigField,
} from '@indx-workspace/contracts/models';
import {
  SETUP_QUESTIONS,
  setupQuestionApplies,
  type CompleteSetupAnswers,
} from '@indx-workspace/contracts/setup';

import { ProjectRenderError } from './errors.js';
import { type ProjectFileMapping } from './writer.js';

/**
 * The header of a rendered `agent-workspace.yaml`, naming the variable the model key is read from.
 * No answer is a secret, and no key is written.
 */
export function projectFileHeader(keyVariable: string, placeholders: boolean): readonly string[] {
  return [
    'The Agent Workspace project file: what `aw dev` runs, and where.',
    'No secret belongs in this file; it is meant to be committed.',
    `\`aw dev\` reads the model key from ${keyVariable} in its own environment.`,
    'To deploy to your Google Cloud project: add this under environments, then `aw deploy production`.',
    '  production: { target: gcp-cloudrun, url: https://<host>, gcp: { project: <id>, region: asia-northeast1 } }',
    ...(placeholders ? ['Replace each `your-` value under models.default before `aw dev`.'] : []),
  ];
}

/**
 * What a required model setting no question asks for is written as: a value that parses, and an
 * endpoint under `.example` (RFC 2606), which never resolves, so no request reaches a real host.
 */
const MODEL_CONFIG_PLACEHOLDERS: Readonly<
  Record<Exclude<ModelConnectionConfigField, 'baseUrl' | 'projectId' | 'location'>, string>
> = {
  deployment: 'your-deployment',
  apiVersion: 'your-api-version',
};

export function setupModelConfiguration(valid: CompleteSetupAnswers) {
  const provider = valid['admin.modelProvider'];
  const keyVariable = MODEL_KEY_VARIABLES[provider];
  const baseUrl = valid['admin.modelBaseUrl'];
  // `--yes` and an empty prompt line take the question's recommended endpoint, a host that never
  // resolves; refuse here rather than write one that only fails at the first model call.
  const required = MODEL_PROVIDER_CONFIG_RULES[provider].required;
  const baseUrlQuestion = SETUP_QUESTIONS.find((question) => question.id === 'admin.modelBaseUrl');
  const endpointAsked =
    baseUrlQuestion !== undefined && setupQuestionApplies(baseUrlQuestion, valid);
  if (
    (required.includes('baseUrl') || endpointAsked) &&
    (baseUrl === undefined || baseUrl === baseUrlQuestion?.recommended)
  ) {
    throw new ProjectRenderError('the setup answers', [
      {
        path: 'admin.modelBaseUrl',
        message: `--model-base-url is required when --provider is ${provider}`,
      },
    ]);
  }
  // The endpoint is the `admin.modelBaseUrl` answer; only the other required fields are placeholders.
  const placeholders = required.filter(
    (field): field is keyof typeof MODEL_CONFIG_PLACEHOLDERS => field !== 'baseUrl',
  );
  const models: ProjectFileMapping =
    provider === 'anthropic'
      ? {}
      : {
          models: {
            default: {
              provider,
              credential: { secret: keyVariable },
              ...(baseUrl === undefined ? {} : { baseUrl }),
              ...Object.fromEntries(
                placeholders.map((field) => [field, MODEL_CONFIG_PLACEHOLDERS[field]]),
              ),
            },
          },
        };
  return { models, keyVariable, hasPlaceholders: placeholders.length > 0 };
}

/** The environment variable each model provider's key is read from. */
export const MODEL_KEY_VARIABLES: Readonly<Record<Exclude<ModelProvider, 'vertex'>, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  'anthropic-compatible': 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
};
