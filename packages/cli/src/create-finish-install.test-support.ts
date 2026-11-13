import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectPackageManager,
  nextStepLines,
  packageManagerSpawn,
  parseCreateArguments,
  runCreateCommand,
  shellArgument,
  spawnInProject,
} from './create.js';
import { captureStdout } from './create-test-fixtures.test-support.js';
import { targetIn } from './create-finish-fixtures.test-support.js';

export function describeCreateFinishInstall(): void {
  describe('create finishes the job (UX-D, #760)', () => {
    describe('arguments', () => {
      it('reads --install, --no-install, --start and --no-start', () => {
        const read = (...flags: string[]) => {
          const parsed = parseCreateArguments(['acme', ...flags]);
          if (parsed.kind !== 'project') throw new Error('not a project');
          return { install: parsed.install, start: parsed.start };
        };
        expect(read()).toEqual({ install: undefined, start: undefined });
        expect(read('--install')).toEqual({ install: true, start: undefined });
        expect(read('--no-install')).toEqual({ install: false, start: undefined });
        expect(read('--no-start')).toEqual({ install: undefined, start: false });
        // --start needs the dependencies, so it implies --install.
        expect(read('--start')).toEqual({ install: true, start: true });
        expect(read('--install', '--no-start')).toEqual({ install: true, start: false });
      });

      it('refuses --start with --no-install, and the flags with --cloud', () => {
        expect(() => parseCreateArguments(['acme', '--start', '--no-install'])).toThrow(
          /--start runs the project after its dependencies are installed/u,
        );
        expect(() => parseCreateArguments(['acme', '--cloud', 'gcp', '--install'])).toThrow(
          /--install and --start belong to the project/u,
        );
      });

      it('documents the flags in --help', async () => {
        const output = captureStdout();
        await runCreateCommand(['--help']);
        expect(output()).toContain('--install / --no-install');
        expect(output()).toContain('--start / --no-start');
      });
    });

    describe('package manager', () => {
      it.each([
        ['npm/11.0.0 node/v24.0.0 win32 x64 workspaces/false', 'npm'],
        ['pnpm/10.4.0 npm/? node/v24.0.0 linux x64', 'pnpm'],
        ['yarn/4.5.0 npm/? node/v24.0.0 darwin arm64', 'yarn'],
        ['bun/1.2.0 npm/? node/v24.0.0 linux x64', 'bun'],
        ['something/1.0.0', 'npm'],
        [undefined, 'npm'],
      ] as const)('detects %s as %s', (userAgent, expected) => {
        expect(detectPackageManager(userAgent)).toBe(expected);
      });

      it('spawns the manager directly off Windows, and through the shell as one string on Windows', () => {
        expect(packageManagerSpawn('pnpm', ['run', 'dev'], 'linux')).toEqual({
          command: 'pnpm',
          args: ['run', 'dev'],
          shell: false,
        });
        expect(packageManagerSpawn('npm', ['install'], 'darwin').shell).toBe(false);
        expect(packageManagerSpawn('npm', ['install'], 'win32')).toEqual({
          command: 'npm install',
          args: [],
          shell: true,
        });
      });

      it('actually runs the chosen form on this host: npm --version exits 0 in the project dir', async () => {
        const dir = path.dirname(await targetIn('x'));
        expect(await spawnInProject('npm', ['--version'], dir, 'ignore')).toBe(0);
        expect(await spawnInProject('npm', ['run', 'no-such-script'], dir, 'ignore')).not.toBe(0);
      }, 60_000);
    });

    describe('next steps', () => {
      const base = { target: 'acme', manager: 'npm', installed: false, missingKey: null } as const;

      it('lists cd, install, the key and run, in that order, for POSIX shells', () => {
        expect(
          nextStepLines({ ...base, missingKey: 'ANTHROPIC_API_KEY', platform: 'linux' }),
        ).toEqual(['cd acme', 'npm install', 'export ANTHROPIC_API_KEY=<your key>', 'npm run dev']);
      });

      it('gives PowerShell and cmd lines on Windows, and double-quotes a name with a space', () => {
        expect(
          nextStepLines({
            ...base,
            target: 'my agent',
            manager: 'pnpm',
            missingKey: 'OPENAI_API_KEY',
            platform: 'win32',
          }),
        ).toEqual([
          'cd "my agent"',
          'pnpm install',
          'PowerShell: $env:OPENAI_API_KEY="<your key>"',
          'cmd:        set OPENAI_API_KEY=<your key>',
          'pnpm run dev',
        ]);
      });

      it('leaves out what is done: no install once installed, no key line when it is set', () => {
        expect(nextStepLines({ ...base, installed: true, platform: 'linux' })).toEqual([
          'cd acme',
          'npm run dev',
        ]);
      });

      it('single-quotes off Windows, closing and reopening a quote inside the name', () => {
        expect(shellArgument("a b'c", 'linux')).toBe(String.raw`'a b'\''c'`);
        expect(shellArgument('a b', 'win32')).toBe('"a b"');
        expect(shellArgument('plain-name', 'win32')).toBe('plain-name');
      });

      it('single-quotes a `$` or backtick on Windows so PowerShell keeps it literal', () => {
        expect(shellArgument('a$b c', 'win32')).toBe("'a$b c'");
        expect(shellArgument("a`b'c", 'win32')).toBe("'a`b''c'");
      });
    });
  });
}
