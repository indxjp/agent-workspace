import { z } from 'zod';

import { AGENT_PERMISSION_KEYS } from './agents.js';
import { DEFAULT_ENGINE_ID, ENGINE_IDS } from './engines.js';
import { FEATURE_IDS, FeatureListSchema } from './features.js';
import { HOSTED_PLATFORM_IDS } from './platform-ids.js';
import { NAME_KEY_PATTERN } from './project-file.js';
import { MODEL_PROVIDERS, type ModelProvider } from './runs.js';
import { urlCarriesCredential } from './url-credential.js';

/**
 * Issue #439 (S1-01): the setup questions of ADR-0107 — the things `aw init` (and later the
 * browser setup) asks before it writes a project. Each question carries its own answer schema,
 * so the prompt, `--yes`, `SetupAnswersSchema` and the renderer read one definition.
 *
 * Issue #525 (S2-01b) grows them to ten questions: setup starts from a theme (SD9), and a question
 * may be a multi-select or be asked only when an earlier answer includes a choice.
 *
 * No answer is a secret: the model key is not a question (ADR-0107), so these answers may be
 * logged, written to disk and shown back.
 */
export const SETUP_AUDIENCES = ['setup', 'admin', 'content', 'embedder'] as const;
export type SetupAudience = (typeof SETUP_AUDIENCES)[number];

/**
 * The model providers first-run setup offers: {@link MODEL_PROVIDERS} without
 * `anthropic-compatible`, which setup does not ask about.
 */
export const SETUP_PROVIDERS = [
  'anthropic',
  'openai',
  'azure-openai',
  'openai-compatible',
] as const satisfies readonly ModelProvider[];
export type SetupProvider = (typeof SETUP_PROVIDERS)[number];

/** A `#rrggbb` colour. Exported so a surface's theme colour (S1-02) accepts the same grammar. */
export const HEX_COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/u;

/**
 * A surface title: 1–60 characters, no whitespace at either end — a value that is already its own
 * trimmed form, so nothing has to transform it — and nothing invisible or not text: no control
 * (`Cc`) or format (`Cf`: zero-width and bidirectional controls) character, no lone surrogate
 * (`Cs`) and no line or paragraph separator (`Zl`, `Zp`). A title is shown in a widget and written
 * into `surfaces/main.ts`, so what the person reads is what the file holds.
 */
export const SURFACE_TITLE_PATTERN =
  /^[^\s\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}](?:[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]{0,58}[^\s\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}])?$/u;

/** The longest surface title, in characters. */
export const SURFACE_TITLE_MAX_LENGTH = 60;

/**
 * The files an answer is written into. `<agentName>` stands for the `content.agentName` answer;
 * `<name>` is the tool's name, derived by the renderer (S2-06a).
 */
export const SETUP_FILE_PATHS = [
  'agent-workspace.yaml',
  'agents/<agentName>.ts',
  'surfaces/main.ts',
  'tools/<name>.ts',
] as const;
export type SetupFilePath = (typeof SETUP_FILE_PATHS)[number];

/**
 * How a question is answered: one of a fixed list, up to `max` of a fixed list (issue #525), or
 * free text in a stated grammar.
 */
export type SetupAnswerFormat =
  | { readonly kind: 'choice'; readonly choices: readonly string[] }
  | {
      readonly kind: 'multi';
      readonly choices: readonly string[];
      /** The most choices one answer may hold. */
      readonly max: number;
    }
  | {
      readonly kind: 'text';
      /** The grammar in words, as the prompt shows it. */
      readonly grammar: string;
      readonly pattern: RegExp;
      readonly maxLength: number;
    };

/** One setup question: who it is for, how it is answered, what it recommends and writes. */
export interface SetupQuestion<
  Id extends string,
  Schema extends z.ZodType<string | readonly string[]>,
