import { describe, expect, it } from 'vitest';

import { AGENT_INSTRUCTIONS_MAX_LENGTH, AGENT_PERMISSION_KEYS } from './agents.js';
import { ENGINE_IDS } from './engines.js';
import { HOSTED_PLATFORM_IDS } from './platform-ids.js';
import { MODEL_PROVIDERS } from './runs.js';
import {
  CompleteSetupAnswersSchema,
  HEX_COLOUR_PATTERN,
  SETUP_AUDIENCES,
  SETUP_FILE_PATHS,
  SETUP_PLATFORM_CHOICES,
  SETUP_QUESTIONS,
  SETUP_SANDBOX_OFFERED_CHOICES,
  SETUP_THEMES,
  SetupAnswersSchema,
  SURFACE_TITLE_PATTERN,
  setupQuestionApplies,
  unansweredSetupFlags,
  THEME_RECOMMENDATIONS,
  withRecommendedAnswers,
} from './setup.js';
import { SurfacePartsSchema } from './surfaces.js';

function questionFor(id: string) {
  const question = SETUP_QUESTIONS.find((candidate) => candidate.id === id);
  if (question === undefined) throw new Error(`no question ${id}`);
  return question;
}

describe('SETUP_QUESTIONS', () => {
  it('asks exactly twelve questions, in order', () => {
    expect(SETUP_QUESTIONS.map((question) => question.id)).toEqual([
      'setup.theme',
      'admin.sandbox',
      'admin.modelProvider',
      'admin.modelBaseUrl',
      'content.agentName',
      'content.engine',
      'content.internalTools',
      'content.openapiDocument',
      'content.permissions',
      'embedder.surfaceTitle',
      'embedder.brandColour',
      'admin.platforms',
    ]);
  });

  it('gives every question its own kebab-case flag', () => {
    expect(SETUP_QUESTIONS.map((question) => question.flag)).toEqual([
      'theme',
      'sandbox',
      'provider',
      'model-base-url',
      'agent',
      'engine',
      'tools',
      'openapi',
      'permissions',
      'title',
      'color',
      'platform',
    ]);
  });

  it('offers every hosted platform and none, and recommends none', () => {
    expect(SETUP_PLATFORM_CHOICES).toEqual([...HOSTED_PLATFORM_IDS, 'none']);
    const question = questionFor('admin.platforms');
    expect(question.answer).toEqual({
      kind: 'multi',
      choices: SETUP_PLATFORM_CHOICES,
      max: HOSTED_PLATFORM_IDS.length,
    });
    expect(question.recommended).toEqual(['none']);
    expect(SETUP_PLATFORM_CHOICES.some((choice) => choice.startsWith('eject-'))).toBe(false);
  });

  it('asks for the theme first and recommends support', () => {
    const [theme] = SETUP_QUESTIONS;
    expect(theme.answer).toEqual({ kind: 'choice', choices: SETUP_THEMES });
    expect(theme.recommended).toBe('support');
    expect(SETUP_THEMES).toEqual([
      'support',
      'copilot',
      'knowledge',
      'automation',
      'review',
      'blank',
    ]);
  });

  it('prefixes every id with its audience', () => {
    for (const question of SETUP_QUESTIONS) {
      expect(SETUP_AUDIENCES).toContain(question.audience);
      expect(question.id.startsWith(`${question.audience}.`)).toBe(true);
    }
  });

  it('names an earlier question in every condition', () => {
    const ids = SETUP_QUESTIONS.map((question) => question.id);
    SETUP_QUESTIONS.forEach((question, index) => {
      if (question.when === undefined) return;
      expect(ids.slice(0, index)).toContain(question.when.id);
    });
  });

  it('names only choices of the named question in every oneOf', () => {
    for (const question of SETUP_QUESTIONS) {
      if (question.when === undefined || !('oneOf' in question.when)) continue;
      const named = SETUP_QUESTIONS.find((candidate) => candidate.id === question.when?.id);
      expect(named?.answer.kind).toBe('choice');
      for (const entry of question.when.oneOf) {
        expect(named?.answer.kind === 'choice' && named.answer.choices).toContain(entry);
      }
    }
  });

  it('parses every recommended answer with its own schema and with SetupAnswersSchema', () => {
    for (const question of SETUP_QUESTIONS) {
      expect(question.schema.safeParse(question.recommended).success).toBe(true);
      const condition =
        question.when === undefined
          ? {}
          : {
              [question.when.id]:
                'oneOf' in question.when ? question.when.oneOf[0] : [question.when.includes],
            };
      expect(
        SetupAnswersSchema.safeParse({ ...condition, [question.id]: question.recommended }).success,
      ).toBe(true);
    }
  });

  it('parses every choice and keeps text answers inside their stated grammar', () => {
    for (const question of SETUP_QUESTIONS) {
      const { answer, recommended } = question;
      if (answer.kind === 'choice') {
        for (const choice of answer.choices) {
          expect(question.schema.safeParse(choice).success).toBe(true);
        }
      } else if (answer.kind === 'multi') {
        for (const choice of answer.choices) {
          expect(question.schema.safeParse([choice]).success).toBe(true);
        }
        expect(Array.isArray(recommended)).toBe(true);
        expect(recommended.length).toBeLessThanOrEqual(answer.max);
      } else {
        expect(typeof recommended).toBe('string');
        expect(answer.pattern.test(String(recommended))).toBe(true);
        expect(recommended.length).toBeLessThanOrEqual(answer.maxLength);
      }
    }
  });

  it('offers exactly the contracts engine ids', () => {
    const engine = questionFor('content.engine');
    expect(engine.answer).toEqual({ kind: 'choice', choices: ENGINE_IDS });
    expect(engine.recommended).toBe('claude-agent-sdk');
  });

  it('asks for a model endpoint only for the providers that cannot run without one', () => {
    const baseUrl = questionFor('admin.modelBaseUrl');
    expect(baseUrl.flag).toBe('model-base-url');
    for (const provider of MODEL_PROVIDERS) {
      const needs = ['anthropic-compatible', 'azure-openai', 'openai-compatible'].includes(
        provider,
      );
      expect(setupQuestionApplies(baseUrl, { 'admin.modelProvider': provider })).toBe(needs);
    }
    expect(setupQuestionApplies(baseUrl, {})).toBe(false);
  });

  it('accepts an http(s) endpoint, and refuses one that carries a credential or is no URL', () => {
    const baseUrl = questionFor('admin.modelBaseUrl');
    for (const good of ['https://models.example.com/v1', 'http://localhost:11434/v1']) {
      expect(baseUrl.schema.safeParse(good).success).toBe(true);
    }
    for (const bad of ['ftp://x.example/', 'https://user:pass@x.example/', 'not a url', '']) {
      expect(baseUrl.schema.safeParse(bad).success).toBe(false);
    }
    expect(
      SetupAnswersSchema.safeParse({
        'admin.modelProvider': 'openai',
        'admin.modelBaseUrl': 'https://models.example.com/v1',
      }).success,
    ).toBe(false);
  });

  it('offers exactly the model providers and recommends anthropic', () => {
    const provider = questionFor('admin.modelProvider');
    expect(provider.answer).toEqual({ kind: 'choice', choices: MODEL_PROVIDERS });
    expect(provider.recommended).toBe('anthropic');
  });

  it('offers exactly the permission keys, up to four, and recommends none', () => {
    const permissions = questionFor('content.permissions');
    expect(permissions.answer).toEqual({ kind: 'multi', choices: AGENT_PERMISSION_KEYS, max: 4 });
    expect(permissions.recommended).toEqual([]);
  });

  it('asks for the OpenAPI document only when openapi is chosen', () => {
    expect(questionFor('content.openapiDocument').when).toEqual({
      id: 'content.internalTools',
      includes: 'openapi',
    });
    expect(SETUP_FILE_PATHS).toContain('tools/<name>.ts');
  });

  it('recommends auto for the sandbox and writes only the project file', () => {
    const sandbox = questionFor('admin.sandbox');
    expect(sandbox.answer).toEqual({
      kind: 'choice',
      choices: ['auto', 'local'],
    });
    expect(sandbox.recommended).toBe('auto');
    expect(sandbox.writes).toEqual(['agent-workspace.yaml']);
  });
});

