/**
 * One tool call of `agent-workspace deploy`: echoed, run in the project, its output printed only
 * through the redactor, and its exit status held to what the step accepts.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type { DeploymentCloud } from '../profile.ts';
import { isMissingTool, type ToolName, type ToolResult, type ToolRunner } from './runner.ts';

export interface DeployContext {
  readonly runner: ToolRunner;
  /** The project directory: every tool runs here. */
  readonly directory: string;
  readonly env: NodeJS.ProcessEnv;
  /** Makes the HTTP requests of a readiness wait (the global `fetch` when unset); a suite injects a stub. */
  readonly fetch?: typeof fetch;
  /** How a readiness wait polls: requests `delayMs` apart for `windowMs` (at least one), each cut off after `requestTimeoutMs`. */
  readonly readiness?: {
    readonly windowMs: number;
    readonly delayMs: number;
    readonly requestTimeoutMs: number;
  };
  /** The waits between a Cloudflare Worker step's retries (its default when unset); a suite injects short ones. */
  readonly workerRetryDelaysMs?: readonly number[];
  /** The profile's cloud, or `kubernetes` for an `aw deploy` target that has no v1 profile. */
  readonly cloud: DeploymentCloud | 'kubernetes';
  /** Writes to stdout, redacted. */
  readonly out: (text: string) => void;
  /** Writes to stderr, redacted. */
  readonly err: (text: string) => void;
}

/** What a target's plan found, and whether its apply ran. */
export interface DeployOutcome {
  readonly changes: boolean;
  readonly applied: boolean;
}

export interface StepOptions {
  /** Print the tool's own output. Off for a probe whose output `deploy` summarises instead. */
  readonly show: boolean;
  /** The exit statuses that are not a failure; `[0, 2]` for a `--detailed-exitcode` plan. */
  readonly accept?: readonly number[];
  /** Written to the tool's stdin and never echoed. */
  readonly input?: string;
  /** Added to the tool's environment; never echoed. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Run the same call again after each delay in turn while a failed run's output satisfies `when`;
   * any other failure, or the last delay spent, is the failure.
   */
  readonly retry?: {
    readonly when: (output: string) => boolean;
    readonly delaysMs: readonly number[];
  };
}

function withNewline(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}

/** Run `tool args`, or refuse with what it said. Resolves with the result of an accepted exit. */
export async function runStep(
  context: DeployContext,
  tool: ToolName,
  args: readonly string[],
  { show, accept = [0], input, env, retry }: StepOptions,
): Promise<ToolResult> {
  const commandLine = [tool, ...args].join(' ');
  context.out(`$ ${commandLine}\n`);
  const invoke = async (): Promise<ToolResult> => {
    try {
      return await context.runner({
        tool,
        args,
        cwd: context.directory,
        env: env === undefined ? context.env : { ...context.env, ...env },
        ...(input === undefined ? {} : { input }),
      });
    } catch (error) {
      if (!isMissingTool(error)) throw error;
      throw new Error(
        `${tool} is not installed or not on PATH: agent-workspace deploy runs it for this ` +
          `${context.cloud} profile. Install it, or run \`agent-workspace doctor\` to check this ` +
          "project's prerequisites. Nothing was applied.",
        { cause: error },
      );
    }
  };
  let result = await invoke();
  const isAccepted = (run: ToolResult) => run.status !== null && accept.includes(run.status);
  for (const delayMs of retry?.delaysMs ?? []) {
    if (isAccepted(result) || !retry?.when(`${result.stdout}\n${result.stderr}`)) break;
    context.err(withNewline(result.stderr));
    context.out(
      `That failure is transient; running \`${commandLine}\` again in ${String(delayMs / 1000)} s.\n`,
    );
    await sleep(delayMs);
    result = await invoke();
  }
  const accepted = isAccepted(result);
  if (show) context.out(withNewline(result.stdout));
  if (show || !accepted) context.err(withNewline(result.stderr));
  if (!accepted) {
    throw new Error(
      `\`${tool} ${args.find((argument) => !argument.startsWith('-')) ?? ''}\` failed ` +
        `(${result.status === null ? 'killed by a signal' : `exit status ${String(result.status)}`}); ` +
        'its output is above.',
    );
  }
  return result;
}
