import path from 'node:path';

import {
  AW_CONTROL_SERVER,
  BUILDER_DEFAULT_LIMITS,
  BUILDER_TOOL_NAMES,
  BUILDER_TOOLS,
  BuilderToolInputSchemas,
  BuilderToolOutputSchemas,
  type BuilderToolInputs,
  type BuilderToolName,
} from '@indx-workspace/contracts/builder';
import { ENGINE_CATALOGUE, mcpToolName } from '@indx-workspace/contracts/engines';
import type { RunResource } from '@indx-workspace/contracts/runs';
import { ApiProblemError, runFailure } from '@indx-workspace/sdk';
import { toAgentEvent } from '@indx-workspace/sdk/events';
import { diffBodies, uncoveredKeys } from '@indx-workspace/sdk/portable';
import { z } from 'zod';

import { command, value, type CommandContext } from '../command.js';
import { CommandRefusedError, RunFailedError, UsageError } from '../io.js';
import { exportAgentAsCode } from '../project/index.js';
import { renderFrame } from '../stream.js';
import { projectRoot } from './project.js';

const BUILDER_DISABLED = 'the Builder is not enabled for this workspace';
const NEEDS_TERMINAL = 'aw agents new --from-prompt needs a terminal to approve the save';
const INTERRUPT_TIMEOUT_MS = 5_000;
const HUMAN_MODE = { json: false, jsonl: false, raw: false, quiet: false } as const;

type DraftSave = BuilderToolInputs['draft_save'];

/** The Builder tools that stop for the person's approval: every one that is not a read. */
type ApprovalTool = {
  [Name in BuilderToolName]: (typeof BUILDER_TOOLS)[Name]['kind'] extends 'read' ? never : Name;
}[BuilderToolName];
const APPROVAL_TOOLS = BUILDER_TOOL_NAMES.filter(
  (name): name is ApprovalTool => BUILDER_TOOLS[name].kind !== 'read',
);
type Approval = {
  [Tool in ApprovalTool]: { readonly tool: Tool; readonly input: BuilderToolInputs[Tool] };
}[ApprovalTool];
const WIRE_NAMES: ReadonlyMap<string, ApprovalTool> = new Map(
  APPROVAL_TOOLS.map((tool) => [
    mcpToolName(ENGINE_CATALOGUE['claude-agent-sdk'].mcpToolName, AW_CONTROL_SERVER, tool),
    tool,
  ]),
);

/** Zero-width and bidirectional controls: they reorder or hide the text around them. */
const isBidiOrZeroWidth = (code: number): boolean =>
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/**
 * Model output as inert text: escape sequences (CSI, OSC and the other `ESC` forms) are dropped with
 * their payload, and every other control character but tab and newline goes too, so nothing the
 * model wrote can move the cursor, retitle the window or hide the line being approved.
 */
function terminalText(text: string): string {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code === 0x1b) {
      at = escapeEnd(text, at);
    } else if (
      code === 0x09 ||
      code === 0x0a ||
      (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f) && !isBidiOrZeroWidth(code))
    ) {
      out += text.charAt(at);
    }
  }
  return out;
}

/** The index of the last character of the escape sequence that starts at `start`. */
function escapeEnd(text: string, start: number): number {
  const kind = text.charAt(start + 1);
  if (kind === '[') {
    // CSI: parameter and intermediate bytes, then one final byte.
    let at = start + 2;
    while (at < text.length && (text.charCodeAt(at) < 0x40 || text.charCodeAt(at) > 0x7e)) at += 1;
    return Math.min(at, text.length - 1);
  }
  if (kind !== '' && ']PX^_'.includes(kind)) {
    // OSC and the other string sequences end at BEL or ESC \; an unterminated one runs to the end.
    const ends = [text.indexOf('\x07', start + 2), text.indexOf('\x1b\\', start + 2) + 1];
    return Math.min(...ends.filter((end) => end > 0), text.length - 1);
  }
  return Math.min(start + 1, text.length - 1);
}

/** A value as JSON with every string in it, nested ones included, free of control sequences. */
const show = (shown: unknown): string =>
  JSON.stringify(shown, (_key, part: unknown) =>
    typeof part === 'string' ? terminalText(part) : part,
  ) ?? '(removed)';

