import { readFile } from 'node:fs/promises';

import { RUN_STATUSES } from '@indx-workspace/contracts/runs';
import type { RunResource } from '@indx-workspace/contracts/runs';
import { runFailure, type RunEventsOptions, type StartRunInput } from '@indx-workspace/sdk';
import { toAgentEvent } from '@indx-workspace/sdk/events';

import {
  command,
  enumValue,
  integerValue,
  isOn,
  positional,
  singleValue,
  value,
  type Command,
  type CommandContext,
  type CommandResult,
} from '../command.js';
import { RunFailedError, UsageError } from '../io.js';
import { notice } from '../output.js';
import { printStream } from '../stream.js';
import { buildTrace, costText, renderTrace, type TimedEvent } from './runs-trace.js';

const RUN_COLUMNS = ['id', 'agentId', 'sessionId', 'status', 'createdAt', 'endedAt', 'durationMs'];

/**
 * How long `--interrupt-on-cancel` may hold the process open after SIGINT.
 *
 * The user has already asked to stop, and `index.ts` has removed its SIGINT handler by the time
 * this call is made, so a control plane that accepts the connection and stalls would otherwise
 * need a second Ctrl-C to escape. The CLI's client carries a deadline only when `--timeout` was
 * passed, so this courtesy call brings its own.
 */
const INTERRUPT_ON_CANCEL_TIMEOUT_MS = 5_000;

async function promptOf(context: CommandContext): Promise<string> {
  const inline = value(context, 'prompt');
  const file = value(context, 'prompt-file');
  if (inline !== undefined && file !== undefined) {
    throw new UsageError('--prompt and --prompt-file are alternatives');
  }
  if (inline !== undefined) return inline;
  if (file === undefined)
    throw new UsageError('--prompt <text> or --prompt-file <path> is required');
  if (file === '-') return context.readStdin('--prompt-file -');
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw new UsageError(`could not read ${file}`);
  }
}

/** `--model <connection-id>:<model>`: a connection and a model, always together (§5.3). */
function modelOverride(
  context: CommandContext,
): Exclude<StartRunInput['modelOverride'], undefined> {
  const raw = value(context, 'model');
  if (raw === undefined) return null;
  const colon = raw.indexOf(':');
  const connectionId = colon === -1 ? '' : raw.slice(0, colon);
  const model = colon === -1 ? '' : raw.slice(colon + 1);
  if (connectionId === '' || model === '') {
    throw new UsageError('--model must be <connection-id>:<model>');
  }
  return { connectionId, model };
}

function eventsOptions(context: CommandContext): RunEventsOptions {
  const after = value(context, 'after');
  return { signal: context.signal, ...(after === undefined ? {} : { after }) };
}

/** `--fail-on-error`: a settled run that failed becomes the command's failure, with its code. */
function assertRunSucceeded(run: RunResource): void {
  const failure = runFailure(run);
  if (failure !== null) throw new RunFailedError(run.id, failure.code, failure.message);
}

async function start(context: CommandContext): Promise<CommandResult | undefined> {
  const wait = isOn(context, 'wait');
  const follow = isOn(context, 'follow');
  const failOnError = isOn(context, 'fail-on-error');
  if (wait && follow) throw new UsageError('--wait and --follow are alternatives');
  if (failOnError && !wait && !follow) {
    throw new UsageError(
      '--fail-on-error needs --wait or --follow: a queued run has no outcome yet',
    );
  }
  const { client, signal, mode, io } = context;
  const started = await client.runs.start(
    positional(context, 0, 'agent'),
    {
      prompt: await promptOf(context),
      sessionId: value(context, 'session') ?? null,
      modelOverride: modelOverride(context),
    },
    { signal },
  );
  if (!wait && !follow) return { value: started.run };
  notice(io, mode, `run ${started.run.id} started`);
  if (wait) {
    const settled = await client.runs.waitForOutcome(started.run.id, { signal });
    if (failOnError) assertRunSucceeded(settled);
    return { value: settled };
  }
  await printStream(io, mode, client.runs.follow(started.run.id, { signal }));
  if (failOnError) assertRunSucceeded(await client.runs.get(started.run.id, { signal }));
  return undefined;
}

