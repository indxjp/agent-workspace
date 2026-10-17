import {
  AGENT_ENVIRONMENTS,
  AGENT_VERSION_NUMBER_MAX,
} from '@indx-workspace/contracts/agent-versions';
import type { RunResource } from '@indx-workspace/contracts/runs';
import { runFailure, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import {
  assistantResponseFromAgentEvent,
  toAgentEvent,
  type RunEventFrame,
} from '@indx-workspace/sdk/events';

import {
  command,
  enumValue,
  integerValue,
  positional,
  value,
  type CommandContext,
  type CommandResult,
} from '../command.js';
import {
  CommandRefusedError,
  InterruptedError,
  RunFailedError,
  UsageError,
  type ChatTerminal,
  type CliIo,
} from '../io.js';
import { nonBlank } from '../config.js';
import {
  DEFAULT_MODEL_SECRET,
  modelSecretNames,
  readLocalProject,
} from '../local-runtime/project.js';
import { setKeyText } from '../local-runtime/project-resources.js';
import { writeResult } from '../output.js';
import { agentIdNamed } from './eval.js';

/** Long enough for a courtesy call after Ctrl-C, short enough that a stalled server cannot hold the exit. */
const INTERRUPT_TIMEOUT_MS = 5_000;

/** The courtesy call after Ctrl-C: a fresh signal, because the aborted one would fail it at once. */
async function interruptQuietly(client: AgentWorkspaceClient, runId: string): Promise<void> {
  await client.runs
    .interrupt(runId, { signal: AbortSignal.timeout(INTERRUPT_TIMEOUT_MS) })
    .catch(() => undefined);
}

/** UX-G (#760): the host is this machine, so the runtime is the project's own `aw dev`. */
function isLocalTarget(baseUrl: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The one-line answer to a run that failed for want of a model key on a local `aw dev` runtime:
 * the line that sets the project's own key variable(s) for this shell (the unset ones, as `aw dev`
 * reads them), then the restart. `undefined` for any other failure or target, or when the project
 * cannot be read, which keep the full problem text.
 */
async function localKeyProblem(
  context: CommandContext,
  failure: { readonly code: string | null },
): Promise<string | undefined> {
  if (failure.code !== 'model_connection_unresolved' || !isLocalTarget(context.baseUrl)) {
    return undefined;
  }
  let names: readonly string[];
  try {
    const read = context.io.cwd === undefined ? null : await readLocalProject(context.io.cwd);
    names = read === null ? [DEFAULT_MODEL_SECRET] : modelSecretNames(read);
  } catch {
    return undefined;
  }
  const unset = names.filter((name) => nonBlank(context.io.env[name]) === undefined);
  const set = (unset.length > 0 ? unset : names).map((name) => setKeyText(name)).join('; ');
  return `no model key: ${set}, then restart npm run dev (it will offer to open the console)`;
}

/** `agent` is a name or an id; with none given, the workspace's only agent. */
async function resolveAgentId(context: CommandContext): Promise<string> {
  if (context.positionals.length > 0) return agentIdNamed(context, positional(context, 0, 'agent'));
  const agents = await context.client.agents.list({ signal: context.signal });
  const [only, ...others] = agents;
  if (only === undefined) {
    throw new CommandRefusedError('this workspace has no agent to talk to', 'run "aw push --yes"');
  }
  if (others.length > 0) {
    throw new UsageError(
      `name the agent: aw chat <agent> (${agents.map((agent) => agent.name).join(', ')})`,
    );
  }
  return only.id;
}

/**
 * The version number `--agent-version <n>` or `--env production` names, or `undefined` for the
 * default: the `local` pointer, which the server applies when a run names no version.
 */
async function targetVersion(
  context: CommandContext,
  agentId: string,
): Promise<number | undefined> {
  const number = integerValue(context, 'agent-version');
  const environment = enumValue(context, 'env', AGENT_ENVIRONMENTS);
  if (number !== undefined && number > AGENT_VERSION_NUMBER_MAX) {
    throw new UsageError('--agent-version is out of range');
  }
  if (number !== undefined && environment !== undefined) {
    throw new UsageError('--agent-version and --env are alternatives; give one');
  }
  if (number !== undefined || environment === undefined || environment === 'local') return number;
  const { pointers } = await context.client.agents.versions.list(agentId, {
    signal: context.signal,
  });
  const pointed = pointers.find((pointer) => pointer.environment === environment);
  if (pointed === undefined) {
    // BH061-071: a pointer is moved by `aw promote`; `aw deploy` ships infrastructure, not versions.
    throw new CommandRefusedError(
      `${environment} points at no version yet`,
      'run "aw promote --yes" to point it at the local version',
    );
  }
  return pointed.number;
}

/** `--prompt`, else a piped stdin; a terminal with neither is the interactive loop, handled before this. */
async function promptOf(context: CommandContext): Promise<string> {
  const inline = value(context, 'prompt');
  if (inline !== undefined) return inline;
  const piped =
    (context.io.stdinIsTty ?? context.io.isTty) ? '' : (await context.readStdin()).trim();
  if (piped === '')
    throw new UsageError('--prompt <text> or a prompt on standard input is required');
  return piped;
}

const MAX_ARGS_SHOWN = 80;
const dim = (io: CliIo, text: string): string => (io.isTty ? `\u001B[2m${text}\u001B[22m` : text);

const HELP_LINES = [
  '/reset    start a new conversation',
  '/version  the agent, model, engine and version that answered last',
  '/exit     leave (Ctrl-D too)',
  '/help     this list',
];

/**
 * Turns one run's frames into terminal output: text as it streams, one dim line per tool call.
 * A delta streams the words; the snapshot `agent.message` that follows is skipped, not printed twice.
 */
function frameWriter(io: CliIo): {
  readonly frame: (frame: RunEventFrame) => void;
  readonly end: () => void;
} {
  const calls = new Map<string, { name: string; input: string; at: number }>();
  const streamed = new Set<string>();
  let midLine = false;
  const endLine = (): void => {
    if (midLine) io.stdout('\n');
    midLine = false;
  };
  const frame = (incoming: RunEventFrame): void => {
    const event = toAgentEvent(incoming);
    if (event === null) return;
    if (event.frame === 'agent.message.delta' && event.block === 'text') {
      streamed.add(event.messageId ?? '');
      io.stdout(event.text);
      midLine = !event.text.endsWith('\n');
    } else if (event.frame === 'agent.message') {
      const response = assistantResponseFromAgentEvent(event);
      if (response === null) return;
      endLine();
      if (!streamed.has(response.id) && !streamed.has('')) {
        io.stdout(`${response.text.join('\n')}\n`);
      }
    } else if (event.frame === 'agent.tool.call') {
      calls.set(event.toolCallId, {
        name: event.name,
        input: JSON.stringify(event.input),
        at: Date.now(),
      });
    } else if (event.frame === 'agent.tool.result') {
      const call = calls.get(event.toolCallId);
      const input = call?.input ?? '';
      const shown = input.length > MAX_ARGS_SHOWN ? `${input.slice(0, MAX_ARGS_SHOWN)}…` : input;
      const outcome = event.isError || event.status === 'failed' ? 'error' : 'ok';
      const ms = call === undefined ? 0 : Date.now() - call.at;
      endLine();
      io.stdout(
        `${dim(io, `  ⚙ ${call?.name ?? event.toolCallId} ${shown} → ${outcome} · ${String(ms)} ms`)}\n`,
      );
    }
  };
  return { frame, end: endLine };
}

/** One interactive turn; `null` when Ctrl-C ended it. A failed run is reported and the loop goes on. */
async function runTurn(
  context: CommandContext,
  agentId: string,
  prompt: string,
  sessionId: string | null,
  version: number | undefined,
  turnSignal: AbortSignal,
): Promise<RunResource | null> {
  const { client, signal, io } = context;
  const either = AbortSignal.any([signal, turnSignal]);
  const out = frameWriter(io);
  let runId: string | null = null;
  try {
    const { run } = await client.runs.start(
      agentId,
      { prompt, sessionId, ...(sessionId === null && version !== undefined ? { version } : {}) },
      { signal: either },
    );
    runId = run.id;
    for await (const frame of client.runs.follow(run.id, { signal: either })) out.frame(frame);
  } catch (error) {
    out.end();
    if (!either.aborted) throw error;
    if (runId !== null) await interruptQuietly(client, runId);
    if (signal.aborted) throw error;
    io.stdout('  interrupted\n');
    return null;
  }
  out.end();
  const settled = await client.runs.get(runId, { signal });
  const failure = runFailure(settled);
  if (failure !== null) {
    const short = await localKeyProblem(context, failure);
    io.stderr(`error: ${short ?? `${failure.code ?? 'run_failed'}: ${failure.message}`}\n`);
  }
  return settled;
}

/** `aw chat` with no prompt on a terminal: a readline loop whose turns share one session. */
async function interactive(
  context: CommandContext,
  agentId: string,
  version: number | undefined,
  terminal: ChatTerminal,
): Promise<undefined> {
  const { io, signal } = context;
  let sessionId: string | null = null;
  let last: RunResource | null = null;
  let turn: AbortController | null = null;
  let leaving = false;
  // Ctrl-C stops a running turn; with nothing to stop (or a stop already sent) it leaves.
  // The second press still waits for the courtesy interrupt, which INTERRUPT_TIMEOUT_MS bounds.
  terminal.onInterrupt(() => {
    if (turn !== null && !turn.signal.aborted) {
      turn.abort();
      return;
    }
    leaving = true;
    terminal.close();
  });
  // SIGTERM or a redirected Ctrl-C only abort the command signal; closing stdin lets the prompt end.
  const onAbort = (): void => {
    leaving = true;
    terminal.close();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  io.stdout(`${dim(io, '  aw chat · /help for commands')}\n`);
  try {
    for (;;) {
      const line = await terminal.question('› ');
      const text = line?.trim();
      if (text === undefined || text === '/exit') break;
      if (text === '') continue;
      if (text === '/reset') {
        sessionId = null;
        io.stdout(`${dim(io, '  new conversation')}\n`);
      } else if (text === '/help') {
        io.stdout(`${HELP_LINES.map((help) => `  ${help}`).join('\n')}\n`);
      } else if (text === '/version') {
        io.stdout(
          last === null
            ? '  no turn yet\n'
            : `  agent ${last.agentId} · ${last.model ?? 'default model'} · ${last.engine ?? 'unknown engine'} · ${version === undefined ? 'local' : `v${version}`}\n`,
        );
      } else if (text.startsWith('/')) {
        io.stdout(`  unknown command ${text}; /help lists them\n`);
      } else {
        turn = new AbortController();
        try {
          const settled = await runTurn(context, agentId, text, sessionId, version, turn.signal);
          if (settled !== null) {
            last = settled;
            sessionId = settled.sessionId;
          }
        } finally {
          turn = null;
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    terminal.close();
  }
  if (leaving) throw new InterruptedError();
  return undefined;
}

/** One turn: start, follow, and print the answer (or, with `--json`, the settled run). */
async function chat(context: CommandContext): Promise<CommandResult | undefined> {
  const { client, signal, mode, io } = context;
  const agentId = await resolveAgentId(context);
  const version = await targetVersion(context, agentId);
  if (
    value(context, 'prompt') === undefined &&
    !mode.json &&
    (io.stdinIsTty ?? io.isTty) &&
    io.openTerminal
  ) {
    return interactive(context, agentId, version, io.openTerminal());
  }
  const { run } = await client.runs.start(
    agentId,
    {
      prompt: await promptOf(context),
      sessionId: null,
      ...(version === undefined ? {} : { version }),
    },
    { signal },
  );
  const answer: string[] = [];
  try {
    for await (const frame of client.runs.follow(run.id, { signal })) {
      const event = toAgentEvent(frame);
      const response = event === null ? null : assistantResponseFromAgentEvent(event);
      if (response !== null) answer.push(...response.text);
    }
  } catch (error) {
    // The error is rethrown unchanged, so the exit code stays 130.
    if (signal.aborted) await interruptQuietly(client, run.id);
    throw error;
  }
  const settled = await client.runs.get(run.id, { signal });
  if (mode.json || mode.jsonl) writeResult(io, mode, settled);
  else if (answer.length > 0) io.stdout(`${answer.join('\n')}\n`);
  const failure = runFailure(settled);
  if (failure !== null) {
    const short = await localKeyProblem(context, failure);
    if (short !== undefined) throw new CommandRefusedError(short);
    throw new RunFailedError(settled.id, failure.code, failure.message);
  }
  // BH061-018: a run that did not complete (cancelled, or still going when the stream ended) is
  // not a success either, so a script sees a non-zero exit for every run without an answer.
  if (settled.status !== 'completed') {
    throw new RunFailedError(
      settled.id,
      `run_${settled.status}`,
      settled.error ?? `the run ended ${settled.status}`,
    );
  }
  return undefined;
}

/** Issue #697 (FH-10): talk to one of your agents from the terminal. */
export const chatCommands = [
  command(
    'chat',
    '[agent] [--prompt|-p <text>] [--agent-version <n> | --env local|production]',
    'Talk to an agent (a name or an id; the only agent by default) on its local draft, or on a version or environment: interactive on a terminal, one answer with --prompt or piped input',
    chat,
  ),
];
