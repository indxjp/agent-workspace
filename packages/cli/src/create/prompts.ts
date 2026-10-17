import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';

import {
  chooseFromMenu,
  confirmMenu,
  isInteractive,
  MenuCancelledError,
  projectNameFor,
  ProjectRenderError,
  type Choose,
} from '@indx-workspace/sdk/project';

import { errorCode } from '../cli-failure.ts';
import { detectHostCapabilities } from '../host-capabilities.ts';
import {
  CONTROL_CHARACTER,
  DEFAULT_ANSWERS,
  DEFAULT_TARGET,
  type GeneratorAnswers,
} from './args.ts';
import { paint } from './output.ts';

export { DEFAULT_ANSWERS, type GeneratorAnswers };

async function ask(io: Interface, question: string, fallback: string): Promise<string> {
  const answer = await io.question(`${question} [${fallback}] `);
  return answer.trim() || fallback;
}

/** Whether a person can answer on this process's own streams (#879). */
export function processIsInteractive(): boolean {
  return isInteractive({
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
    env: process.env,
  });
}

/**
 * The four answers of the Compose project. Each one `given` (a flag) is taken as it is; the rest
 * are asked on a terminal and take their default everywhere else. Standard input is never read
 * without a person: a pipe is not an answer (#879).
 */
export async function collectGeneratorAnswers(
  given: Partial<GeneratorAnswers>,
  interactive: boolean,
): Promise<GeneratorAnswers> {
  const capabilities = detectHostCapabilities();
  const selected = capabilities.drivers.find(({ id }) => id === capabilities.defaultDriver);
  process.stdout.write(
    `Host runtime detected: ${capabilities.defaultDriver} — ${selected?.reason ?? 'detected'}; generated Compose uses isolated Docker\n`,
  );
  if (!interactive) return { ...DEFAULT_ANSWERS, ...given };
  const io = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    return {
      database: given.database ?? (await ask(io, 'Database', DEFAULT_ANSWERS.database)),
      storage: given.storage ?? (await ask(io, 'Storage', DEFAULT_ANSWERS.storage)),
      runtime: given.runtime ?? (await ask(io, 'Runtime', DEFAULT_ANSWERS.runtime)),
      authentication:
        given.authentication ?? (await ask(io, 'Authentication', DEFAULT_ANSWERS.authentication)),
    };
  } finally {
    io.close();
  }
}

/** The terminal the v2 setup questions are asked on; injected by the suite. */
export interface CreateTerminal {
  readonly isTty: boolean;
  readonly prompt: (question: string) => Promise<string>;
  /** An arrow-key menu for a choice question; absent, the typed prompt asks it. */
  readonly choose?: Choose;
}

/** The answers that mean yes to the `[y/N]` question; anything else, including nothing, is no. */
export const YES_ANSWERS: ReadonlySet<string> = new Set(['y', 'yes']);

/**
 * The terminal to ask on: the injected one, or this process's own; `null` when no person can
 * answer (no terminal on stdin and stdout, or `CI` set), so the caller takes the recommended
 * answers (issue #689, #879).
 */
export function terminalFor(injected: CreateTerminal | undefined): CreateTerminal | null {
  if (injected !== undefined) return injected.isTty ? injected : null;
  if (!processIsInteractive()) return null;
  // One readline per question: a menu and a readline cannot share stdin at the same time.
  const prompt = async (question: string): Promise<string> => {
    const io = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Ctrl-C (and Ctrl-D, which closes the line) at a typed question cancels it like Ctrl-C at a
    // menu, so create exits 130 with "nothing written" instead of a refusal (BH061-014).
    const cancelled = new Promise<never>((_resolve, reject) => {
      io.once('SIGINT', () => {
        reject(new MenuCancelledError());
      });
      io.once('close', () => {
        reject(new MenuCancelledError());
      });
    });
    cancelled.catch(() => undefined);
    try {
      return await Promise.race([io.question(question), cancelled]);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new MenuCancelledError();
      throw error;
    } finally {
      io.close();
    }
  };
  const plain = (process.env['NO_COLOR'] ?? '') !== '';
  return {
    isTty: true,
    prompt,
    choose: (spec) => chooseFromMenu(spec, process.stdin, process.stdout, plain),
  };
}

/** The answers that mean no to a `[Y/n]` question; anything else, including nothing, is yes. */
const NO_ANSWERS: ReadonlySet<string> = new Set(['n', 'no']);

export async function confirmYes(io: CreateTerminal, title: string): Promise<boolean> {
  if (io.choose !== undefined) return confirmMenu(io.choose, title);
  return !NO_ANSWERS.has((await io.prompt(`${title} [Y/n] `)).trim().toLowerCase());
}

/** Why `name` cannot be the new project's directory, or `null` when it can. */
async function nameProblem(name: string): Promise<string | null> {
  if (CONTROL_CHARACTER.test(name)) return 'A name cannot hold a control character.';
  try {
    projectNameFor(path.basename(path.resolve(name)));
  } catch (error) {
    if (error instanceof ProjectRenderError) return error.message;
    throw error;
  }
  try {
    await lstat(name);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  return `${name} already exists; choose another name.`;
}

/** Ask "Project name", default {@link DEFAULT_TARGET}, until the answer is usable. */
export async function askProjectName(io: CreateTerminal): Promise<string> {
  const question = `${paint('cyan', '?')} ${paint('bold', 'Project name')} ${paint('dim', `(${DEFAULT_TARGET})`)} `;
  for (;;) {
    const typed = (await io.prompt(question)).trim();
    const name = typed === '' ? DEFAULT_TARGET : typed;
    const problem = await nameProblem(name);
    if (problem === null) return name;
    process.stdout.write(`${problem}\n`);
  }
}
