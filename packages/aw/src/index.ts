#!/usr/bin/env node
/**
 * `aw` — the Agent Workspace command line, a thin scriptable client over `@indx-workspace/sdk`
 * (`docs/sdk/04-api-specification.md` §7).
 *
 * This file is the only one that touches `process`. It binds the process to the {@link CliIo}
 * boundary and runs {@link main}, but only when it is the script Node was asked to run: the
 * package's export of this module is imported by the repository's artifact check, and an import
 * must not run a command.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';
import { createInterface as createCallbackInterface } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { chooseFromMenu, MenuCancelledError, type MenuSpec } from '@indx-workspace/sdk/project';

import {
  InterruptedError,
  isInteractive,
  readStreamWithIdleTimeout,
  type ChatTerminal,
  type CliIo,
} from './io.js';
import { promptSecret } from './local-runtime/environment.js';
import { openUrl } from './local-runtime/open-url.js';
import { main } from './main.js';
import { nodeVersionWarning } from './version.js';

export type { CliIo } from './io.js';
export { main } from './main.js';

/** One line from the terminal; the interface is opened and closed per question. */
async function prompt(question: string, signal?: AbortSignal): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question, signal === undefined ? {} : { signal });
  } catch (error) {
    // Ctrl-C and Ctrl-D, like `signal` (SIGINT/SIGTERM), are an interrupt, as for `promptSecret`.
    if (error instanceof Error && error.name === 'AbortError') throw new InterruptedError();
    throw error;
  } finally {
    terminal.close();
  }
}

/** A setup menu on the terminal; Ctrl-C is the same interrupt as at any other prompt. */
async function choose(spec: MenuSpec, signal: AbortSignal): Promise<readonly string[]> {
  try {
    return await chooseFromMenu(
      spec,
      process.stdin,
      process.stdout,
      (process.env['NO_COLOR'] ?? '') !== '',
      signal,
    );
  } catch (error) {
    if (error instanceof MenuCancelledError) throw new InterruptedError();
    throw error;
  }
}

/** `aw chat`'s terminal: readline keeps the history and delivers Ctrl-C as an event, not a signal. */
function openTerminal(): ChatTerminal {
  const lines = createCallbackInterface({ input: process.stdin, output: process.stdout });
  let ended = false;
  lines.once('close', () => {
    ended = true;
  });
  return {
    question: (text) =>
      new Promise((resolve) => {
        if (ended) return resolve(null);
        const onClose = (): void => {
          resolve(null);
        };
        lines.once('close', onClose);
        lines.question(text, (answer) => {
          lines.off('close', onClose);
          resolve(answer);
        });
      }),
    onInterrupt: (handler) => lines.on('SIGINT', handler),
    close: () => {
      lines.close();
    },
  };
}

function processIo(signal: AbortSignal): CliIo {
  const stdinIsTty = process.stdin.isTTY === true;
  const interactive = isInteractive({
    stdinIsTty,
    stdoutIsTty: process.stdout.isTTY === true,
    env: process.env,
  });
  return {
    stdin: () => readStreamWithIdleTimeout(process.stdin),
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    env: process.env,
    homeDir: homedir(),
    fetch: globalThis.fetch.bind(globalThis),
    isTty: interactive,
    stdinIsTty,
    signal,
    cwd: process.cwd(),
    openUrl: (url) => openUrl(url, { env: process.env }),
    // No person, no terminal members: a command that needs one refuses and names its flag.
    ...(interactive
      ? {
          prompt: (question: string, own?: AbortSignal) =>
            prompt(question, own === undefined ? signal : AbortSignal.any([signal, own])),
          choose: (spec: MenuSpec) => choose(spec, signal),
          promptSecret: (question: string) =>
            promptSecret(question, process.stdin, process.stdout, signal),
          openTerminal,
        }
      : {}),
  };
}

function isInvokedDirectly(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  const warning = nodeVersionWarning(process.versions.node);
  if (warning !== null) process.stderr.write(warning);
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  process.once('SIGINT', abort);
  // ADR-0109: `aw dev` forwards SIGTERM to the local runtime exactly as it does SIGINT.
  process.once('SIGTERM', abort);
  process.exitCode = await main(process.argv.slice(2), processIo(controller.signal));
}