const ApprovalCall = z.object({ input: z.unknown() });

/** The call the Builder is waiting on; `null` for one this command cannot read. */
function readApproval(toolName: string, canonicalCall: string): Approval | null {
  const tool = WIRE_NAMES.get(toolName);
  if (tool === undefined) return null;
  let input: unknown;
  try {
    input = ApprovalCall.parse(JSON.parse(canonicalCall)).input;
  } catch {
    return null;
  }
  switch (tool) {
    case 'draft_save': {
      const result = BuilderToolInputSchemas.draft_save.safeParse(input);
      return result.success ? { tool, input: result.data } : null;
    }
    case 'trial_run': {
      const result = BuilderToolInputSchemas.trial_run.safeParse(input);
      return result.success ? { tool, input: result.data } : null;
    }
    case 'evals_run': {
      const result = BuilderToolInputSchemas.evals_run.safeParse(input);
      return result.success ? { tool, input: result.data } : null;
    }
  }
}

const SAVE_QUESTION = 'Save this draft? [y/N] ';

interface Proposal {
  readonly lines: readonly string[];
  readonly question: string;
}

/** `"<name>" (<id>)` and a warning unless this session saved that version of that agent; `null` if it cannot be read. */
async function namedAgent(
  context: CommandContext,
  { agentId, version }: Saved,
  saved: Saved | null,
): Promise<{ readonly label: string; readonly warning: readonly string[] } | null> {
  try {
    const { name } = await context.client.agents.get(agentId, { signal: context.signal });
    const warning =
      saved?.agentId === agentId && saved.version === version
        ? []
        : ['Warning: this agent was not saved in this session.'];
    return { label: `${show(name)} (${agentId})`, warning };
  } catch (error) {
    if (error instanceof ApiProblemError) return null;
    throw error;
  }
}

/** What the person is asked to allow, as text. `null` when the call names an agent or base version that cannot be read. */
async function describeSave(context: CommandContext, draft: DraftSave): Promise<string[] | null> {
  const { agentId, baseVersion, body, summary } = draft;
  let base = null;
  if (agentId !== undefined) {
    let items;
    try {
      ({ items } = await context.client.agents.versions.list(agentId, { signal: context.signal }));
    } catch (error) {
      // The model named the agent; one the caller cannot read is refused, not a crash that leaves the run paused.
      if (error instanceof ApiProblemError) return null;
      throw error;
    }
    base = items.find((item) => item.number === baseVersion)?.body;
    if (base === undefined) return null;
  }
  const changes = diffBodies(base, body).map(
    (change) =>
      `  ${change.section}  ${show(change.path)}: ${'before' in change ? show(change.before) : '(none)'} -> ${show(change.after)}`,
  );
  const also = uncoveredKeys(base, body);
  return [
    agentId === undefined
      ? `Save a new agent named ${show(body.definition.agent.name)}:`
      : `Save changes to agent ${agentId} on top of version ${String(baseVersion)}:`,
    ...(changes.length === 0 ? ['  (no changes in the listed sections)'] : changes),
    ...(also.length === 0 ? [] : [`Also changes (not shown here): ${also.join(', ')}`]),
    ...(summary === undefined ? [] : [`Summary: ${show(summary)}`]),
  ];
}

/** What the person is asked to allow, as text. `null` when the call names an agent or base version that cannot be read. */
async function describe(
  context: CommandContext,
  approval: Approval,
  saved: Saved | null,
): Promise<Proposal | null> {
  if (approval.tool === 'draft_save') {
    const lines = await describeSave(context, approval.input);
    return lines === null ? null : { lines, question: SAVE_QUESTION };
  }
  const cap = `Budget: at most $${BUILDER_DEFAULT_LIMITS.trialBudgetUsd.toFixed(2)}`;
  const { agentId, version } = approval.input;
  const agent = await namedAgent(context, { agentId, version }, saved);
  if (agent === null) return null;
  const heading = `agent ${agent.label} version ${String(version)}`;
  if (approval.tool === 'trial_run') {
    // Quoted, so a newline in the input cannot forge a Budget or Warning line.
    const input = show(approval.input.input);
    return {
      lines: [`Trial run of ${heading} with this input: ${input}`, cap, ...agent.warning],
      question: 'Run this trial? [y/N] ',
    };
  }
  const { cases } = approval.input;
  return {
    lines: [
      `Evaluation of ${heading}: ${String(cases.length)} case(s)`,
      ...cases.map((evalCase) => `  - ${show(evalCase.name)}`),
      `${cap} per case`,
      ...agent.warning,
    ],
    question: 'Run these checks? [y/N] ',
  };
}

