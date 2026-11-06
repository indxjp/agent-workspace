import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { MenuCancelledError } from '@indx-workspace/sdk/project';
import { describe, expect, it, vi } from 'vitest';
import { runCreateCommand } from './create.js';
import { captureStdout } from './create-test-fixtures.test-support.js';
import { targetIn } from './create-finish-fixtures.test-support.js';

export function describeCreateFinishName(): void {
  describe('create finishes the job (UX-D, #760)', () => {
    describe('the project name', () => {
      it('asks it first, typed, when no directory is given, and creates what was typed', async () => {
        const target = await targetIn('named');
        captureStdout();
        const asked: string[] = [];

        await runCreateCommand([], {
          terminal: {
            isTty: true,
            prompt: (question) => {
              asked.push(question);
              if (asked.length === 1) return Promise.resolve(target);
              if (question.endsWith('[y/N] ')) return Promise.resolve('y');
              return Promise.resolve(question.endsWith('[Y/n] ') ? 'n' : '');
            },
          },
          platform: 'linux',
        });

        expect(asked[0]).toBe('? Project name (my-agent) ');
        expect(existsSync(path.join(target, 'agent-workspace.yaml'))).toBe(true);
      });

      it('prints `cd` to the typed name and lists the files once (BH061-015, BH061-073)', async () => {
        const target = await targetIn('typed-cd');
        const output = captureStdout();

        await runCreateCommand([], {
          terminal: {
            isTty: true,
            prompt: (question) => {
              if (question.startsWith('? Project name')) return Promise.resolve(target);
              if (question.endsWith('[y/N] ')) return Promise.resolve('y');
              return Promise.resolve(question.endsWith('[Y/n] ') ? 'n' : '');
            },
          },
          platform: 'linux',
        });

        expect(output()).toContain(`Next steps:\n  cd ${target}\n`);
        expect(output()).not.toContain('cd my-agent');
        expect(output().match(/^ {2}agent-workspace\.yaml$/gmu)).toHaveLength(1);
      });

      it('says the project name when the directory name cannot be one (BH061-053)', async () => {
        const target = path.join(path.dirname(await targetIn('wide')), 'エージェント');
        const output = captureStdout();
        await runCreateCommand([target, '--yes', '--no-install']);
        expect(output()).toContain(
          'project name: agent-workspace (the directory stays "エージェント")\n',
        );
      });

      it('Ctrl-C at the name exits 130 and writes nothing (BH061-014)', async () => {
        const output = captureStdout();
        const before = process.exitCode;
        try {
          await runCreateCommand([], {
            terminal: { isTty: true, prompt: () => Promise.reject(new MenuCancelledError()) },
          });
          expect(process.exitCode).toBe(130);
        } finally {
          process.exitCode = before;
        }
        expect(output()).toContain('nothing written\n');
      });

      it('asks again after a name that already exists or is not a name', async () => {
        const taken = await targetIn('taken');
        await mkdir(taken);
        const free = await targetIn('free');
        const output = captureStdout();
        const typed = [taken, 'bad\u0007name', free];
        const asked: string[] = [];

        await runCreateCommand([], {
          terminal: {
            isTty: true,
            prompt: (question) => {
              asked.push(question);
              if (question.startsWith('? Project name'))
                return Promise.resolve(typed.shift() ?? '');
              if (question.endsWith('[y/N] ')) return Promise.resolve('y');
              return Promise.resolve(question.endsWith('[Y/n] ') ? 'n' : '');
            },
          },
          platform: 'linux',
        });

        expect(asked.filter((question) => question.startsWith('? Project name'))).toHaveLength(3);
        expect(output()).toContain(`${taken} already exists; choose another name.\n`);
        expect(output()).toContain('A name cannot hold a control character.\n');
        expect(existsSync(path.join(free, 'agent-workspace.yaml'))).toBe(true);
        expect(await readdir(taken)).toEqual([]);
      });

      it('takes my-agent in the working directory, saying so on stderr, with no terminal', async () => {
        const parent = path.dirname(await targetIn('cwd'));
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        captureStdout();
        const before = process.cwd();
        process.chdir(parent);
        try {
          await runCreateCommand(['--yes', '--no-install']);
        } finally {
          process.chdir(before);
        }
        expect(stderr).toHaveBeenCalledWith('no directory given: using my-agent\n');
        expect(existsSync(path.join(parent, 'my-agent', 'agent-workspace.yaml'))).toBe(true);
      });

      it('does not ask when a directory is given', async () => {
        const prompt = vi.fn<(question: string) => Promise<string>>();
        captureStdout();
        await runCreateCommand([await targetIn('given'), '--yes', '--no-install'], {
          terminal: { isTty: true, prompt },
        });
        expect(prompt).not.toHaveBeenCalled();
      });
    });
  });
}
