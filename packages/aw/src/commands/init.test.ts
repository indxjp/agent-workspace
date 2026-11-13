import { existsSync } from 'node:fs';

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import path from 'node:path';

import { SETUP_QUESTIONS, withRecommendedAnswers } from '@indx-workspace/contracts/setup';

import {
  parseProjectFile,
  parseSetupFlags,
  projectNameFor,
  renderProjectFiles,
} from '@indx-workspace/sdk/project';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';

import { runCli } from '../testing.js';

import {
  ALL_SPECS,
  CLOSING,
  emptyProject,
  golden,
  init,
  THEME_PROMPT,
  themeTerminal,
} from './init.fixture.test-support.js';
describe('aw init (issue #451)', () => {
  it('--yes writes exactly the rendered starter files, which read back', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    const files = golden(cwd);
    expect(files.map((file) => file.path)).toEqual([
      'agent-workspace.yaml',
      'agents/assistant.ts',
      'surfaces/main.ts',
      'README.md',
      'evals/assistant.yaml',
      'AGENTS.md',
      'skills/refund-policy/SKILL.md',
    ]);
    for (const file of files) {
      expect(await readFile(path.join(cwd, file.path), 'utf8')).toBe(file.contents);
    }
    expect(run.stdout).toBe(
      `${files.map((file) => `wrote ${file.path}\n`).join('')}wrote .gitignore\n`,
    );
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n.agent-workspace/\n.aw/\n.env\n',
    );
    // The recommended theme, support, writes its greeting (#543).
    expect(await readFile(path.join(cwd, 'surfaces/main.ts'), 'utf8')).toContain(
      "greeting: 'Hi! How can I help you today?',",
    );
    const read = parseProjectFile(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8'));
    expect(read.lifted).toBe(false);
    expect(read.project).toMatchObject({ name: 'my-project' });
    // No package.json: create one first, then install all three, at this aw's version.
    expect(run.stderr).toBe(`next: npm init -y\nnext: npm install -D ${ALL_SPECS}\n${CLOSING}`);
    expect(existsSync(path.join(cwd, 'package.json'))).toBe(false);
  });

  it('answers setup questions by flag, and refuses a bad value like the interview (issue #689)', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, ['--yes', '--provider', 'openai', '--color', '#0f6b77']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    const expected = renderProjectFiles(
      withRecommendedAnswers(parseSetupFlags({ provider: 'openai', color: '#0f6b77' })),
      { name: projectNameFor(path.basename(cwd)) },
    );
    for (const file of expected) {
      expect(await readFile(path.join(cwd, file.path), 'utf8')).toBe(file.contents);
    }
    expect(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8')).toContain('openai');

    const bad = await init(await emptyProject(), ['--yes', '--provider', 'nope']);
    expect(bad.code).toBe(EXIT_CODE.usage);
    expect(bad.stderr).toContain('--provider:');
  });

  it('--platform writes the platforms block and the sections, and refuses an unknown id (#977)', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, ['--yes', '--platform', 'copilot-studio,claude-managed-agents']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    const read = parseProjectFile(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8'));
    expect(read.project).toMatchObject({
      platforms: {
        'claude-managed-agents': { enabled: true },
        'copilot-studio': { enabled: true },
      },
    });
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toContain(
      'Publish to other agent platforms',
    );
    expect(await readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toContain('Other agent platforms');

    const bad = await init(await emptyProject(), ['--yes', '--platform', 'eject-mastra']);
    expect(bad.code).toBe(EXIT_CODE.usage);
    expect(bad.stderr).toContain('--platform:');
  });

  it('--features writes the features list, and refuses a feature without its dependency (ADR-0160)', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, ['--yes', '--features', 'files,chat']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    const read = parseProjectFile(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8'));
    expect(read.project).toMatchObject({ features: ['chat', 'files'] });

    const bad = await init(await emptyProject(), ['--yes', '--features', 'surfaces']);
    expect(bad.code).toBe(EXIT_CODE.usage);
    expect(bad.stderr).toContain('--features:');
  });

  it('--platform keeps an existing README.md byte for byte (#977)', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'README.md'), '# mine\n');
    const run = await init(cwd, ['--yes', '--platform', 'aws-agentcore']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe('# mine\n');
    expect(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8')).toContain(
      'platforms:\n  aws-agentcore:\n    enabled: true\n',
    );
    expect(run.stdout).toContain('kept the existing README.md\n');
  });

  it('does not ask a question a flag answered', async () => {
    const cwd = await emptyProject();
    const { questions, prompt } = themeTerminal('', 'y');
    const run = await init(cwd, ['--theme', 'copilot'], { isTty: true, prompt });
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(questions.some((question) => question.startsWith(THEME_PROMPT))).toBe(false);
  });

  it('--help lists every setup flag, generated from the question set', async () => {
    const run = await runCli(['init', '--help']);
    expect(run.code).toBe(EXIT_CODE.ok);
    for (const question of SETUP_QUESTIONS) {
      expect(run.stdout).toContain(`--${question.flag} <`);
      expect(run.stdout).toContain(question.prompt);
    }
  });

  it('refuses over existing files, listing every one, and writes nothing', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'agent-workspace.yaml'), 'mine\n');
    await mkdir(path.join(cwd, 'surfaces'));
    await writeFile(path.join(cwd, 'surfaces', 'main.ts'), 'mine\n');
    const run = await init(cwd, ['--yes']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('  agent-workspace.yaml\n');
    expect(run.stderr).toContain('  surfaces/main.ts');
    expect(run.stderr).not.toContain('agents/assistant.ts');
    expect(existsSync(path.join(cwd, 'agents'))).toBe(false);
    expect(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8')).toBe('mine\n');
    expect(run.stdout).toBe('');
  });

  it('keeps an existing README.md and writes the rest', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'README.md'), 'mine\n');
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe('mine\n');
    expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(true);
    expect(run.stdout).toContain('kept the existing README.md\n');
    expect(run.stdout).not.toContain('wrote README.md');
  });

  it('keeps an existing AGENTS.md and writes the rest', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'AGENTS.md'), 'mine\n');
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toBe('mine\n');
    expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(true);
    expect(run.stdout).toContain('kept the existing AGENTS.md\n');
    expect(run.stdout).not.toContain('wrote AGENTS.md');
  });

  it('appends only the missing ignores to an existing .gitignore, keeping its lines', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, '.gitignore'), 'dist/\n/.env');
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe(
      'dist/\n/.env\nnode_modules/\n.agent-workspace/\n.aw/\n',
    );
    expect(run.stdout).toContain('added node_modules/, .agent-workspace/, .aw/ to .gitignore\n');
  });
});