interface Progress {
  saved: { readonly agentId: string; readonly version: number } | null;
  /** The tool each call id belongs to, from the calls and approval requests seen so far. */
  readonly tools: Map<string, string>;
}

/** A tool answer the command acts on: the Builder switched off, or the draft that was saved. */
function noteToolOutput(output: string, toolCallId: string, progress: Progress): void {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return;
  }
  if (z.object({ code: z.literal('builder_disabled') }).safeParse(payload).success) {
    throw new CommandRefusedError(BUILDER_DISABLED);
  }
  const saved = BuilderToolOutputSchemas.draft_save.safeParse(payload);
  if (saved.success && WIRE_NAMES.get(progress.tools.get(toolCallId) ?? '') === 'draft_save') {
    progress.saved = { agentId: saved.data.agentId, version: saved.data.version };
  }
}

async function interruptRun({ client }: CommandContext, runId: string): Promise<void> {
  await client.runs
    .interrupt(runId, { signal: AbortSignal.timeout(INTERRUPT_TIMEOUT_MS) })
    .catch(() => undefined);
}

async function followRun(
  context: CommandContext,
  runId: string,
  progress: Progress,
): Promise<RunResource> {
  const { client, io, signal } = context;
  try {
    for await (const frame of client.runs.follow(runId, { signal })) {
      const event = frame.kind === 'runtime' ? toAgentEvent(frame) : null;
      if (event?.frame === 'agent.approval.requested') {
        progress.tools.set(event.toolCallId, event.toolName);
        continue;
      }
      if (event?.frame === 'agent.tool.call') progress.tools.set(event.toolCallId, event.name);
      if (event?.frame === 'agent.tool.result') {
        noteToolOutput(event.output, event.toolCallId, progress);
      }
      for (const line of renderFrame(frame, HUMAN_MODE)) io.stdout(`${terminalText(line)}\n`);
    }
  } catch (error) {
    // Ctrl-C, or our own refusal (the Builder is off): the run is stopped, not left going.
    if (signal.aborted || error instanceof CommandRefusedError) await interruptRun(context, runId);
    throw error;
  }
  return client.runs.get(runId, { signal });
}

/** Ask once; only `y` or `Y` approves. A call that cannot be read, or has no base, is rejected unasked. */
async function decide(
  context: CommandContext,
  run: RunResource,
  saved: Saved | null,
): Promise<'approve' | 'reject'> {
  const { io } = context;
  const pending = run.pendingApproval;
  const approval = pending === null ? null : readApproval(pending.toolName, pending.canonicalCall);
  const proposal = approval === null ? null : await describe(context, approval, saved);
  if (proposal === null || io.prompt === undefined) {
    io.stdout('The Builder asked for something this command cannot show, so it was refused.\n');
    return 'reject';
  }
  io.stdout(`${terminalText(proposal.lines.join('\n'))}\n`);
  // Keystrokes typed while the run streamed are not an answer to this question.
  await io.discardInput?.();
  let answer: string;
  try {
    answer = await io.prompt(proposal.question, context.signal);
  } catch (error) {
    // End of input or Ctrl-C: nothing was approved, so the paused run is stopped, not left waiting.
    await interruptRun(context, run.id);
    throw error;
  }
  return answer.trim() === 'y' || answer.trim() === 'Y' ? 'approve' : 'reject';
}

