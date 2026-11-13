import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';
import { ENGINE_PACKAGES, renderProjectFiles } from '@indx-workspace/sdk/project';
import { afterEach, expect, vi } from 'vitest';
import { z } from 'zod';

import { devIssuerSubject } from '../dev/issuer.js';
import { InterruptedError } from '../io.js';
import { runCli, tempDirectory, type CliRun, type Route } from '../testing.js';
import { AW_VERSION } from '../version.js';

// These tests run the real project loader, a forked Node process that evaluates the definition
// files: a second or more each on a shared CI runner, past vitest's 5 s default when several run.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Issue #451 (S1-13): `aw dev` against a fake local runtime over a real `fork`. Each case writes a
 * project into a temp directory — `package.json`, `agent-workspace.yaml` and
 * `node_modules/@indx-workspace/embedded` whose `./launch` export is a fake `bin.mjs` — and the
 * fake's behaviour after it receives `start` is the case's own script.
 */

/** The local workspace's API key the runtime issues (ADR-0109, S1-21): `API_KEY_PATTERN`. */
export const TOKEN = `ak_live_${'A'.repeat(22)}_${'S'.repeat(43)}`;
/** A user token: what the runtime issued before S1-21, which the contract now refuses. */
export const USER_TOKEN = `awu_live_${'A'.repeat(22)}_${'S'.repeat(43)}`;
export const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
export const ANTHROPIC_KEY = 'sk-ant-api03-never-in-a-file-0123456789';
export const PROJECT_URL = 'http://127.0.0.1:3000';
export const INSTALL_LINE = `npm install -D @indx-workspace/embedded@${AW_VERSION}`;
/** How long a case whose last step prints nothing waits before interrupting. */
export const SETTLE_MS = 300;
/** What the sync says in a project that has no agents yet. */
export const NO_AGENTS = 'sync: no agents/*.ts or agents/*.agent.md in this directory\n';
export const DEFINE = `import { defineAgent, defineSurface } from '@indx-workspace/sdk/define';\n`;

export const READY = { type: 'ready', url: PROJECT_URL, contractsVersion: CONTRACTS_VERSION };

/** The development issuer a start message names when no OIDC_* is set (issue #2075). */
export const DEV_ISSUER = {
  issuer: expect.stringMatching(/^http:\/\/127\.0\.0\.1:32\d\d$/u) as unknown,
  clientId: 'aw-local-console',
  clientSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u) as unknown,
  redirectUri: 'http://127.0.0.1:3000/api/auth/callback',
  ownerSubject: devIssuerSubject('admin@localhost.test'),
};
export const CREDENTIAL = {
  type: 'credential',
  token: TOKEN,
  expiresAt: '2999-01-01T00:00:00.000Z',
  workspaceId: WORKSPACE_ID,
  workspaceSlug: 'local',
};

/** Send each message in order, then stay up until interrupted (the IPC channel keeps it alive). */
export function sends(...messages: readonly unknown[]): string {
  return messages.map((message) => `await send(${JSON.stringify(message)});`).join('\n');
}

/**
 * The fake runtime: records `start`, marks a stop request — SIGINT or the IPC channel closing,
 * both of which the real launcher honours — in `stopped`, then runs `body`. Its `message`
 * listener stays registered, which keeps the IPC channel (and so the fake) alive until it is
 * interrupted or `aw` goes away, as a real runtime stays up.
 */
export function fakeRuntime(body: string): string {
  return `import { writeFileSync } from 'node:fs';
export const send = (message) => new Promise((resolve) => process.send(message, () => resolve()));
export const stop = () => {
  writeFileSync('stopped', '');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('disconnect', stop);
let started = false;
process.on('message', async (start) => {
  if (started) return;
  started = true;
  writeFileSync('start.json', JSON.stringify(start));
  writeFileSync('env.json', JSON.stringify(Object.keys(process.env)));
  ${body}
});
`;
}

/** Only what a child process needs to start; never the developer's own ANTHROPIC_* variables. */
function baseEnv(
  extra: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    PATH: process.env['PATH'],
    SystemRoot: process.env['SystemRoot'],
    // A set service port turns the free-port fallback off, so these cases run on 3000 whatever else
    // is listening on the machine; the fallback has its own case.
    AW_DATABASE_PORT: '25432',
    ...extra,
  };
}

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

export async function freshDirectory(): Promise<string> {
  const directory = await tempDirectory();
  temporary.push(directory);
  return directory;
}

export interface ProjectOptions {
  readonly script?: string;
  /** `null`: no runtime installed. */
  readonly embeddedVersion?: string | null;
  /** Install every engine's packages (an empty `package.json` each); default true. */
  readonly engines?: boolean;
  readonly yaml?: string;
}

export function renderedYaml(): string {
  const [projectFile] = renderProjectFiles(withRecommendedAnswers({}), { name: 'demo' });
  if (projectFile === undefined) throw new Error('renderProjectFiles rendered nothing');
  return projectFile.contents;
}

