/**
 * `run_skill_script` for the Claude Agent SDK (ADR-0137, #1089): the Node host the engine's tool
 * runs on, and the names the tool takes in Claude's tool grammar.
 *
 * The decisions are `@agent-workspace/engine`'s `runSkillScript`; the in-process MCP server that
 * offers it is built in `./boundary.ts`, the only file that imports the SDK.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import { RUN_SKILL_SCRIPT_TOOL, type SkillScriptHost } from '@agent-workspace/engine';

/** The in-process MCP server that carries the tool. A connector may not take this name. */
export const CLAUDE_SKILL_SCRIPT_SERVER = 'agent-workspace';

/** The name the model sees, and the rule an author lists in `autoApprove`. */
export const CLAUDE_SKILL_SCRIPT_TOOL = `mcp__${CLAUDE_SKILL_SCRIPT_SERVER}__${RUN_SKILL_SCRIPT_TOOL}`;

/** The tool's input, as Claude's MCP server declares it. */
export const CLAUDE_SKILL_SCRIPT_INPUT = z.object({
  skill: z.string(),
  script: z.string(),
  args: z.array(z.string()).optional(),
});

const execFileAsync = promisify(execFile);

/** How long an aborted call waits for the killed process to end before it rejects anyway. */
const ABORT_EXIT_WAIT_MS = 5_000;

/** Only `allowed`; built from `process.env` because the web app's Next types make NODE_ENV a required key. */
function onlyEnvironment(allowed: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) Reflect.deleteProperty(environment, key);
  return Object.assign(environment, allowed);
}

export const nodeSkillScriptHost: SkillScriptHost = {
  execPath: process.execPath,
  execFile: (file, args, options) => {
    const pending = execFileAsync(file, [...args], {
      ...options,
      env: onlyEnvironment(options.env),
      encoding: 'utf8',
    });
    // execFile aborts with SIGTERM whatever `killSignal` says, and a script can trap that; kill it hard.
    const kill = (): void => {
      pending.child.kill('SIGKILL');
    };
    if (options.signal?.aborted === true) kill();
    options.signal?.addEventListener('abort', kill, { once: true });
    const forget = (): void => options.signal?.removeEventListener('abort', kill);
    void pending.then(forget, forget);
    // An abort rejects before the process has ended, and on Windows a live process keeps its working
    // directory locked; reject only once it has exited, so the caller's cleanup cannot race it.
    const { child } = pending;
    const exited = new Promise<void>((resolve) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
        resolve();
      else child.once('exit', () => resolve());
    });
    return pending.catch(async (error: unknown) => {
      if (options.signal?.aborted === true) {
        let timer: NodeJS.Timeout | undefined;
        const gaveUp = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ABORT_EXIT_WAIT_MS);
        });
        await Promise.race([exited, gaveUp]);
        clearTimeout(timer);
      }
      throw error;
    });
  },
  realpath,
  path,
  makeScratchDirectory: async () => realpath(await mkdtemp(join(tmpdir(), 'skill-script-'))),
  removeDirectory: (directory) => rm(directory, { recursive: true, force: true }),
};