/** One turn of the chat: the Builder answers `prompt`, and each approval it asks for goes to the person. */
async function turn(
  context: CommandContext,
  builderId: string,
  prompt: string,
  sessionId: string | null,
  progress: Progress,
): Promise<RunResource> {
  const { client, io, signal } = context;
  let run = (await client.runs.start(builderId, { prompt, sessionId }, { signal })).run;
  run = await followRun(context, run.id, progress);
  while (run.status === 'awaiting_approval') {
    const decision = await decide(context, run, progress.saved);
    const { run: continuation } = await client.runs[decision](run.id, {}, { signal });
    run = await followRun(context, continuation.id, progress);
  }
  const failure =
    runFailure(run) ??
    (run.status === 'completed'
      ? null
      : { code: `run_${run.status}`, message: run.error ?? `the run ended ${run.status}` });
  if (failure === null) return run;
  // A save before the failure is still a version on the server: say so and how to write it.
  const { saved } = progress;
  if (saved !== null) {
    io.stdout(
      `${savedLine(saved)}Write it as code with: ${terminalText(exportCommand(context, saved))}\n`,
    );
  }
  throw new RunFailedError(run.id, failure.code, failure.message);
}

async function fromPrompt(context: CommandContext): Promise<undefined> {
  const { client, io, signal } = context;
  const text = value(context, 'from-prompt');
  if (text === undefined || text.trim() === '')
    throw new UsageError('--from-prompt <text> is required');
  if (!io.isTty || !(io.stdinIsTty ?? io.isTty) || io.prompt === undefined) {
    throw new CommandRefusedError(NEEDS_TERMINAL);
  }
  const builder = (await client.agents.list({ signal })).find(
    (agent) => agent.builtin === 'builder',
  );
  if (builder === undefined) throw new CommandRefusedError(BUILDER_DISABLED);

  const progress: Progress = { saved: null, tools: new Map() };
  let message = text;
  let sessionId: string | null = null;
  for (;;) {
    const run = await turn(context, builder.id, message, sessionId, progress);
    if (progress.saved !== null) return exportSaved(context, progress.saved);
    sessionId = run.sessionId;
    // Keystrokes typed while the answer streamed are not the next message.
    await io.discardInput?.();
    message = (await io.prompt('> ', signal)).trim();
    if (message === '') {
      io.stdout('No draft was saved.\n');
      return undefined;
    }
  }
}

type Saved = NonNullable<Progress['saved']>;

const savedLine = ({ agentId, version }: Saved): string =>
  `Saved agent ${agentId} as version ${String(version)}.\n`;

/** The `aw agents export` call that writes `saved` where this command would have. */
function exportCommand(
  context: CommandContext,
  { agentId, version }: Saved,
  force = false,
): string {
  const out = value(context, 'out');
  return (
    `aw agents export ${agentId} --format ts --agent-version ${String(version)}` +
    (out === undefined ? '' : ` --out ${JSON.stringify(out)}`) +
    (force ? ' --force' : '')
  );
}

async function exportSaved(context: CommandContext, saved: Saved): Promise<undefined> {
  const { client, io, signal } = context;
  io.stdout(savedLine(saved));
  try {
    await exportAgentAsCode({
      client,
      io,
      signal,
      agentId: saved.agentId,
      out: path.resolve(projectRoot(context), value(context, 'out') ?? '.'),
      version: saved.version,
      force: false,
    });
  } catch (error) {
    if (!(error instanceof CommandRefusedError)) throw error;
    throw new CommandRefusedError(
      error.message,
      terminalText(
        exportCommand(context, saved, error.message.startsWith('refusing to overwrite')),
      ),
    );
  }
  return undefined;
}

/** `fromPrompt`, with the text of whatever it throws, which server and model text reach, made inert. */
async function fromPromptPlain(context: CommandContext): Promise<undefined> {
  try {
    return await fromPrompt(context);
  } catch (error) {
    if (error instanceof CommandRefusedError) {
      const fix = error.fix === undefined ? undefined : terminalText(error.fix);
      throw new CommandRefusedError(terminalText(error.message), fix);
    }
    if (error instanceof ApiProblemError) {
      const { status, code, message, details, retryAfterSeconds } = error;
      throw new ApiProblemError({
        status,
        problem: {
          code: terminalText(code),
          message: terminalText(message),
          details: details.map(terminalText),
        },
        retryAfterSeconds,
        cause: error,
      });
    }
    if (error instanceof Error) error.message = terminalText(error.message);
    throw error;
  }
}

export const agentNewCommands = [
  command(
    'agents new',
    '--from-prompt <text> [--out <dir>]',
    'Build an agent with the Builder in a chat on this terminal: every save, trial and check asks you first; a saved agent is written as agents/<name>.ts and .md',
    fromPromptPlain,
  ),
];