export async function project(options: ProjectOptions = {}): Promise<string> {
  const directory = await freshDirectory();
  await writeFile(path.join(directory, 'package.json'), '{ "name": "demo", "private": true }\n');
  await writeFile(path.join(directory, 'agent-workspace.yaml'), options.yaml ?? renderedYaml());
  const version = options.embeddedVersion === undefined ? AW_VERSION : options.embeddedVersion;
  if (version !== null) {
    const embedded = path.join(directory, 'node_modules', '@indx-workspace', 'embedded');
    await mkdir(embedded, { recursive: true });
    await writeFile(
      path.join(embedded, 'package.json'),
      JSON.stringify({
        name: '@indx-workspace/embedded',
        version,
        type: 'module',
        exports: { './launch': './bin.mjs', './package.json': './package.json' },
      }),
    );
    await writeFile(path.join(embedded, 'bin.mjs'), options.script ?? fakeRuntime(''));
  }
  if (options.engines !== false) {
    const names = Object.values(ENGINE_PACKAGES).flatMap((packages) => Object.keys(packages));
    for (const name of new Set(names)) {
      const installed = path.join(directory, 'node_modules', ...name.split('/'));
      await mkdir(installed, { recursive: true });
      await writeFile(path.join(installed, 'package.json'), '{}');
    }
  }
  return directory;
}

/** Every file under `directory`, recursively. */
export async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

export interface DevRun {
  readonly run: CliRun;
  readonly cwd: string;
  readonly home: string;
}

/** A terminal, and what a person types at the masked key prompt (issue #690). */
export interface DevTty {
  readonly pasted: string;
  /** What is typed at the numbered menu; Enter by default. */
  readonly choice?: string;
  /** What is typed at `Open the chat in your browser? (Y/n)`; Enter by default. */
  readonly open?: string;
  /** The open question is never answered; it ends only when `aw dev` aborts it. */
  readonly pending?: boolean;
  /** Every question put to the person, in order. */
  readonly asked?: string[];
  /** Called when the open question is put, to see what was on screen by then. */
  readonly onAsk?: () => void;
  readonly opened?: string[];
  /** What `io.openUrl` answers; true by default. */
  readonly browser?: boolean;
  /** Rejects the menu prompt, as Ctrl-C does. */
  readonly interrupt?: boolean;
  /** No `io.prompt`, as where only the hidden prompt exists. */
  readonly noPrompt?: boolean;
}

export interface DevOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly route?: Route;
  readonly until?: (output: { readonly stdout: string; readonly stderr: string }) => boolean;
  readonly argv?: readonly string[];
  /** For a case whose last step prints nothing: its route aborts this one itself. */
  readonly controller?: AbortController;
  readonly tty?: DevTty;
}

/** The question `aw dev` puts after the first sync. */
const OPEN_QUESTION = 'Open the chat';

/** What a person at the terminal answers to the menu or to the open question. */
function answer(tty: DevTty, question: string, own: AbortSignal | undefined): Promise<string> {
  const isOpenQuestion = question.includes(OPEN_QUESTION);
  if (isOpenQuestion) tty.onAsk?.();
  if (isOpenQuestion && tty.pending === true) {
    return new Promise<string>((_resolve, reject) => {
      tty.asked?.push(question);
      own?.addEventListener('abort', () => {
        reject(new InterruptedError());
      });
    });
  }
  if (tty.interrupt === true) return Promise.reject(new InterruptedError());
  return Promise.resolve((isOpenQuestion ? tty.open : tty.choice) ?? '');
}

/** The `runCli` options that make the run a terminal the given person types at. */
function ttyOptions(tty: DevTty) {
  return {
    isTty: true,
    ...(tty.noPrompt === true
      ? {}
      : { prompt: (question: string, own?: AbortSignal) => answer(tty, question, own) }),
    promptSecret: () => Promise.resolve(tty.pasted),
    openUrl: (url: string) => {
      tty.opened?.push(url);
      return Promise.resolve(tty.browser ?? true);
    },
  };
}

/**
 * Run `aw dev` in `cwd`, interrupting it once `until` holds for the output so far (a runtime that
 * is up never exits by itself).
 */
export async function dev(cwd: string, options: DevOptions = {}): Promise<DevRun> {
  const home = await freshDirectory();
  const controller = options.controller ?? new AbortController();
  const until = options.until;
  const run = await runCli(['dev', ...(options.argv ?? [])], {
    cwd,
    homeDir: home,
    env: baseEnv(options.env),
    signal: controller.signal,
    ...(options.tty === undefined ? {} : ttyOptions(options.tty)),
    ...(options.route === undefined ? {} : { route: options.route }),
    onOutput: (output) => {
      if (until?.(output) !== true || controller.signal.aborted) return;
      // On a terminal the chat question follows the first sync; let it settle before stopping.
      if (options.tty === undefined) controller.abort();
      else setTimeout(() => controller.abort(), 300);
    },
  });
  return { run, cwd, home };
}

/** An agent file that prints the names of its environment's variables on one `ENV` line. */
export const ENV_AGENT = `${DEFINE}console.log('ENV ' + Object.keys(process.env).join(','));
export default defineAgent({ name: 'assistant', instructions: 'Help people.' });
`;

/** The variable names the fake runtime was forked with. */
export async function forkedEnv(cwd: string): Promise<string[]> {
  return z.array(z.string()).parse(JSON.parse(await readFile(path.join(cwd, 'env.json'), 'utf8')));
}

export const synced = ({ stdout }: { readonly stdout: string }): boolean =>
  stdout.includes('synced: ');
export const syncSaid = ({ stderr }: { readonly stderr: string }): boolean =>
  stderr.includes('sync: ');

export const signedIn = ({
  stdout,
  stderr,
}: {
  readonly stdout: string;
  readonly stderr: string;
}): boolean =>
  stdout.includes('watching ') || stderr.includes('notice:') || stderr.includes('warning:');
