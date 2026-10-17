import {
  SETUP_QUESTIONS,
  SetupAnswersSchema,
  setupQuestionApplies,
  THEME_RECOMMENDATIONS,
  unansweredSetupFlags,
  withRecommendedAnswers,
  type CompleteSetupAnswers,
  type SetupAnswerFormat,
  type SetupAnswers,
} from '@indx-workspace/contracts/setup';

import type { Choose, MenuOption } from './choose.js';
import { ProjectFileError, readProjectFileText } from './reader.js';

/** How a prompt shows an answer format, the grammar a refusal names, and how typed text is read. */
function promptFormat(format: SetupAnswerFormat): {
  readonly shown: string;
  readonly grammar: string;
  readonly read: (typed: string) => string | readonly string[];
} {
  switch (format.kind) {
    case 'choice':
      return {
        shown: format.choices.join(' | '),
        grammar: `one of ${format.choices.join(', ')}`,
        read: (typed) => typed,
      };
    case 'multi':
      return {
        shown: `${format.choices.join(' | ')}; comma-separated`,
        grammar: `up to ${String(format.max)} of ${format.choices.join(', ')}, separated by commas`,
        read: (typed) => typed.split(',').map((choice) => choice.trim()),
      };
    case 'text':
      return { shown: format.grammar, grammar: format.grammar, read: (typed) => typed };
  }
}

/** The line a refused answer gets, in the interview and for a flag alike. */
function refusal(answer: string | readonly string[], grammar: string): string {
  const noneAlone =
    typeof answer !== 'string' && answer.length > 1 && answer.includes('none')
      ? '; none must be chosen alone'
      : '';
  return `${JSON.stringify(answer)} is not accepted: ${grammar}${noneAlone}`;
}

/**
 * Reads the answers given as flags (issue #689), `given` keyed by flag name, in question order. A
 * refused value throws the interview's own message, prefixed with its flag.
 *
 * @throws {Error} when a value is not accepted with the answers before it.
 */
export function parseSetupFlags(given: Readonly<Record<string, string | undefined>>): SetupAnswers {
  let answers: SetupAnswers = {};
  for (const question of SETUP_QUESTIONS) {
    const typed = given[question.flag];
    if (typed === undefined) continue;
    const { grammar, read } = promptFormat(question.answer);
    const answer = read(typed.trim());
    const parsed = SetupAnswersSchema.safeParse({ ...answers, [question.id]: answer });
    if (!parsed.success) {
      const conditional = parsed.error.issues.find((issue) =>
        issue.message.startsWith('is asked only when'),
      );
      throw new Error(`--${question.flag}: ${conditional?.message ?? refusal(answer, grammar)}`);
    }
    answers = parsed.data;
  }
  return answers;
}

/** One `--help` entry per setup flag: two lines, the flag, then the question and its default. */
export function setupFlagsHelp(): readonly string[] {
  return SETUP_QUESTIONS.map((question) => {
    const { shown } = promptFormat(question.answer);
    const recommended =
      typeof question.recommended === 'string'
        ? question.recommended
        : question.recommended.join(',');
    // BH061-044: a question with only a placeholder has no default to take; say when it is required.
    const when = question.when;
    const whenFlag =
      when === undefined ? undefined : SETUP_QUESTIONS.find((other) => other.id === when.id)?.flag;
    const condition =
      when !== undefined && whenFlag !== undefined && 'oneOf' in when
        ? ` when --${whenFlag} is ${when.oneOf.join(' or ')}`
        : '';
    const tail =
      question.placeholder === undefined
        ? `default: ${recommended}`
        : `required${condition}; no default`;
    return `  --${question.flag} <${shown}>
      ${question.prompt} (${tail})`;
  });
}

/**
 * The one setup question loop `create` and `aw init` ask through (C20; issue #543). It is
 * isomorphic: `prompt` shows one question and resolves with the typed line, and `say` shows one
 * line of output; the caller owns the terminal.
 *
 * Asks each of `SETUP_QUESTIONS` that applies, in order; a question whose `when` the answers so
 * far do not meet is skipped. An empty line takes the recommended answer — the chosen theme's,
 * then the question's own; a multi answer is typed comma-separated. An answer
 * `SetupAnswersSchema` refuses together with the earlier answers is passed to `say` with its
 * grammar, and the same question is asked again. A question `preset` already answers (from a flag)
 * is not asked.
 *
 * With `choose` (a terminal's arrow-key menu) every choice and multi question is a menu with the
 * recommendation preselected, and a theme shows its one-line summary; without it the typed path
 * above is used. Text questions are always typed.
 */