> {
  /** Dotted `<audience>.<name>`; also the key in {@link SetupAnswersSchema}. */
  readonly id: Id;
  /** The command-line flag that answers this question, without the dashes (`theme` is `--theme`). */
  readonly flag: string;
  readonly audience: SetupAudience;
  readonly prompt: string;
  readonly answer: SetupAnswerFormat;
  /** The answer `--yes` takes; it always parses with {@link SetupQuestion.schema}. */
  readonly recommended: z.infer<Schema>;
  readonly writes: readonly SetupFilePath[];
  /** The one schema of this question's answer. */
  readonly schema: Schema;
  /**
   * Asked only when the multi answer of the earlier question `id` includes `includes`, or the
   * choice answer of `id` is one of `oneOf` (issue #690); absent, the question is always asked
   * (issue #525). Read through {@link setupQuestionApplies}.
   */
  readonly when?: SetupQuestionCondition;
  /**
   * Set when `recommended` is only a placeholder the renderer refuses, so `--yes` cannot take it
   * and the person must answer. The value is the answer's name in a usage line (`--flag <name>`).
   * See {@link unansweredSetupFlags}.
   */
  readonly placeholder?: string;
}

/** The condition of a conditional question: a multi answer includes a choice, or a choice is one of. */
export type SetupQuestionCondition =
  | { readonly id: string; readonly includes: string }
  | { readonly id: string; readonly oneOf: readonly string[] };

/** The condition in words, as a refusal names it. */
function conditionText(when: SetupQuestionCondition): string {
  return 'includes' in when
    ? `${when.id} includes ${when.includes}`
    : `${when.id} is ${when.oneOf.join(' or ')}`;
}

/**
 * Whether `question` is asked given the answers so far: always without a `when`, otherwise when
 * the named multi answer includes `includes`, or the named choice answer equals one of `oneOf`. A
 * string never matches an `includes` condition, so a substring cannot (issue #525). Pure.
 */
export function setupQuestionApplies(
  question: { readonly when?: SetupQuestionCondition },
  answers: Readonly<Record<string, unknown>>,
): boolean {
  if (question.when === undefined) return true;
  const answer = answers[question.when.id];
  if ('oneOf' in question.when) {
    return typeof answer === 'string' && question.when.oneOf.includes(answer);
  }
  return Array.isArray(answer) && answer.includes(question.when.includes);
}

/** The themes setup starts from (ADR-0107 SD9; issue #525); the `setup.theme` choices. */
export const SETUP_THEMES = [
  'support',
  'copilot',
  'knowledge',
  'automation',
  'review',
  'blank',
] as const;
type SetupTheme = (typeof SETUP_THEMES)[number];

/**
 * The sandbox answers setup accepts; `auto` lets `aw dev` pick and renders no `runtime` block.
 * `sandbox-runtime` is deprecated (#818): it has no implementation, so it is still parsed but no
 * longer offered (`SETUP_SANDBOX_OFFERED_CHOICES`) and renders as `local`.
 */
export const SETUP_SANDBOX_CHOICES = ['auto', 'sandbox-runtime', 'local'] as const;
export type SetupSandboxChoice = (typeof SETUP_SANDBOX_CHOICES)[number];

/** The sandbox choices setup offers: every accepted answer that is implemented. */
export const SETUP_SANDBOX_OFFERED_CHOICES = ['auto', 'local'] as const;

/** The internal tools an agent may call; `none` is chosen alone. */
const INTERNAL_TOOL_CHOICES = ['openapi', 'postgres', 'none'] as const;

/**
 * The platforms setup offers (ADR-0133): every hosted platform, and `none`, chosen alone. The
 * eject-* ids are one-off exports (`aw platforms export`), not a project binding, so setup does not
 * offer them.
 */
export const SETUP_PLATFORM_CHOICES = [...HOSTED_PLATFORM_IDS, 'none'] as const;

/**
 * An OpenAPI document: an `https://` URL, or a project-relative path to a `.json`, `.yaml` or
 * `.yml` file. A path segment starts with a letter, digit or `_`, so no path is absolute, climbs
 * out with `..` or names a hidden file.
 */
