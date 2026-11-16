import path from 'node:path';
import { MenuCancelledError } from '@indx-workspace/sdk/project';
import { describe, expect, it, vi } from 'vitest';
import { runCreateCommand } from './create.js';
import { captureStdout } from './create-test-fixtures.test-support.js';
import { targetIn, recorder, menus, withoutKey } from './create-finish-fixtures.test-support.js';

export function describeCreateFinishTerminal(): void {
  describe('create finishes the job (UX-D, #760)', () => {
    describe('install and start on a terminal', () => {
      it('asks both with a Yes default, runs install then dev in the project, and prints no steps', async () => {
        const target = await targetIn('both');
        const output = captureStdout();
        const { calls, run } = recorder();
        const { terminal, titles } = menus();
        vi.stubEnv('npm_config_user_agent', 'pnpm/10.0.0 node/v24.0.0');

        await runCreateCommand([target], { terminal, run, platform: 'linux' });

        expect(titles.slice(-2)).toEqual(['Install dependencies now?', 'Start it now?']);
        expect(calls).toEqual([
          { manager: 'pnpm', args: ['install'], cwd: path.resolve(target) },
          { manager: 'pnpm', args: ['run', 'dev'], cwd: path.resolve(target) },
        ]);
        expect(output()).not.toContain('Next steps:');
        expect(output()).not.toContain('aw login');
      });

      it('prints cd, the key and run when install is accepted and start is declined', async () => {
        const target = await targetIn('no-start');
        const output = captureStdout();
        const { calls, run } = recorder();
        withoutKey();

        await runCreateCommand([target], {
          terminal: menus({ 'Start it now?': 'no' }).terminal,
          run,
          platform: 'linux',
        });

        expect(calls.map((call) => call.args)).toEqual([['install']]);
        expect(output()).toContain(
          `Next steps:\n  cd ${target}\n  export ANTHROPIC_API_KEY=<your key>\n  npm run dev\n`,
        );
        expect(output()).not.toContain('npm install\n');
      });

      it('declining install runs nothing, never asks about start, and prints every step', async () => {
        const target = await targetIn('no-install');
        const output = captureStdout();
        const { calls, run } = recorder();
        const { terminal, titles } = menus({ 'Install dependencies now?': 'no' });
        vi.stubEnv('ANTHROPIC_API_KEY', 'set');

        await runCreateCommand([target], { terminal, run, platform: 'linux' });

        expect(calls).toEqual([]);
        expect(titles).not.toContain('Start it now?');
        expect(output()).toContain(`Next steps:\n  cd ${target}\n  npm install\n  npm run dev\n`);
      });

      it('asks a typed [Y/n] question where there is no menu, and Enter means yes', async () => {
        const target = await targetIn('typed');
        captureStdout();
        const { calls, run } = recorder();
        const asked: string[] = [];

        await runCreateCommand([target], {
          terminal: {
            isTty: true,
            prompt: (question) => {
              asked.push(question);
              if (question.endsWith('[y/N] ')) return Promise.resolve('y');
              return Promise.resolve(question === 'Start it now? [Y/n] ' ? 'n' : '');
            },
          },
          run,
          platform: 'linux',
        });

        expect(asked.slice(-3)).toEqual([
          expect.stringMatching(/\[y\/N\] $/u),
          'Install dependencies now? [Y/n] ',
          'Start it now? [Y/n] ',
        ]);
        expect(calls.map((call) => call.args)).toEqual([['install']]);
      });

      it('--no-install skips both offers; --no-start skips only the second', async () => {
        const first = menus();
        captureStdout();
        const one = recorder();
        await runCreateCommand([await targetIn('a'), '--no-install'], {
          terminal: first.terminal,
          run: one.run,
          platform: 'linux',
        });
        expect(one.calls).toEqual([]);
        expect(first.titles).not.toContain('Install dependencies now?');
        expect(first.titles).not.toContain('Start it now?');

        const second = menus();
        const two = recorder();
        await runCreateCommand([await targetIn('b'), '--no-start'], {
          terminal: second.terminal,
          run: two.run,
          platform: 'linux',
        });
        expect(two.calls.map((call) => call.args)).toEqual([['install']]);
        expect(second.titles).toContain('Install dependencies now?');
        expect(second.titles).not.toContain('Start it now?');
      });

      it('--start answers both questions without asking', async () => {
        const { terminal, titles } = menus();
        captureStdout();
        const { calls, run } = recorder();
        await runCreateCommand([await targetIn('c'), '--start'], {
          terminal,
          run,
          platform: 'linux',
        });
        expect(calls.map((call) => call.args)).toEqual([['install'], ['run', 'dev']]);
        expect(titles).not.toContain('Install dependencies now?');
        expect(titles).not.toContain('Start it now?');
      });

      it('a failed install exits 1, never starts, and still prints the install step', async () => {
        const target = await targetIn('failed');
        const output = captureStdout();
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const { calls, run } = recorder([1]);
        const before = process.exitCode;
        vi.stubEnv('ANTHROPIC_API_KEY', 'set');
        try {
          await runCreateCommand([target], { terminal: menus().terminal, run, platform: 'linux' });
          expect(process.exitCode).toBe(1);
        } finally {
          process.exitCode = before;
        }
        expect(calls.map((call) => call.args)).toEqual([['install']]);
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining('npm install failed (exit 1)'));
        expect(output()).toContain('  npm install\n  npm run dev\n');
      });

      it('Ctrl-C at the install question exits 130, runs nothing and prints the steps', async () => {
        const target = await targetIn('cancel-install');
        const output = captureStdout();
        const { calls, run } = recorder();
        const before = process.exitCode;
        try {
          await runCreateCommand([target], {
            terminal: {
              isTty: true,
              prompt: () => Promise.resolve(''),
              choose: (spec) =>
                spec.title === 'Install dependencies now?'
                  ? Promise.reject(new MenuCancelledError())
                  : Promise.resolve(spec.initial),
            },
            run,
            platform: 'linux',
          });
          expect(process.exitCode).toBe(130);
        } finally {
          process.exitCode = before;
        }
        expect(calls).toEqual([]);
        expect(output()).toContain('Next steps:');
      });
    });
  });
}
