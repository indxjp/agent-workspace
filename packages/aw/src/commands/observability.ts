import { command, integerValue, isOn, value, type Command } from '../command.js';
import { notice } from '../output.js';

const TELEMETRY_COLUMNS = ['runId', 'agentId', 'status', 'durationMs', 'costUsd'];
const AUDIT_COLUMNS = ['createdAt', 'actorLabel', 'action', 'subjectLabel', 'subjectId'];

/** §5.14 — `aw metrics` and `aw audit`. */
export const observabilityCommands: readonly Command[] = [
  command(
    'metrics recent-runs',
    '',
    "This process's recently finished runs (a window, not the run store)",
    async ({ client, signal }) => ({
      value: await client.observability.metrics.recentRuns({ signal }),
      columns: TELEMETRY_COLUMNS,
    }),
  ),
  command(
    'audit list',
    '[--limit <1-500>] [--cursor <cursor>] [--all]',
    'The audit trail, newest first: one page, or every page with --all',
    async (context) => {
      const limit = integerValue(context, 'limit');
      const cursor = value(context, 'cursor');
      const query = {
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      };
      const { client, signal, mode, io } = context;
      if (isOn(context, 'all')) {
        const events = [];
        for await (const event of client.observability.audit.listAll(query, { signal })) {
          events.push(event);
        }
        return { value: events, columns: AUDIT_COLUMNS };
      }
      const page = await client.observability.audit.list(query, { signal });
      if (mode.json || mode.jsonl) return { value: page };
      if (page.nextCursor !== null) notice(io, mode, `next page: --cursor ${page.nextCursor}`);
      return { value: page.events, columns: AUDIT_COLUMNS };
    },
  ),
];
