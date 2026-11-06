import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SETUP_QUESTIONS,
  SETUP_THEMES,
  setupQuestionApplies,
} from '@indx-workspace/contracts/setup';
import {
  askSetupQuestions,
  MenuCancelledError,
  projectNameFor,
  renderProjectFiles,
  renderProjectShell,
} from '@indx-workspace/sdk/project';
import { describe, expect, it, vi } from 'vitest';
import { CLI_VERSION } from './version.js';
import { create, captureStdout } from './create-test-fixtures.test-support.js';
import { targetIn, listTree, themeTerminal } from './create-project-fixtures.test-support.js';

export function describeCreateProjectPrompts(): void {
  describe('create writes a v2 project by default (S1-16)', () => {
    it.each(SETUP_THEMES)(
      'on a terminal, theme %s writes exactly the files aw init writes (C20)',
      async (theme) => {
        const target = await targetIn(`theme-${theme}`);
        captureStdout();
        const reference = themeTerminal(theme);
        const answers = await askSetupQuestions(reference.prompt, () => undefined);
        const name = projectNameFor(path.basename(target));
        const expected = renderProjectFiles(answers, { name, version: CLI_VERSION });
        const { questions, prompt } = themeTerminal(theme);

        await create([target], { terminal: { isTty: true, prompt } });

        const shell = renderProjectShell({
          name,
          version: CLI_VERSION,
          engine: answers['content.engine'],
        }).map((file) => file.path);
        expect(questions).toEqual([
          ...reference.questions,
          `write these ${String(shell.length + expected.length)} files into ${path.resolve(target)}? [y/N] `,
        ]);
        expect(await listTree(target)).toEqual(
          [...shell, ...expected.map((file) => file.path)].sort(),
        );
        for (const file of expected) {
          expect(await readFile(path.join(target, file.path), 'utf8'), file.path).toBe(
            file.contents,
          );
        }
      },
    );

    it('on a terminal with menus, asks choices as menus and declines on a No menu', async () => {
      const target = await targetIn('menus');
      captureStdout();
      const titles: string[] = [];
      await create([target], {
        terminal: {
          isTty: true,
          prompt: () => Promise.resolve(''),
          choose: (spec) => {
            titles.push(spec.title);
            return Promise.resolve(spec.title.startsWith('Write') ? ['no'] : spec.initial);
          },
        },
      });
      expect(titles[0]).toMatch(/theme/iu);
      expect(titles.at(-1)).toMatch(/^Write these \d+ files into /u);
      expect(existsSync(target)).toBe(false);
    });

    it('on a terminal, Ctrl-C at a menu exits 130 and writes nothing', async () => {
      const target = await targetIn('menu-ctrl-c');
      const out = captureStdout();
      const before = process.exitCode;
      try {
        await create([target], {
          terminal: {
            isTty: true,
            prompt: () => Promise.resolve(''),
            choose: () => Promise.reject(new MenuCancelledError()),
          },
        });
        expect(process.exitCode).toBe(130);
      } finally {
        process.exitCode = before;
      }
      expect(out()).toContain('nothing written');
      expect(existsSync(target)).toBe(false);
    });

    it('on a terminal, theme knowledge writes the three starter files', async () => {
      const target = await targetIn('knowledge');
      captureStdout();

      await create([target], {
        terminal: { isTty: true, prompt: themeTerminal('knowledge').prompt },
      });

      for (const file of ['agent-workspace.yaml', 'agents/knowledge.ts', 'surfaces/main.ts']) {
        expect(existsSync(path.join(target, file)), file).toBe(true);
      }
    });

    it('--yes asks nothing, even on a terminal, and ends with the hand-off (#544)', async () => {
      const target = await targetIn('handoff');
      const output = captureStdout();
      const prompt = vi.fn<(question: string) => Promise<string>>();
      vi.stubEnv('ANTHROPIC_API_KEY', 'set');

      await create([target, '--yes', '--no-install'], { terminal: { isTty: true, prompt } });

      expect(prompt).not.toHaveBeenCalled();
      expect(output().trimEnd().split('\n').slice(-5)).toEqual([
        'aw dev reads ANTHROPIC_API_KEY from its environment; no key is written to a file.',
        'Next steps:',
        `  cd ${target}`,
        '  npm install',
        '  npm run dev',
      ]);
      expect(output()).not.toContain('aw login');
    });

    it('adds an export line to the next steps when the provider key is not in the environment', async () => {
      const target = await targetIn('nokey');
      const output = captureStdout();
      vi.stubEnv('OPENAI_API_KEY', '');

      await create([target, '--yes', '--no-install', '--provider', 'openai']);

      expect(output()).toContain(
        '  npm install\n  export OPENAI_API_KEY=<your key>\n  npm run dev\n',
      );
    });

    it('with stdin closed and one flag, writes the project, says so on stderr and asks nothing', async () => {
      const target = await targetIn('closed');
      const output = captureStdout();
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const prompt = vi.fn<(question: string) => Promise<string>>();

      await create([target, '--theme', 'copilot', '--provider', 'openai'], {
        terminal: { isTty: false, prompt },
      });

      expect(prompt).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        'no terminal: used your flags and the recommended answers for the rest (to choose others, pass more flags or --answers <file>; see --help)\n',
      );
      expect(output()).toContain('Next steps:');
      expect(await readFile(path.join(target, 'agent-workspace.yaml'), 'utf8')).toContain('openai');
      expect(await readFile(path.join(target, 'surfaces/main.ts'), 'utf8')).toContain('Copilot');
    });

    it('does not ask a question a flag answered, on a terminal', async () => {
      const target = await targetIn('flagged');
      captureStdout();
      const asked: string[] = [];
      await create([target, '--sandbox', 'local'], {
        terminal: {
          isTty: true,
          prompt: (question) => {
            if (question.endsWith('[Y/n] ')) return Promise.resolve('n');
            asked.push(question);
            return Promise.resolve(question.startsWith('write these') ? 'y' : '');
          },
        },
      });
      expect(asked.some((question) => question.startsWith('Where should agents run'))).toBe(false);
      // Conditional questions (the model endpoint) are not asked for the default provider.
      const applicable = SETUP_QUESTIONS.filter(
        (question) =>
          question.flag !== 'sandbox' &&
          setupQuestionApplies(question, { 'admin.modelProvider': 'anthropic' }),
      );
      expect(asked).toHaveLength(applicable.length + 1);
    });

    it('asks for the model endpoint on a terminal only for the providers that need one', async () => {
      for (const provider of [
        'azure-openai',
        'openai-compatible',
        'openai',
        'anthropic',
      ] as const) {
        const asked: string[] = [];
        await askSetupQuestions(
          (question) => {
            asked.push(question);
            return Promise.resolve(
              question.startsWith('Where is') ? 'https://models.example/v1' : '',
            );
          },
          () => undefined,
          { 'admin.modelProvider': provider },
        );
        const needsEndpoint = provider === 'azure-openai' || provider === 'openai-compatible';
        expect(
          asked.some((question) => question.startsWith("Where is the model provider's endpoint?")),
          provider,
        ).toBe(needsEndpoint);
      }
    });
  });
}
