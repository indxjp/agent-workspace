import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { type CreateTerminal, type RunInProject } from './create.js';
import { created } from './create-test-fixtures.test-support.js';

export const targetIn = async (name: string) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-finish-'));
  created.push(parent);
  return path.join(parent, name);
};

export function recorder(codes: readonly number[] = []) {
  const calls: { manager: string; args: readonly string[]; cwd: string }[] = [];
  const queue = [...codes];
  const run: RunInProject = (manager, args, cwd) => {
    calls.push({ manager, args, cwd });
    return Promise.resolve(queue.shift() ?? 0);
  };
  return { calls, run };
}

export function menus(answers: Readonly<Record<string, string>> = {}) {
  const titles: string[] = [];
  const terminal: CreateTerminal = {
    isTty: true,
    prompt: () => Promise.resolve(''),
    choose: (spec) => {
      titles.push(spec.title);
      const answer = answers[spec.title];
      return Promise.resolve(answer === undefined ? spec.initial : [answer]);
    },
  };
  return { terminal, titles };
}

export const withoutKey = () => vi.stubEnv('ANTHROPIC_API_KEY', '');