const OPENAPI_DOCUMENT_PATTERN =
  /^(?:https:\/\/[^\s\p{Cc}\p{Cf}\p{Cs}\\"'<>]+|[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*\.(?:json|yaml|yml))$/u;
const OPENAPI_DOCUMENT_MAX_LENGTH = 2048;

/** A model endpoint: an `http(s)` URL (a local server is `http://localhost:…`), no credential. */
const MODEL_BASE_URL_PATTERN = /^https?:\/\/[^\s\p{Cc}\p{Cf}\p{Cs}\\"'<>]+$/u;
const MODEL_BASE_URL_MAX_LENGTH = 2048;

/**
 * The providers that cannot run without an endpoint: the `modelBaseUrl` question is asked for them.
 * An `anthropic-compatible` provider is by definition some other host than Anthropic's (BH061-044).
 */
const PROVIDERS_NEEDING_ENDPOINT = [
  'anthropic-compatible',
  'openai-compatible',
  'azure-openai',
] as const;

function hasNoRepeat(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** Up to `max` of `choices`, none repeated. */
function multiSchema<const Choice extends string>(
  choices: readonly [Choice, ...Choice[]],
  max: number,
) {
  return z.array(z.enum(choices)).max(max).refine(hasNoRepeat, 'repeats a choice');
}

const themeSchema = z.enum(SETUP_THEMES);
const sandboxSchema = z.enum(SETUP_SANDBOX_CHOICES);
const modelProviderSchema = z.enum(MODEL_PROVIDERS);
const modelBaseUrlSchema = z
  .string()
  .max(MODEL_BASE_URL_MAX_LENGTH)
  .regex(MODEL_BASE_URL_PATTERN)
  .refine(
    (value) => URL.canParse(value) && !urlCarriesCredential(new URL(value)),
    'must be an http(s) URL without a credential',
  );
const agentNameSchema = z.string().max(64).regex(NAME_KEY_PATTERN);
const engineSchema = z.enum(ENGINE_IDS);
const internalToolsSchema = multiSchema(INTERNAL_TOOL_CHOICES, 2)
  .min(1)
  .refine((tools) => !tools.includes('none') || tools.length === 1, 'none is chosen alone')
  .readonly();
const openapiDocumentSchema = z
  .string()
  .max(OPENAPI_DOCUMENT_MAX_LENGTH)
  .regex(OPENAPI_DOCUMENT_PATTERN)
  .refine(
    (value) =>
      !value.startsWith('https://') ||
      (URL.canParse(value) && !urlCarriesCredential(new URL(value))),
    'must be an https URL without a credential',
  );
const platformsSchema = multiSchema(SETUP_PLATFORM_CHOICES, HOSTED_PLATFORM_IDS.length)
  .min(1)
  .refine(
    (platforms) => !platforms.includes('none') || platforms.length === 1,
    'none is chosen alone',
  )
  .readonly();
const permissionsSchema = multiSchema(
  AGENT_PERMISSION_KEYS,
  AGENT_PERMISSION_KEYS.length,
).readonly();
const surfaceTitleSchema = z.string().max(SURFACE_TITLE_MAX_LENGTH).regex(SURFACE_TITLE_PATTERN);
const brandColourSchema = z.string().max(7).regex(HEX_COLOUR_PATTERN);

const themeQuestion: SetupQuestion<'setup.theme', typeof themeSchema> = {
  id: 'setup.theme',
  flag: 'theme',
  audience: 'setup',
  prompt: 'Which theme should setup start from?',
  answer: { kind: 'choice', choices: SETUP_THEMES },
  recommended: 'support',
  writes: ['agents/<agentName>.ts', 'surfaces/main.ts'],
  schema: themeSchema,
};

const sandboxQuestion: SetupQuestion<'admin.sandbox', typeof sandboxSchema> = {
  id: 'admin.sandbox',
  flag: 'sandbox',
  audience: 'admin',
  prompt: 'Where should agents run their tools?',
  answer: { kind: 'choice', choices: SETUP_SANDBOX_OFFERED_CHOICES },
  recommended: 'auto',
  writes: ['agent-workspace.yaml'],
  schema: sandboxSchema,
};

const modelProviderQuestion: SetupQuestion<'admin.modelProvider', typeof modelProviderSchema> = {
  id: 'admin.modelProvider',
  flag: 'provider',
  audience: 'admin',
  prompt: "Who serves the agent's model?",
  answer: { kind: 'choice', choices: MODEL_PROVIDERS },
  recommended: 'anthropic',
  writes: ['agent-workspace.yaml'],
  schema: modelProviderSchema,
};

const modelBaseUrlQuestion: SetupQuestion<'admin.modelBaseUrl', typeof modelBaseUrlSchema> = {
  id: 'admin.modelBaseUrl',
  flag: 'model-base-url',
  audience: 'admin',
  prompt: "Where is the model provider's endpoint?",
  answer: {
    kind: 'text',
    grammar: 'an http(s) URL without a credential, up to 2048 characters',
    pattern: MODEL_BASE_URL_PATTERN,
    maxLength: MODEL_BASE_URL_MAX_LENGTH,
  },
  recommended: 'https://your-endpoint.example/',
  placeholder: 'url',
  writes: ['agent-workspace.yaml'],
  schema: modelBaseUrlSchema,
  when: { id: 'admin.modelProvider', oneOf: PROVIDERS_NEEDING_ENDPOINT },
};

const agentNameQuestion: SetupQuestion<'content.agentName', typeof agentNameSchema> = {
  id: 'content.agentName',
  flag: 'agent',
  audience: 'content',
  prompt: 'What is your first agent called?',
  answer: {
    kind: 'text',
    grammar: 'lower-case letters, digits and hyphens, 1-64 characters, no hyphen at either end',
    pattern: NAME_KEY_PATTERN,
    maxLength: 64,
  },
  recommended: 'assistant',
  writes: ['agents/<agentName>.ts', 'surfaces/main.ts'],
  schema: agentNameSchema,
};

const engineQuestion: SetupQuestion<'content.engine', typeof engineSchema> = {
  id: 'content.engine',
  flag: 'engine',
  audience: 'content',
  prompt: 'Which agent engine should it use?',
  answer: { kind: 'choice', choices: ENGINE_IDS },
  recommended: DEFAULT_ENGINE_ID,
  writes: ['agents/<agentName>.ts'],
  schema: engineSchema,
};

const internalToolsQuestion: SetupQuestion<'content.internalTools', typeof internalToolsSchema> = {
  id: 'content.internalTools',
  flag: 'tools',
  audience: 'content',
  prompt: 'Which internal tools should the agent call?',
  answer: { kind: 'multi', choices: INTERNAL_TOOL_CHOICES, max: 2 },
  recommended: ['none'],
  writes: ['agents/<agentName>.ts', 'tools/<name>.ts'],
  schema: internalToolsSchema,
};

const openapiDocumentQuestion: SetupQuestion<
  'content.openapiDocument',
  typeof openapiDocumentSchema
> = {
  id: 'content.openapiDocument',
  flag: 'openapi',
  audience: 'content',
  prompt: 'Where is the OpenAPI document?',
  answer: {
    kind: 'text',
    grammar:
      'a project-relative path to a .json, .yaml or .yml file, or an https URL without a ' +
      'credential, up to 2048 characters',
    pattern: OPENAPI_DOCUMENT_PATTERN,
    maxLength: OPENAPI_DOCUMENT_MAX_LENGTH,
  },
  recommended: 'openapi.json',
  writes: ['tools/<name>.ts'],
  schema: openapiDocumentSchema,
  when: { id: 'content.internalTools', includes: 'openapi' },
};

const permissionsQuestion: SetupQuestion<'content.permissions', typeof permissionsSchema> = {
  id: 'content.permissions',
  flag: 'permissions',
  audience: 'content',
  prompt: 'Which permissions should the agent have?',
  answer: { kind: 'multi', choices: AGENT_PERMISSION_KEYS, max: AGENT_PERMISSION_KEYS.length },
  recommended: [],
  writes: ['agents/<agentName>.ts'],
  schema: permissionsSchema,
};

const surfaceTitleQuestion: SetupQuestion<'embedder.surfaceTitle', typeof surfaceTitleSchema> = {
  id: 'embedder.surfaceTitle',
  flag: 'title',
  audience: 'embedder',
  prompt: 'What title should the chat widget show?',
  answer: {
    kind: 'text',
    grammar: '1-60 characters, no control or invisible characters, no space at either end',
    pattern: SURFACE_TITLE_PATTERN,
    maxLength: SURFACE_TITLE_MAX_LENGTH,
  },
  recommended: 'Assistant',
  writes: ['surfaces/main.ts'],
  schema: surfaceTitleSchema,
};

const brandColourQuestion: SetupQuestion<'embedder.brandColour', typeof brandColourSchema> = {
  id: 'embedder.brandColour',
  flag: 'color',
  audience: 'embedder',
  prompt: 'What is your brand colour?',
  answer: {
    kind: 'text',
    grammar: 'a hex colour, # followed by six hex digits',
    pattern: HEX_COLOUR_PATTERN,
    maxLength: 7,
  },
  recommended: '#2f5fd0',
  writes: ['surfaces/main.ts'],
  schema: brandColourSchema,
};

const platformsQuestion: SetupQuestion<'admin.platforms', typeof platformsSchema> = {
  id: 'admin.platforms',
  flag: 'platform',
  audience: 'admin',
  prompt: 'Which agent platforms should this agent also be published to?',
  answer: { kind: 'multi', choices: SETUP_PLATFORM_CHOICES, max: HOSTED_PLATFORM_IDS.length },
  recommended: ['none'],
  writes: ['agent-workspace.yaml'],
  schema: platformsSchema,
};

const featuresQuestion: SetupQuestion<'admin.features', typeof FeatureListSchema> = {
  id: 'admin.features',
  flag: 'features',
  audience: 'admin',
  prompt: 'Which features should this deployment include?',
  answer: { kind: 'multi', choices: FEATURE_IDS, max: FEATURE_IDS.length },
  recommended: [...FEATURE_IDS],
  writes: ['agent-workspace.yaml'],
  schema: FeatureListSchema,
};

function frozenCondition(when: SetupQuestionCondition): SetupQuestionCondition {
  return 'oneOf' in when
    ? Object.freeze({ id: when.id, oneOf: Object.freeze([...when.oneOf]) })
    : Object.freeze({ ...when });
}

/**
 * Freezes a question, its answer format, its condition and its lists, so no consumer can change a
 * question for every other consumer in the process. The schema and the pattern are shared values
 * and stay as they are.
 */
function frozenQuestion<Id extends string, Schema extends z.ZodType<string | readonly string[]>>(
  question: SetupQuestion<Id, Schema>,
): SetupQuestion<Id, Schema> {
  const answer: SetupAnswerFormat =
    question.answer.kind === 'text'
      ? Object.freeze({ ...question.answer })
      : Object.freeze({ ...question.answer, choices: Object.freeze([...question.answer.choices]) });
  // A list recommendation is this module's own literal, so it is frozen where it is.
  Object.freeze(question.recommended);
  return Object.freeze({
    ...question,
    answer,
    writes: Object.freeze([...question.writes]),
    ...(question.when === undefined ? {} : { when: frozenCondition(question.when) }),
  });
}

/** The thirteen setup questions, in the order they are asked; frozen throughout. */
export const SETUP_QUESTIONS = Object.freeze([
  frozenQuestion(themeQuestion),
  frozenQuestion(sandboxQuestion),
  frozenQuestion(modelProviderQuestion),
  frozenQuestion(modelBaseUrlQuestion),
  frozenQuestion(agentNameQuestion),
  frozenQuestion(engineQuestion),
  frozenQuestion(internalToolsQuestion),
  frozenQuestion(openapiDocumentQuestion),
  frozenQuestion(permissionsQuestion),
  frozenQuestion(surfaceTitleQuestion),
  frozenQuestion(brandColourQuestion),
  frozenQuestion(platformsQuestion),
  frozenQuestion(featuresQuestion),
] as const);

export type SetupQuestionId = (typeof SETUP_QUESTIONS)[number]['id'];

/** Every answer, keyed by question id; the one shape both forms below are made from. */
const setupAnswersShape = z
  .object({
    [themeQuestion.id]: themeQuestion.schema,
    [sandboxQuestion.id]: sandboxQuestion.schema,
    [modelProviderQuestion.id]: modelProviderQuestion.schema,
    [modelBaseUrlQuestion.id]: modelBaseUrlQuestion.schema.optional(),
    [agentNameQuestion.id]: agentNameQuestion.schema,
    [engineQuestion.id]: engineQuestion.schema,
    [internalToolsQuestion.id]: internalToolsQuestion.schema,
    [openapiDocumentQuestion.id]: openapiDocumentQuestion.schema.optional(),
    [permissionsQuestion.id]: permissionsQuestion.schema,
    [surfaceTitleQuestion.id]: surfaceTitleQuestion.schema,
    [brandColourQuestion.id]: brandColourQuestion.schema,
    [platformsQuestion.id]: platformsQuestion.schema,
    [featuresQuestion.id]: featuresQuestion.schema.optional(),
  })
  .strict();

/**
 * Refuses an answer to a conditional question that does not apply, and — when `complete` —
 * requires one that does.
 */
function conditionalAnswers(complete: boolean) {
  return (answers: Readonly<Record<string, unknown>>, context: z.RefinementCtx): void => {
    for (const question of SETUP_QUESTIONS) {
      if (question.when === undefined) continue;
      const given = answers[question.id] !== undefined;
      const applies = setupQuestionApplies(question, answers);
      const condition = conditionText(question.when);
      if (given && !applies) {
        context.addIssue({
          code: 'custom',
          path: [question.id],
          message: `is asked only when ${condition}`,
        });
      } else if (complete && applies && !given) {
        context.addIssue({
          code: 'custom',
          path: [question.id],
          message: `is required when ${condition}`,
        });
      }
    }
  };
}

/** Answers given so far, keyed by question id; any may be missing, an unknown id is refused. */
export const SetupAnswersSchema = setupAnswersShape
  .partial()
  .superRefine(conditionalAnswers(false))
  .readonly();
export type SetupAnswers = z.infer<typeof SetupAnswersSchema>;

/** Every question that applies answered: what the renderer writes a project from. */
export const CompleteSetupAnswersSchema = setupAnswersShape
  .superRefine(conditionalAnswers(true))
  .readonly();
export type CompleteSetupAnswers = z.infer<typeof CompleteSetupAnswersSchema>;

/** What a theme recommends, and the sample content a project starts with. */
interface ThemeRecommendation {
  /** One line saying what the theme is for; the setup menu shows it beside the theme's name. */
  readonly summary: string;
  /** Answers the theme recommends over each question's own; never a tool or a permission. */
  readonly answers: Omit<SetupAnswers, 'setup.theme' | 'content.openapiDocument'>;
  readonly content: {
    /** The first agent's instructions. */
    readonly instructions: string;
    /** The surface's greeting; `blank` has none. */
    readonly greeting?: string;
    /** Up to six suggested prompts. */
    readonly prompts: readonly string[];
    /** The surface title; equals the `embedder.surfaceTitle` the theme ends up with. */
    readonly title: string;
  };
}

function frozenTheme(theme: ThemeRecommendation): ThemeRecommendation {
  return Object.freeze({
    summary: theme.summary,
    answers: Object.freeze({ ...theme.answers }),
    content: Object.freeze({
      ...theme.content,
      prompts: Object.freeze([...theme.content.prompts]),
    }),
  });
}

/**
 * Each theme's recommended answers and sample content (ADR-0107 SD9; issue #525), deep-frozen.
 * `support` and `blank` keep every question's own recommendation; no theme recommends a tool or a
 * permission, so the recommendations always produce a project that runs. `blank`'s instructions
 * are the slice-1 starter text. `automation` is also a complete starter project (issue #696): the
 * SDK adds a code tool, an OpenAPI tool with the fake API it calls, a README and an eval file.
 */
export const THEME_RECOMMENDATIONS: Readonly<Record<SetupTheme, ThemeRecommendation>> =
  Object.freeze({
    support: frozenTheme({
      summary: 'Answers customer questions and hands over to a person',
      answers: {},
      content: {
        instructions:
          'You are a customer support assistant. Answer questions clearly and briefly, ask for ' +
          'the details you need, and say so when you are not sure or when a person should take over.',
        greeting: 'Hi! How can I help you today?',
        prompts: [
          'I have a question about my account',
          'Something is not working',
          'How do I get started?',
        ],
        title: 'Assistant',
      },
    }),
    copilot: frozenTheme({
      summary: 'Drafts, summarises and plans for your team',
      answers: { 'content.agentName': 'copilot', 'embedder.surfaceTitle': 'Copilot' },
      content: {
        instructions:
          'You are a copilot for the people on this team. Help them draft, summarise and plan ' +
          'their work, keep answers short, and ask before you assume.',
        greeting: 'Hi, what are you working on?',
        prompts: ['Summarise this for me', 'Draft a reply', 'Help me plan my week'],
        title: 'Copilot',
      },
    }),
    knowledge: frozenTheme({
      summary: 'Answers from your documentation and cites where',
      answers: { 'content.agentName': 'knowledge', 'embedder.surfaceTitle': 'Knowledge base' },
      content: {
        instructions:
          'You answer questions from the knowledge you have been given. Point to where each ' +
          'answer comes from, and say so plainly when you do not know.',
        greeting: 'Ask me anything about our documentation.',
        prompts: [
          'Where do I find the setup guide?',
          'What changed in the latest release?',
          'Explain this term',
        ],
        title: 'Knowledge base',
      },
    }),
    automation: frozenTheme({
      summary: 'Runs routine tasks step by step (with example tools)',
      answers: { 'content.agentName': 'automation', 'embedder.surfaceTitle': 'Automation' },
      content: {
        instructions:
          'You carry out routine tasks step by step. Say what you are about to do before you do ' +
          'it, report what you did, and stop to ask when a step is unclear.',
        greeting: 'Which task should I run?',
        prompts: [
          'Show me what you can automate',
          'Run the daily report',
          'Check what is waiting for me',
        ],
        title: 'Automation',
      },
    }),
    review: frozenTheme({
      summary: 'Reviews work for correctness and clarity',
      answers: { 'content.agentName': 'reviewer', 'embedder.surfaceTitle': 'Reviewer' },
      content: {
        instructions:
          'You review work for correctness and clarity. Point to each problem and where it is, ' +
          'explain why it matters and suggest a fix; say so when you find nothing.',
        greeting: 'Paste what you want reviewed.',
        prompts: [
          'Review this change',
          'Check this text for mistakes',
          'What could go wrong here?',
        ],
        title: 'Reviewer',
      },
    }),
    blank: frozenTheme({
      summary: 'An empty starter with no sample content',
      answers: {},
      content: {
        instructions:
          'You are a helpful assistant. Answer clearly and briefly, and say so when you are not sure.',
        prompts: [],
        title: 'Assistant',
      },
    }),
  });

/**
 * Fills every unanswered question that applies: first with the chosen theme's recommendations
 * (`support` when no theme is given), then with each question's own. The input is not changed.
 *
 * @throws {z.ZodError} when the answers are inconsistent, e.g. an OpenAPI document without the
 *   `openapi` tool.
 */
export function withRecommendedAnswers(answers: SetupAnswers): CompleteSetupAnswers {
  const theme = answers['setup.theme'] ?? themeQuestion.recommended;
  const merged: Record<string, unknown> = {
    ...THEME_RECOMMENDATIONS[theme].answers,
    ...Object.fromEntries(Object.entries(answers).filter(([, value]) => value !== undefined)),
    'setup.theme': theme,
  };
  for (const question of SETUP_QUESTIONS) {
    if (merged[question.id] === undefined && setupQuestionApplies(question, merged)) {
      merged[question.id] = question.recommended;
    }
  }
  return CompleteSetupAnswersSchema.parse(merged);
}

/**
 * The usage forms (`--model-base-url <url>`) of the questions that apply to `answers` but have only
 * a placeholder to fall back on, so a run that takes recommended answers (`--yes`, no terminal)
 * cannot continue without them. Empty when nothing is missing. Unlike
 * {@link withRecommendedAnswers} it never throws, so the interview can still prefill a default.
 */
export function unansweredSetupFlags(answers: SetupAnswers): readonly string[] {
  const merged: Record<string, unknown> = {
    ...THEME_RECOMMENDATIONS[answers['setup.theme'] ?? themeQuestion.recommended].answers,
    ...Object.fromEntries(Object.entries(answers).filter(([, value]) => value !== undefined)),
  };
  return SETUP_QUESTIONS.flatMap((question) =>
    question.placeholder !== undefined &&
    merged[question.id] === undefined &&
    setupQuestionApplies(question, merged)
      ? [`--${question.flag} <${question.placeholder}>`]
      : [],
  );
}
