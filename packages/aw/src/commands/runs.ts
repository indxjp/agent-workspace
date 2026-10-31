import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { UUID_PATTERN } from '@indx-workspace/contracts';
import { outputSchemaViolation, RUN_STATUSES } from '@indx-workspace/contracts/runs';
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
  values,
  type Command,
  type CommandContext,
  type CommandResult,
} from '../command.js';
import { RunFailedError, UsageError } from '../io.js';
import { notice } from '../output.js';
import { printStream } from '../stream.js';
import { buildTrace, costText, renderTrace, type TimedEvent } from './runs-trace.js';

const OUTPUT_COLUMNS = ['name', 'sizeBytes', 'contentType', 'lastModified'];
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

/** `--output-schema <path>`: a JSON Schema file, judged by the contracts' rule before any request. */
async function outputSchemaOf(
  context: CommandContext,
): Promise<Exclude<StartRunInput['outputSchema'], undefined> | undefined> {
  const file = value(context, 'output-schema');
  if (file === undefined) return undefined;
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new UsageError(`could not read ${file}`);
  }
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch {
    throw new UsageError(`--output-schema must be a JSON file: ${file} is not valid JSON`);
  }
  const found = outputSchemaViolation(schema);
  if (found !== null) throw new UsageError(`--output-schema ${file}: ${found.message}`);
  // The rule above has established a plain object at the root.
  return schema as Record<string, unknown>;
}

/**
 * `--attach <file>`: a workspace file id, or a workspace path (`./`, `/` and `.` segments allowed,
 * `..` refused) resolved to its id from its folder's listing. The server grants every attachment
 * read-only (ADR-0146); uploading a local file is not part of it.
 */
// @story US-STO-06
async function attachmentsOf(context: CommandContext): Promise<{ readonly fileId: string }[]> {
  const attachments: { readonly fileId: string }[] = [];
  for (const file of values(context, 'attach')) {
    if (UUID_PATTERN.test(file)) {
      attachments.push({ fileId: file });
      continue;
    }
    // `./reports/q3.txt`, `/reports/q3.txt` and `././reports/./q3.txt` all name the workspace
    // path `reports/q3.txt`: empty and `.` segments are dropped, a `..` is refused.
    const segments = file.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.includes('..'))
      throw new UsageError(`--attach ${file}: a workspace path may not contain ".."`);
    const wanted = segments.join('/');
    const slash = wanted.lastIndexOf('/');
    const listed = await context.client.files.list(
      slash === -1 ? {} : { path: wanted.slice(0, slash) },
      { signal: context.signal },
    );
    const found = listed.find((entry) => entry.path === wanted);
    if (found === undefined)
      throw new UsageError(`--attach ${file}: no workspace file at that path`);
    attachments.push({ fileId: found.id });
  }
  return attachments;
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

/**
 * `--idempotency-key <key>` (issue #250, S-6): sent as the `Idempotency-Key` header, so a start
 * retried with the same key and input answers with the run the first one started. A blank key is
 * refused here, before any request; the server judges the length (`400 invalid_idempotency_key`).
 */
function idempotencyKeyOf(context: CommandContext): { readonly idempotencyKey?: string } {
  const key = value(context, 'idempotency-key');
  if (key === undefined) return {};
  if (key.trim() === '') throw new UsageError('--idempotency-key must not be blank');
  return { idempotencyKey: key };
}

function eventsOptions(context: CommandContext): RunEventsOptions {
  const after = value(context, 'after');
  return { signal: context.signal, ...(after === undefined ? {} : { after }) };
}

function commentOf(context: CommandContext): { readonly comment?: string } {
  const comment = value(context, 'comment');
  return comment === undefined ? {} : { comment };
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
  const idempotency = idempotencyKeyOf(context);
  const prompt = await promptOf(context);
  const outputSchema = await outputSchemaOf(context);
  const fileScope = values(context, 'file-scope');
  const attachments = await attachmentsOf(context);
  const started = await client.runs.start(
    positional(context, 0, 'agent'),
    {
      prompt,
      sessionId: value(context, 'session') ?? null,
      modelOverride: modelOverride(context),
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(fileScope.length === 0 ? {} : { fileScope }),
      ...(attachments.length === 0 ? {} : { attachments }),
      ...idempotency,
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

/** Where `--download <dir>` puts a file; a name that climbs out of `<dir>` is refused. */
function downloadTarget(directory: string, name: string): string {
  const root = path.resolve(directory);
  const target = path.resolve(root, name);
  if (!target.startsWith(root + path.sep)) throw new UsageError(`refusing to write ${name}`);
  return target;
}

async function outputs(context: CommandContext): Promise<CommandResult> {
  const { client, signal } = context;
  const files = await client.runs.outputs(positional(context, 0, 'id'), { signal });
  const directory = value(context, 'download');
  if (directory === undefined) return { value: files, columns: OUTPUT_COLUMNS };
  // Every name is checked before the first byte is written.
  const planned = files.map((file) => ({ file, target: downloadTarget(directory, file.name) }));
  const saved = [];
  for (const { file, target } of planned) {
    const downloaded = await client.files.download(file.path, { signal });
    if (downloaded.kind === 'folder') continue;
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, downloaded.bytes);
    } catch {
      throw new UsageError(`could not write ${target}`);
    }
    notice(context.io, context.mode, `saved ${file.name} to ${target}`);
    saved.push({ ...file, savedTo: target });
  }
  return { value: saved, columns: [...OUTPUT_COLUMNS, 'savedTo'] };
}

/** §5.12 — `aw runs`. `revoke-tokens` has no CLI command (§7.2 lists only `interrupt`). */
export const runCommands: readonly Command[] = [
  command(
    'runs start',
    '<agent> --prompt <text>|--prompt-file <path> [--session <id>] [--model <conn>:<model>] [--output-schema <path>] [--file-scope <path>]... [--attach <file-id|path>]... [--idempotency-key <key>] [--wait|--follow] [--fail-on-error]',
    'Queue a run, and optionally wait for or follow it',
    start,
  ),
  command('runs get', '<id>', 'One run', async (context) => {
    const run = await context.client.runs.get(positional(context, 0, 'id'), {
      signal: context.signal,
    });
    const { mode } = context;
    if (mode.json || mode.jsonl) return { value: run };
    const shown = Object.entries(run).map(([key, field]) => [
      key === 'agentVersion' ? 'version' : key,
      field,
    ]);
    return { value: { ...Object.fromEntries(shown), cost: costText(run) } };
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
    'runs outputs',
    '<id> [--download <dir>]',
    'The files a run wrote, optionally saved under a local directory',
    outputs,
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
        const at =
          frame.kind === 'run-status' || frame.kind === 'run-warning' || frame.kind === 'runtime'
            ? frame.at
            : undefined;
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
    'runs approve',
    '<id> [--comment <text>]',
    'Approve the tool call a paused run is waiting on; starts the continuation run',
    async (context) => ({
      value: await context.client.runs.approve(positional(context, 0, 'id'), commentOf(context), {
        signal: context.signal,
      }),
    }),
  ),
  command(
    'runs reject',
    '<id> [--comment <text>]',
    'Reject the tool call a paused run is waiting on; starts the continuation run',
    async (context) => ({
      value: await context.client.runs.reject(positional(context, 0, 'id'), commentOf(context), {
        signal: context.signal,
      }),
    }),
  ),
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