export async function askSetupQuestions(
  prompt: (question: string) => Promise<string>,
  say: (line: string) => void,
  preset: SetupAnswers = {},
  choose?: Choose,
): Promise<CompleteSetupAnswers> {
  let given: SetupAnswers = preset;
  for (const question of SETUP_QUESTIONS) {
    if (!setupQuestionApplies(question, given) || given[question.id] !== undefined) continue;
    const { shown, grammar, read } = promptFormat(question.answer);
    const recommended = withRecommendedAnswers(given)[question.id] ?? question.recommended;
    const recommendedText = typeof recommended === 'string' ? recommended : recommended.join(',');
    const answerOne = async (): Promise<string | readonly string[]> => {
      const format = question.answer;
      if (choose !== undefined && format.kind !== 'text') {
        const options: readonly MenuOption[] = format.choices.map((value) =>
          question.id === 'setup.theme' && value in THEME_RECOMMENDATIONS
            ? {
                value,
                hint: THEME_RECOMMENDATIONS[value as keyof typeof THEME_RECOMMENDATIONS].summary,
              }
            : { value },
        );
        const initial = typeof recommended === 'string' ? [recommended] : recommended;
        const picked = await choose({
          title: question.prompt,
          options,
          initial,
          ...(format.kind === 'multi' ? { max: format.max } : {}),
        });
        return format.kind === 'multi' ? picked : (picked[0] ?? '');
      }
      const typed = await prompt(`${question.prompt} (${shown}) [${recommendedText}] `);
      return typed.trim() === '' ? recommended : read(typed.trim());
    };
    for (;;) {
      const answer = await answerOne();
      const parsed = SetupAnswersSchema.safeParse({ ...given, [question.id]: answer });
      if (parsed.success) {
        given = parsed.data;
        break;
      }
      say(refusal(answer, grammar));
    }
  }
  return withRecommendedAnswers(given);
}

/** What decides whether a person can answer: the two streams and the environment. */
export interface InteractionFacts {
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** `CI` set to anything but empty, `0` or `false` (any case) says no person is present. */
function isCi(env: InteractionFacts['env']): boolean {
  const value = (env['CI'] ?? '').trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false';
}

/**
 * The one rule for "may this command prompt": both streams are a terminal and `CI` is not set. A CI
 * runner that allocates a pseudo-terminal is still not a person.
 */
export function isInteractive({ stdinIsTty, stdoutIsTty, env }: InteractionFacts): boolean {
  return stdinIsTty && stdoutIsTty && !isCi(env);
}

/**
 * Reads an answers file (YAML, or JSON, which is YAML): an object keyed by question id, each
 * value what `SetupAnswersSchema` accepts for it. A refusal names `source`, the line and the key.
 *
 * @throws {ProjectFileError} when the file is not readable YAML, not an object, or an answer is
 *   unknown, malformed or inconsistent with the others in the file.
 */
export function parseSetupAnswersFile(text: string, source: string): SetupAnswers {
  const { value, locate } = readProjectFileText(text, source);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectFileError(
      locate([]),
      'must be an object keyed by setup question id (for example content.engine: claude-agent-sdk)',
      undefined,
      source,
    );
  }
  const parsed = SetupAnswersSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const key = issue?.code === 'unrecognized_keys' ? issue.keys[0] : issue?.path[0];
  const named = typeof key === 'string' ? key : undefined;
  const detail =
    issue?.code === 'unrecognized_keys'
      ? `${JSON.stringify(named)} is not a setup question id (one of ${SETUP_QUESTIONS.map((question) => question.id).join(', ')})`
      : `${named ?? 'answers'}: ${issue?.message ?? 'not accepted'}`;
  throw new ProjectFileError(locate(named === undefined ? [] : [named]), detail, named, source);
}

/**
 * Flags laid over an answers file: a question answered by both keeps the flag's answer. The merged
 * answers are validated together, so a conditional answer in one source is checked against the
 * other's.
 *
 * @throws {Error} naming the question when the merged answers are inconsistent.
 */
export function mergeSetupAnswers(file: SetupAnswers, flags: SetupAnswers): SetupAnswers {
  const merged = SetupAnswersSchema.safeParse({ ...file, ...flags });
  if (merged.success) return merged.data;
  const [issue] = merged.error.issues;
  throw new Error(`${String(issue?.path[0] ?? 'answers')}: ${issue?.message ?? 'not accepted'}`);
}

/**
 * What a run that takes recommended answers (`--yes`, no terminal, `CI`) says when a question has
 * no usable default: the message and the one `fix:` line. `null` when every answer can be taken.
 * Checked before anything is rendered or written.
 */
export function unansweredSetupRefusal(
  answers: SetupAnswers,
): { readonly message: string; readonly fix: string } | null {
  const missing = unansweredSetupFlags(answers);
  if (missing.length === 0) return null;
  const names = missing.map((usage) => usage.split(' ')[0]).join(' and ');
  return {
    message: `${names} is required here: it has no default and nothing can ask for it`,
    fix: `add ${missing.join(' ')}`,
  };
}
