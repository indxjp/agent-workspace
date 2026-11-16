import { existsSync } from 'node:fs';

import { readdir, readFile, writeFile } from 'node:fs/promises';

import path from 'node:path';

import { SETUP_THEMES } from '@indx-workspace/contracts/setup';

import { askSetupQuestions, renderProjectFiles } from '@indx-workspace/sdk/project';

import { describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';

import { AW_VERSION } from '../version.js';

import {
  CLOSING,
  DEFAULT_ENGINE_SPECS,
  emptyProject,
  golden,
  init,
  themeTerminal,
} from './init.fixture.test-support.js';
describe('aw init (issue #451)', () => {
  it('names the .gitignore edit in the confirmation, and nothing when it is complete', async () => {
    const edited = await emptyProject();
    await writeFile(path.join(edited, '.gitignore'), 'dist/\n');
    const terminal = themeTerminal('', 'n');
    const run = await init(edited, [], { isTty: true, prompt: terminal.prompt });
    expect(run.stdout).toContain(
      'and add node_modules/, .agent-workspace/, .aw/, .env to the existing .gitignore\n',
    );
    const complete = await emptyProject();
    await writeFile(
      path.join(complete, '.gitignore'),
      'node_modules/\n.agent-workspace/\n.env\n.aw/\n',
    );
    const quiet = await init(complete, [], { isTty: true, prompt: themeTerminal('', 'n').prompt });
    expect(quiet.stdout).not.toContain('.gitignore');
  });

  it('leaves a .gitignore that already lists all four alone', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, '.gitignore'), 'node_modules\n.agent-workspace\n.aw\n.env\n');
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe(
      'node_modules\n.agent-workspace\n.aw\n.env\n',
    );
    expect(run.stdout).not.toContain('.gitignore');
  });

  it('refuses without a terminal and without --yes, naming --yes', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, []);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('pass --yes when no person is at a terminal');
    expect(run.stderr).toContain('fix: aw init --yes');
    expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(false);
  });

  it('refuses under CI=true with a terminal on stdin, naming --yes and asking nothing', async () => {
    const cwd = await emptyProject();
    const prompt = vi.fn(() => Promise.resolve(''));
    // `processIo` leaves isTty false when CI is set, whatever the streams are.
    const run = await init(cwd, [], {
      isTty: false,
      stdinIsTty: true,
      env: { CI: 'true' },
      prompt,
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('fix: aw init --yes');
    expect(prompt).not.toHaveBeenCalled();
    expect(await readdir(cwd)).toEqual([]);
  });

  it('refuses on a terminal that cannot prompt, naming --yes', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, [], { isTty: true });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('--yes');
  });

  it('on a terminal, shows the plan and writes nothing unless the answer is yes', async () => {
    const cwd = await emptyProject();
    const declinedTerminal = themeTerminal('', 'n');
    const declined = await init(cwd, [], { isTty: true, prompt: declinedTerminal.prompt });
    expect(declined.code).toBe(EXIT_CODE.ok);
    expect(declinedTerminal.questions.at(-1)).toBe('write these 7 files? [y/N] ');
    expect(declined.stdout).toContain('  agent-workspace.yaml\n');
    expect(declined.stdout).toContain('and create .gitignore\n');
    expect(declined.stdout).not.toContain('wrote');
    expect(declined.stderr).toBe('nothing written\n');
    expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(false);

    const empty = await init(cwd, [], { isTty: true, prompt: themeTerminal('', '').prompt });
    expect(empty.code).toBe(EXIT_CODE.ok);
    expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(false);

    const accepted = await init(cwd, [], {
      isTty: true,
      prompt: themeTerminal('', ' Yes\n').prompt,
    });
    expect(accepted.code, accepted.stderr).toBe(EXIT_CODE.ok);
    expect(accepted.stderr.endsWith(CLOSING)).toBe(true);
    for (const file of golden(cwd)) {
      expect(await readFile(path.join(cwd, file.path), 'utf8')).toBe(file.contents);
    }
  });

  it.each(SETUP_THEMES)(
    'on a terminal, theme %s writes exactly the files create writes (C20)',
    async (theme) => {
      const cwd = await emptyProject();
      const reference = themeTerminal(theme);
      const answers = await askSetupQuestions(reference.prompt, () => undefined);
      const expected = renderProjectFiles(answers, { name: 'my-project', version: AW_VERSION });
      const terminal = themeTerminal(theme);

      const run = await init(cwd, [], { isTty: true, prompt: terminal.prompt });

      expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
      expect(terminal.questions).toEqual([
        ...reference.questions,
        `write these ${String(expected.length)} files? [y/N] `,
      ]);
      for (const file of expected) {
        expect(await readFile(path.join(cwd, file.path), 'utf8'), file.path).toBe(file.contents);
      }
      const written = run.stdout.split('\n').filter((line) => line.startsWith('wrote '));
      expect(written).toEqual([
        ...expected.map((file) => `wrote ${file.path}`),
        'wrote .gitignore',
      ]);
      expect(run.stderr).toMatch(/aw dev reads .+ from its environment; no key is written/u);
      expect(run.stderr).toMatch(/next: npx aw dev\n.*pushing with it is not supported yet\)\n$/u);
    },
  );

  it('on a terminal, theme knowledge writes the three starter files', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, [], { isTty: true, prompt: themeTerminal('knowledge').prompt });
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    for (const file of ['agent-workspace.yaml', 'agents/knowledge.ts', 'surfaces/main.ts']) {
      expect(existsSync(path.join(cwd, file)), file).toBe(true);
    }
  });

  it('--yes asks nothing, even on a terminal that can prompt', async () => {
    const cwd = await emptyProject();
    const prompt = vi.fn<(question: string) => Promise<string>>();
    const run = await init(cwd, ['--yes'], { isTty: true, prompt });
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(prompt).not.toHaveBeenCalled();
    for (const file of golden(cwd)) {
      expect(await readFile(path.join(cwd, file.path), 'utf8')).toBe(file.contents);
    }
  });

  it('on a terminal, refuses over an existing file after the answers, and writes nothing', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'agent-workspace.yaml'), 'mine\n');
    const terminal = themeTerminal('');
    const run = await init(cwd, [], { isTty: true, prompt: terminal.prompt });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('aw init would overwrite existing files:\n  agent-workspace.yaml');
    expect(terminal.questions.length).toBeGreaterThan(0);
    expect(terminal.questions.some((question) => question.endsWith('[y/N] '))).toBe(false);
    expect(existsSync(path.join(cwd, 'agents'))).toBe(false);
    expect(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8')).toBe('mine\n');
  });

  it('names only the missing packages, and never changes package.json', async () => {
    const cwd = await emptyProject();
    const manifest = `{\n  "name": "mine",\n  "dependencies": { "@indx-workspace/sdk": "${AW_VERSION}" },\n  "devDependencies": { "@indx-workspace/aw": "${AW_VERSION}" }\n}\n`;
    await writeFile(path.join(cwd, 'package.json'), manifest);
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(run.stderr).toBe(
      `next: npm install -D @indx-workspace/embedded@${AW_VERSION} ${DEFAULT_ENGINE_SPECS}\n${CLOSING}`,
    );
    expect(await readFile(path.join(cwd, 'package.json'), 'utf8')).toBe(manifest);
  });
});