describe('setupQuestionApplies', () => {
  const document = questionFor('content.openapiDocument');

  it('applies a question without a condition', () => {
    expect(setupQuestionApplies(questionFor('content.engine'), {})).toBe(true);
  });

  it('reads the named multi answer', () => {
    expect(setupQuestionApplies(document, { 'content.internalTools': ['openapi'] })).toBe(true);
    expect(setupQuestionApplies(document, { 'content.internalTools': ['none'] })).toBe(false);
    expect(setupQuestionApplies(document, {})).toBe(false);
  });

  it('never matches a string answer by substring', () => {
    expect(setupQuestionApplies(document, { 'content.internalTools': 'openapi' })).toBe(false);
  });
});

describe('THEME_RECOMMENDATIONS', () => {
  it.each(SETUP_THEMES)('fills a complete, consistent answer set for %s', (theme) => {
    const answers = withRecommendedAnswers({ 'setup.theme': theme });
    expect(CompleteSetupAnswersSchema.safeParse(answers).success).toBe(true);
    expect(answers['setup.theme']).toBe(theme);
    expect(answers['embedder.surfaceTitle']).toBe(THEME_RECOMMENDATIONS[theme].content.title);
  });

  it.each(SETUP_THEMES)('holds valid sample content for %s', (theme) => {
    const { answers, content } = THEME_RECOMMENDATIONS[theme];
    expect(content.prompts.length).toBeLessThanOrEqual(6);
    expect(content.instructions.length).toBeGreaterThan(0);
    expect(content.instructions.length).toBeLessThanOrEqual(AGENT_INSTRUCTIONS_MAX_LENGTH);
    expect(SURFACE_TITLE_PATTERN.test(content.title)).toBe(true);
    expect(SetupAnswersSchema.safeParse(answers).success).toBe(true);
    expect(answers).not.toHaveProperty('content.internalTools');
    expect(answers).not.toHaveProperty('content.permissions');
    if (theme === 'blank') {
      expect(content.greeting).toBeUndefined();
      expect(content.prompts).toEqual([]);
      expect(content.instructions).toBe(
        'You are a helpful assistant. Answer clearly and briefly, and say so when you are not sure.',
      );
    } else {
      expect(content.greeting?.length).toBeGreaterThan(0);
      expect(content.prompts.length).toBeGreaterThan(0);
      expect(
        SurfacePartsSchema.safeParse({
          greeting: content.greeting,
          suggestedPrompts: content.prompts,
        }).success,
      ).toBe(true);
    }
  });
});

