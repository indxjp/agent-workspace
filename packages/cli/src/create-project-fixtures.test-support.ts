import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SETUP_QUESTIONS } from '@indx-workspace/contracts/setup';
import { type CreateTerminal } from './create.js';
import { created } from './create-test-fixtures.test-support.js';

export const V2_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  '.gitignore',
  'agent-workspace.yaml',
  'agents/assistant.ts',
  'surfaces/main.ts',
  'README.md',
  'evals/assistant.yaml',
  'AGENTS.md',
  'skills/refund-policy/SKILL.md',
];

export const targetIn = async (name: string) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-v2-'));
  created.push(parent);
  return path.join(parent, name);
};

export async function listTree(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(directory, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'),
    )
    .sort();
}

export function scriptedTerminal(answers: readonly string[]): {
  readonly terminal: CreateTerminal;
  readonly asked: string[];
} {
  const asked: string[] = [];
  const queue = [...answers];
  return {
    asked,
    terminal: {
      isTty: true,
      prompt: (question) => {
        if (question.endsWith('[Y/n] ')) return Promise.resolve('n');
        asked.push(question);
        const next = queue.shift();
        if (next === undefined) throw new Error(`unexpected question: ${question}`);
        return Promise.resolve(next);
      },
    },
  };
}

const THEME_PROMPT =
  SETUP_QUESTIONS.find((question) => question.id === 'setup.theme')?.prompt ?? 'setup.theme';

export function themeTerminal(theme: string) {
  const questions: string[] = [];
  const prompt = (question: string): Promise<string> => {
    if (question.endsWith('[Y/n] ')) return Promise.resolve('n');
    questions.push(question);
    if (question.startsWith(THEME_PROMPT)) {
      return Promise.resolve(theme);
    }
    return Promise.resolve(
      question.endsWith('[y/N] ') ? 'y' : question.endsWith('[Y/n] ') ? 'n' : '',
    );
  };
  return { questions, prompt };
}
