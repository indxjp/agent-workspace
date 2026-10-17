import {
  AGENT_ENVIRONMENTS,
  AGENT_VERSION_NUMBER_MAX,
  AgentEnvironmentSchema,
  AgentVersionBodySchema,
  AgentVersionSummarySchema,
  type AgentEnvironment,
  type AgentVersionDraftInput,
  type AgentVersionListResponse,
} from '@indx-workspace/contracts/agent-versions';

import {
  command,
  isOn,
  positional,
  readBody,
  value,
  type Command,
  type CommandContext,
} from '../command.js';
import { UsageError } from '../io.js';
import { renderTable } from '../output.js';

/** The summary `aw agents versions create` saves when `--summary` is not given. */
const DEFAULT_CREATE_SUMMARY = 'aw agents versions create';

const VERSION_COLUMNS = ['number', 'summary', 'via', 'createdAt', 'score'];
const MOVE_COLUMNS = ['movedAt', 'environment', 'version', 'reason'];

/** `--summary`, else `fallback`; refused by name when the contract would refuse it. */
function summaryOf(context: CommandContext, fallback: string): string {
  const given = value(context, 'summary');
  if (given === undefined) return fallback;
  const parsed = AgentVersionSummarySchema.safeParse(given);
  if (!parsed.success) {
    const reasons = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw new UsageError(`--summary is not a valid version summary: ${reasons}`);
  }
  return parsed.data;
}

function environmentOf(context: CommandContext): AgentEnvironment {
  const raw = positional(context, 1, 'environment');
  const parsed = AgentEnvironmentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(`<environment> must be one of ${AGENT_ENVIRONMENTS.join(', ')}`);
  }
  return parsed.data;
}

/**
 * The version is a positional, not `--version`, because `--version` is the global switch that
 * prints the CLI's own version.
 */
export function versionNumberOf(context: CommandContext, index: number): number {
  const raw = positional(context, index, 'version');
  const parsed = /^[1-9][0-9]*$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed > AGENT_VERSION_NUMBER_MAX) {
    throw new UsageError(
      `<version> must be a positive integer no larger than ${String(AGENT_VERSION_NUMBER_MAX)}`,
    );
  }
  return parsed;
}

/**
 * The versions as a table (with each version's newest evaluation score, issue #736), then one `<environment> -> <number>` line per pointer, then the pointer
 * moves newest first when the server lists any (issue #615).
 */
export function renderVersions(list: AgentVersionListResponse): string {
  const table =
    list.items.length === 0
      ? '(no versions)'
      : renderTable(
          list.items.map((item) => {
            const evaluation = list.evaluations.find((each) => each.version === item.number);
            return { ...item, score: evaluation === undefined ? '—' : evaluation.score.toFixed(2) };
          }),
          VERSION_COLUMNS,
        );
  const pointers =
    list.pointers.length === 0
      ? ['(no pointers)']
      : list.pointers.map((pointer) => `${pointer.environment} -> ${String(pointer.number)}`);
  const moves =
    list.moves.length === 0
      ? []
      : [
          '',
          renderTable(
            list.moves.map(({ movedAt, environment, number, reason }) => ({
              movedAt,
              environment,
              version: number,
              reason,
            })),
            MOVE_COLUMNS,
          ),
        ];
  return [table, '', ...pointers, ...moves].join('\n');
}

/**
 * Issue #452 (S1-14) — the raw version and pointer commands behind `aw push` (ADR-0101). Each
 * command that changes something has a read-only form and saves only with `--yes` (roadmap §5).
 */
export const agentVersionCommands: readonly Command[] = [
  command(
    'agents versions list',
    '<id>',
    "An agent's versions and which version each environment runs",
    async (context) => {
      const list = await context.client.agents.versions.list(positional(context, 0, 'id'), {
        signal: context.signal,
      });
      if (context.mode.json || context.mode.jsonl) return { value: list };
      context.io.stdout(`${renderVersions(list)}\n`);
      return undefined;
    },
  ),
  command(
    'agents versions create',
    '<id> --file <json> [--summary <text>] [--yes]',
    'Check a version body, and save it as the next version with --yes',
    async (context) => {
      const agentId = positional(context, 0, 'id');
      const summary = summaryOf(context, DEFAULT_CREATE_SUMMARY);
      const body = await readBody(context, AgentVersionBodySchema);
      const draft: AgentVersionDraftInput = { body, summary, via: 'api' };
      if (isOn(context, 'yes')) {
        return {
          value: await context.client.agents.versions.create(agentId, draft, {
            signal: context.signal,
          }),
        };
      }
      const check = await context.client.agents.versions.check(agentId, draft, {
        signal: context.signal,
      });
      if (context.mode.json || context.mode.jsonl) return { value: check };
      context.io.stdout(`would be saved as version ${String(check.number)}; pass --yes to save\n`);
      return undefined;
    },
  ),
  command(
    'agents pointers set',
    '<id> <environment> <version> [--yes]',
    'Show a pointer move, and point an environment at a version with --yes',
    async (context) => {
      const agentId = positional(context, 0, 'id');
      const environment = environmentOf(context);
      const version = versionNumberOf(context, 2);
      if (isOn(context, 'yes')) {
        return {
          value: await context.client.agents.pointers.set(
            agentId,
            { environment, version },
            { signal: context.signal },
          ),
        };
      }
      const list = await context.client.agents.versions.list(agentId, { signal: context.signal });
      const current =
        list.pointers.find((pointer) => pointer.environment === environment)?.number ?? null;
      if (context.mode.json || context.mode.jsonl) {
        return { value: { environment, from: current, to: version, saved: false } };
      }
      context.io.stdout(
        `${environment}: ${current === null ? 'none' : String(current)} -> ${String(version)}; pass --yes to move it\n`,
      );
      return undefined;
    },
  ),
];