describe('withRecommendedAnswers undefined keys', () => {
  it('keeps the theme recommendation when an answer key is present but undefined', () => {
    const given = { 'setup.theme': 'knowledge', 'content.agentName': undefined } as const;
    expect(withRecommendedAnswers(given as never)).toEqual(
      withRecommendedAnswers({ 'setup.theme': 'knowledge' }),
    );
  });
});

describe('SetupAnswersSchema', () => {
  it('fills every question with withRecommendedAnswers({}), keeping the slice-1 answers', () => {
    const answers = withRecommendedAnswers({});
    expect(SetupAnswersSchema.safeParse(answers).success).toBe(true);
    expect(CompleteSetupAnswersSchema.safeParse(answers).success).toBe(true);
    expect(answers).toEqual({
      'setup.theme': 'support',
      'admin.sandbox': 'auto',
      'admin.modelProvider': 'anthropic',
      'content.agentName': 'assistant',
      'content.engine': 'claude-agent-sdk',
      'content.internalTools': ['none'],
      'content.permissions': [],
      'embedder.surfaceTitle': 'Assistant',
      'embedder.brandColour': '#2f5fd0',
      'admin.platforms': ['none'],
    });
    expect(answers).not.toHaveProperty('content.openapiDocument');
  });

  it('keeps a partial answer and does not change its input', () => {
    const given = { 'content.agentName': 'support-bot', 'embedder.brandColour': '#AABBCC' };
    const answers = withRecommendedAnswers(given);
    expect(answers['content.agentName']).toBe('support-bot');
    expect(answers['embedder.brandColour']).toBe('#AABBCC');
    expect(answers['admin.sandbox']).toBe('auto');
    expect(given).toEqual({
      'content.agentName': 'support-bot',
      'embedder.brandColour': '#AABBCC',
    });
  });

  it("lets the person's answer win over the theme's", () => {
    const answers = withRecommendedAnswers({ 'setup.theme': 'copilot', 'content.agentName': 'x' });
    expect(answers['content.agentName']).toBe('x');
    expect(answers['embedder.surfaceTitle']).toBe('Copilot');
  });

  it('recommends a document once openapi is chosen', () => {
    const answers = withRecommendedAnswers({ 'content.internalTools': ['openapi'] });
    expect(answers['content.openapiDocument']).toBe('openapi.json');
  });

  it('throws on inconsistent answers', () => {
    expect(() => withRecommendedAnswers({ 'content.openapiDocument': 'openapi.json' })).toThrow();
  });

  it('refuses an unknown id in both forms', () => {
    for (const schema of [SetupAnswersSchema, CompleteSetupAnswersSchema]) {
      const result = schema.safeParse({ ...withRecommendedAnswers({}), 'admin.modelKey': 'sk-x' });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining({ code: 'unrecognized_keys', path: [], keys: ['admin.modelKey'] }),
      );
    }
  });

  it('requires every key in the complete form', () => {
    expect(CompleteSetupAnswersSchema.safeParse({ 'admin.sandbox': 'auto' }).success).toBe(false);
  });

  it.each([
    ['none with another choice', ['none', 'openapi']],
    ['a repeated choice', ['openapi', 'openapi']],
    ['no choice', []],
    ['an unknown choice', ['mysql']],
  ])('refuses internal tools with %s', (_name, tools) => {
    const result = SetupAnswersSchema.safeParse({ 'content.internalTools': tools });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0]).toBe('content.internalTools');
  });

  it.each(SETUP_THEMES)('recommends no platform for %s', (theme) => {
    expect(withRecommendedAnswers({ 'setup.theme': theme })['admin.platforms']).toEqual(['none']);
  });

  it.each([
    ['none with another choice', ['none', 'copilot-studio']],
    ['a repeated choice', ['copilot-studio', 'copilot-studio']],
    ['no choice', []],
    ['an eject id', ['eject-mastra']],
    ['seven choices', [...HOSTED_PLATFORM_IDS, 'none']],
  ])('refuses platforms with %s', (_name, platforms) => {
    const result = SetupAnswersSchema.safeParse({ 'admin.platforms': platforms });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0]).toBe('admin.platforms');
  });

  it('refuses none with another platform with its own message', () => {
    const result = SetupAnswersSchema.safeParse({ 'admin.platforms': ['none', 'copilot-studio'] });
    expect(result.error?.issues[0]?.message).toBe('none is chosen alone');
  });

  it.each([[['readFiles', 'readFiles']], [['sudo']]])(
    'refuses the permissions %j',
    (permissions) => {
      expect(SetupAnswersSchema.safeParse({ 'content.permissions': permissions }).success).toBe(
        false,
      );
    },
  );

  it.each([
    ['no tools answer', {}],
    ['postgres only', { 'content.internalTools': ['postgres'] }],
  ])('refuses an OpenAPI document with %s, in both forms', (_name, tools) => {
    const partial = SetupAnswersSchema.safeParse({
      ...tools,
      'content.openapiDocument': 'openapi.json',
    });
    expect(partial.success).toBe(false);
    expect(partial.error?.issues[0]?.path).toEqual(['content.openapiDocument']);
    const complete = CompleteSetupAnswersSchema.safeParse({
      ...withRecommendedAnswers({}),
      ...tools,
      'content.openapiDocument': 'openapi.json',
    });
    expect(complete.success).toBe(false);
    expect(complete.error?.issues[0]?.path).toEqual(['content.openapiDocument']);
  });

  it('requires an OpenAPI document in the complete form once openapi is chosen', () => {
    const result = CompleteSetupAnswersSchema.safeParse({
      ...withRecommendedAnswers({}),
      'content.internalTools': ['openapi'],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['content.openapiDocument'],
      message: 'is required when content.internalTools includes openapi',
    });
  });

  it.each([
    'openapi.json',
    'apis/orders.openapi.json',
    'docs/api.yaml',
    'https://api.example.com/openapi.json',
  ])('accepts the OpenAPI document %j', (document) => {
    expect(
      SetupAnswersSchema.safeParse({
        'content.internalTools': ['openapi'],
        'content.openapiDocument': document,
      }).success,
    ).toBe(true);
  });

  it.each([
    '/etc/openapi.json',
    '../x.json',
    'apis/../x.json',
    '.hidden/x.json',
    'x.txt',
    'http://a.example/x.json',
    'https://u:p@a.example/x.json',
    'https://a.example/x.json?token=1',
    'a\\b.json',
    'x'.repeat(2049),
  ])('refuses the OpenAPI document %j', (document) => {
    expect(
      SetupAnswersSchema.safeParse({
        'content.internalTools': ['openapi'],
        'content.openapiDocument': document,
      }).success,
    ).toBe(false);
  });

  it.each(['blue', '#fff', '#12345g', '#1234567'])('refuses the colour %j', (colour) => {
    expect(SetupAnswersSchema.safeParse({ 'embedder.brandColour': colour }).success).toBe(false);
    expect(HEX_COLOUR_PATTERN.test(colour)).toBe(false);
  });

  it.each(['Assistant', 'a_b', '-a', ''])('refuses the agent name %j', (name) => {
    expect(SetupAnswersSchema.safeParse({ 'content.agentName': name }).success).toBe(false);
  });

  it.each([' Help', 'Help ', '', 'a\tb', 'a\nb', 'x'.repeat(61)])(
    'refuses the surface title %j',
    (title) => {
      expect(SetupAnswersSchema.safeParse({ 'embedder.surfaceTitle': title }).success).toBe(false);
    },
  );

  it.each(['A', 'Help desk', 'Ask Ünïcode ✓', 'x'.repeat(60)])(
    'accepts the surface title %j',
    (title) => {
      expect(SetupAnswersSchema.safeParse({ 'embedder.surfaceTitle': title }).success).toBe(true);
    },
  );

  it('still accepts the deprecated sandbox-runtime answer without offering it (#818)', () => {
    expect(SetupAnswersSchema.safeParse({ 'admin.sandbox': 'sandbox-runtime' }).success).toBe(true);
    expect(SETUP_SANDBOX_OFFERED_CHOICES).not.toContain('sandbox-runtime');
  });

  it('refuses a sandbox outside its choices', () => {
    expect(SetupAnswersSchema.safeParse({ 'admin.sandbox': 'docker' }).success).toBe(false);
  });
});

