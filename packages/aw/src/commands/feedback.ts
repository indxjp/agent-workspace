import { command, isOn, value, type ApiCommand, type CommandContext } from '../command.js';
import { UsageError } from '../io.js';
import { soleEvalAgent } from '../project/index.js';
import { agentIdNamed } from './eval.js';
import { projectRoot } from './project.js';

const COLUMNS = ['run', 'rating', 'input', 'answer', 'comment'];
const CELL_MAX = 60;
const UNIT_MS = { d: 86_400_000, h: 3_600_000 } as const;

/** `--since 7d` or `12h` as the instant that long ago; the default is a week. */
function sinceInstant(context: CommandContext): string {
  const raw = value(context, 'since') ?? '7d';
  const match = /^([1-9]\d{0,3})([dh])$/u.exec(raw);
  const amount = match?.[1];
  const unit = match?.[2];
  if (amount === undefined || (unit !== 'd' && unit !== 'h')) {
    throw new UsageError('--since must be a number of days or hours, such as 7d or 12h');
  }
  return new Date(Date.now() - Number(amount) * UNIT_MS[unit]).toISOString();
}

/** One line, at most {@link CELL_MAX} characters, so a table row stays a row. */
function short(text: string | null): string {
  if (text === null) return '';
  const line = text.replaceAll(/\s+/gu, ' ').trim();
  return line.length > CELL_MAX ? `${line.slice(0, CELL_MAX - 1)}…` : line;
}

/**
 * Issue #620: `aw feedback [agent] [--negative] [--since 7d]` lists the ratings of the agent's runs
 * since then, newest first: run id, input, answer and comment. `aw eval add-case <runId>` turns a
 * thumbs-down into an evaluation case.
 */
export const feedbackCommands: readonly ApiCommand[] = [
  command(
    'feedback',
    '[agent] [--negative] [--since <7d|12h>]',
    "List the ratings of an agent's runs: run id, input, answer and comment",
    async (context) => {
      const since = sinceInstant(context);
      const agentName = context.positionals[0] ?? (await soleEvalAgent(projectRoot(context)));
      const agentId = await agentIdNamed(context, agentName);
      const items = await context.client.agents.feedback.list(
        agentId,
        { since, ...(isOn(context, 'negative') ? { rating: 'down' } : {}) },
        { signal: context.signal },
      );
      if (context.mode.json || context.mode.jsonl) return { value: items };
      const rows = items.map((item) => ({
        run: item.runId,
        rating: item.rating,
        input: short(item.input),
        answer: short(item.answer),
        comment: short(item.comment),
      }));
      return { value: rows, columns: COLUMNS };
    },
  ),
];
