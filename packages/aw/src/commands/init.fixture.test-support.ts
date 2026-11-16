import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { SETUP_QUESTIONS, withRecommendedAnswers } from '@indx-workspace/contracts/setup';
import {
  ENGINE_PACKAGES,
  projectDependencies,
  projectNameFor,
  renderProjectFiles,
} from '@indx-workspace/sdk/project';
import { afterEach } from 'vitest';
import type { CliIo } from '../io.js';
import { runCli, tempDirectory, type CliRunOptions } from '../testing.js';
import { AW_VERSION } from '../version.js';

export const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A fresh, empty project directory with a name `projectNameFor` has to clean up. */
export async function emptyProject(): Promise<string> {
  const root = await tempDirectory();
  temporary.push(root);
  const directory = path.join(root, 'My Project');
  await mkdir(directory);
  return directory;
}

export function golden(directory: string) {
  return renderProjectFiles(withRecommendedAnswers({}), {
    name: projectNameFor(path.basename(directory)),
  });
}

export const THEME_PROMPT =
  SETUP_QUESTIONS.find((question) => question.id === 'setup.theme')?.prompt ?? 'setup.theme';

/**
 * A terminal that answers the theme question with `theme`, `[y/N]` with `confirm`, and every other
 * question with the empty line (the recommended answer); records every question it was asked.
 */
export function themeTerminal(theme: string, confirm = 'y') {
  const questions: string[] = [];
  const prompt = (question: string): Promise<string> => {
    questions.push(question);
    if (question.startsWith(THEME_PROMPT)) return Promise.resolve(theme);
    return Promise.resolve(question.endsWith('[y/N] ') ? confirm : '');
  };
  return { questions, prompt };
}

/** What every successful `aw init` ends with, for the recommended answers (#544). */
export const CLOSING =
  'aw dev reads ANTHROPIC_API_KEY from its environment; no key is written to a file.\n' +
  'next: npx aw dev\n' +
  'to share a workspace later: aw login --url <url> (reads workspaces; pushing with it is not supported yet)\n';

export function init(cwd: string, argv: readonly string[], options: CliRunOptions = {}) {
  return runCli(['init', ...argv], { cwd, env: {}, ...options });
}

/** The loader's I/O: no stdin and no network, as `project/load.test.ts` has it. */
export const LOADER_IO: CliIo = {
  stdin: () => Promise.resolve(''),
  stdout: () => undefined,
  stderr: () => undefined,
  env: {},
  homeDir: 'C:/nonexistent-home',
  fetch: () => Promise.reject(new Error('no network')),
  isTty: false,
};

/** What a project needs with the recommended answers: the three packages and the default engine's. */
export const ALL_PINS = Object.entries(projectDependencies(AW_VERSION, 'claude-agent-sdk'));

export const ALL_SPECS = ALL_PINS.map(([name, version]) => `${name}@${version}`).join(' ');

export const DEFAULT_ENGINE_SPECS = Object.entries(ENGINE_PACKAGES['claude-agent-sdk'])
  .map(([name, version]) => `${name}@${version}`)
  .join(' ');