describe('setup review regressions (#439)', () => {
  it.each([
    ['zero-width space only', '​'],
    ['a bidi override', 'Help ‮txt.exe'],
    ['a lone surrogate', '\ud800'],
    ['a line separator', 'a b'],
    ['a paragraph separator', 'a b'],
    ['a zero-width joiner', 'a‍b'],
  ])('refuses a surface title with %s', (_name, title) => {
    expect(SetupAnswersSchema.safeParse({ 'embedder.surfaceTitle': title }).success).toBe(false);
  });

  it('freezes every question, its answer format, its condition and its lists', () => {
    expect(Object.isFrozen(SETUP_QUESTIONS)).toBe(true);
    for (const question of SETUP_QUESTIONS) {
      expect(Object.isFrozen(question)).toBe(true);
      expect(Object.isFrozen(question.answer)).toBe(true);
      expect(Object.isFrozen(question.writes)).toBe(true);
      expect(Object.isFrozen(question.recommended)).toBe(true);
      if (question.answer.kind !== 'text') {
        expect(Object.isFrozen(question.answer.choices)).toBe(true);
      }
      if (question.when !== undefined) {
        expect(Object.isFrozen(question.when)).toBe(true);
      }
    }
  });

  it('gives every theme a one-line summary', () => {
    for (const theme of SETUP_THEMES) {
      const { summary } = THEME_RECOMMENDATIONS[theme];
      expect(summary.length, theme).toBeGreaterThan(0);
      expect(summary, theme).not.toContain('\n');
    }
  });

  it('freezes every theme recommendation throughout', () => {
    expect(Object.isFrozen(THEME_RECOMMENDATIONS)).toBe(true);
    for (const theme of SETUP_THEMES) {
      const recommendation = THEME_RECOMMENDATIONS[theme];
      expect(Object.isFrozen(recommendation)).toBe(true);
      expect(Object.isFrozen(recommendation.answers)).toBe(true);
      expect(Object.isFrozen(recommendation.content)).toBe(true);
      expect(Object.isFrozen(recommendation.content.prompts)).toBe(true);
    }
  });
});

describe('unansweredSetupFlags', () => {
  it('gives the usage of --model-base-url for an endpoint provider without one', () => {
    expect(unansweredSetupFlags({ 'admin.modelProvider': 'openai-compatible' })).toEqual([
      '--model-base-url <url>',
    ]);
    expect(unansweredSetupFlags({ 'admin.modelProvider': 'azure-openai' })).toEqual([
      '--model-base-url <url>',
    ]);
  });

  it('is empty once the endpoint is given, or when the provider needs none', () => {
    expect(
      unansweredSetupFlags({
        'admin.modelProvider': 'openai-compatible',
        'admin.modelBaseUrl': 'https://models.example.com/v1',
      }),
    ).toEqual([]);
    expect(unansweredSetupFlags({})).toEqual([]);
    expect(unansweredSetupFlags({ 'admin.modelProvider': 'anthropic' })).toEqual([]);
  });
});