/** §5.12 — `aw runs`. `revoke-tokens` has no CLI command (§7.2 lists only `interrupt`). */
export const runCommands: readonly Command[] = [
  command(
    'runs start',
    '<agent> --prompt <text>|--prompt-file <path> [--session <id>] [--model <conn>:<model>] [--wait|--follow] [--fail-on-error]',
    'Queue a run, and optionally wait for or follow it',
    start,
  ),
  command('runs get', '<id>', 'One run', async (context) => {
    const run = await context.client.runs.get(positional(context, 0, 'id'), {
      signal: context.signal,
    });
    const { mode } = context;
    return { value: mode.json || mode.jsonl ? run : { ...run, cost: costText(run) } };
  }),
  command(
    'runs list',
    '[--status <status>] [--agent <id>] [--project <id>] [--limit <n>] [--cursor <cursor>]',
    'One page of run history, newest first',
    async (context) => {
      const status = enumValue(context, 'status', RUN_STATUSES);
      const agent = singleValue(context, 'agent');
      const project = value(context, 'project');
      const limit = integerValue(context, 'limit');
      const cursor = value(context, 'cursor');
      const page = await context.client.runs.list(
        {
          ...(status === undefined ? {} : { status }),
          ...(agent === undefined ? {} : { agent }),
          ...(project === undefined ? {} : { project }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        },
        { signal: context.signal },
      );
      const { mode } = context;
      if (mode.json && !mode.jsonl) return { value: page };
      if (page.nextCursor !== null)
        notice(context.io, mode, `next page: --cursor ${page.nextCursor}`);
      return { value: page.runs, columns: RUN_COLUMNS };
    },
  ),
  command(
    'runs events',
    '<id> [--after <event-id>]',
    'Stream the run on one connection',
    async (context) => {
      await printStream(
        context.io,
        context.mode,
        context.client.runs.events(positional(context, 0, 'id'), eventsOptions(context)),
      );
      return undefined;
    },
  ),
  command(
    'runs trace',
    '<id>',
    "A run's steps and tool calls as a tree, with inputs, outputs, tokens and cost",
    async (context) => {
      const id = positional(context, 0, 'id');
      const { client, io, mode, signal } = context;
      const events: TimedEvent[] = [];
      for await (const frame of client.runs.events(id, { signal })) {
        const event = toAgentEvent(frame);
        const at = frame.kind === 'run-status' || frame.kind === 'runtime' ? frame.at : undefined;
        if (event !== null) events.push({ event, at: at ?? null });
      }
      // Read after the stream: the metered usage and cost settle as the run ends.
      const trace = buildTrace(await client.runs.get(id, { signal }), events);
      if (mode.json || mode.jsonl) return { value: trace };
      for (const line of renderTrace(trace)) io.stdout(`${line}\n`);
      return undefined;
    },
  ),
  command(
    'runs follow',
    '<id> [--after <event-id>] [--interrupt-on-cancel]',
    'Stream the run, reconnecting with the last event id',
    async (context) => {
      const id = positional(context, 0, 'id');
      try {
        await printStream(
          context.io,
          context.mode,
          context.client.runs.follow(id, eventsOptions(context)),
        );
      } catch (error) {
        // §7.3: SIGINT aborts `context.signal`, which is what ends the stream this way. A fresh
        // signal is used for the interrupt call itself — the aborted one would fail it instantly —
        // and the original error is rethrown unchanged so the exit code stays 130 either way.
        if (isOn(context, 'interrupt-on-cancel') && context.signal.aborted) {
          await context.client.runs
            .interrupt(id, { signal: AbortSignal.timeout(INTERRUPT_ON_CANCEL_TIMEOUT_MS) })
            .catch(() => undefined);
        }
        throw error;
      }
      return undefined;
    },
  ),
  command('runs interrupt', '<id>', 'Stop a run this caller may run', async (context) => ({
    value: await context.client.runs.interrupt(positional(context, 0, 'id'), {
      signal: context.signal,
    }),
  })),
  command(
    'runs rate',
    '<id> --up|--down [--comment <text>]',
    "Rate a run's answer thumbs-up or -down, as the widget does",
    async (context) => {
      const up = isOn(context, 'up');
      if (up === isOn(context, 'down')) throw new UsageError('pass one of --up or --down');
      const id = positional(context, 0, 'id');
      const rating = up ? 'up' : 'down';
      const comment = value(context, 'comment');
      await context.client.runs.rate(
        id,
        { rating, ...(comment === undefined ? {} : { comment }) },
        { signal: context.signal },
      );
      notice(context.io, context.mode, `run ${id} rated ${rating}`);
      return { value: undefined };
    },
  ),
  command(
    'runs wait',
    '<id>',
    'Follow the run to its end and print the settled record',
    async (context) => ({
      value: await context.client.runs.waitForOutcome(positional(context, 0, 'id'), {
        signal: context.signal,
      }),
    }),
  ),
];
