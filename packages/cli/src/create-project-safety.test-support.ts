import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETUP_QUESTIONS } from '@indx-workspace/contracts/setup';
import { describe, expect, it, vi } from 'vitest';
import { createAnswerFor } from '../../../tests/journey/harness.mjs';
import { parseCreateArguments, runAsProcess, type CreateTerminal } from './create.js';
import { runCli } from './index.js';
import { PROJECT_KIND_REFUSAL } from './profile.js';
import { create, captureStdout } from './create-test-fixtures.test-support.js';
import {
  V2_FILES,
  targetIn,
  listTree,
  scriptedTerminal,
} from './create-project-fixtures.test-support.js';

export function describeCreateProjectSafety(): void {
  describe('create writes a v2 project by default (S1-16)', () => {
    it('skips the OpenAPI question when no tool is chosen', async () => {
      const target = await targetIn('no-tools');
      captureStdout();
      const { terminal, asked } = scriptedTerminal([...Array<string>(11).fill(''), 'n']);

      await create([target], { terminal });

      expect(asked).toHaveLength(12);
      expect(asked.some((question) => question.startsWith('Where is the OpenAPI document?'))).toBe(
        false,
      );
    });

    it("recommends the chosen theme's answers", async () => {
      const target = await targetIn('copilot');
      captureStdout();
      const { terminal, asked } = scriptedTerminal(['copilot', ...Array<string>(10).fill(''), 'y']);

      await create([target], { terminal });

      expect(asked[3]).toMatch(/^What is your first agent called\? .*\[copilot\] $/u);
      expect(asked[7]).toContain('[Copilot] ');
      expect(existsSync(path.join(target, 'agents/copilot.ts'))).toBe(true);
    });

    it('answers every prompt the way the journey does (C20)', async () => {
      const target = await targetIn('journey');
      captureStdout();
      const asked: string[] = [];
      const terminal: CreateTerminal = {
        isTty: true,
        prompt: (question) => {
          // The journey's menus answer the install question; this typed terminal declines it.
          if (question.endsWith('[Y/n] ')) return Promise.resolve('n');
          asked.push(question);
          const answer = createAnswerFor(question, { 'What is your brand colour?': '#c0392b' });
          if (answer === null) throw new Error(`the journey would not answer: ${question}`);
          return Promise.resolve(answer);
        },
      };

      await create([target], { terminal });

      expect(asked.length).toBeLessThanOrEqual(SETUP_QUESTIONS.length + 1);
      expect(await readFile(path.join(target, 'surfaces/main.ts'), 'utf8')).toContain('#c0392b');
    });

    it('takes the recommended answers as a process with stdin closed', async () => {
      const target = await targetIn('spawned');
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./create.ts', import.meta.url)), target, '--color', '#0f6b77'],
        {
          cwd: path.resolve(fileURLToPath(new URL('../../../', import.meta.url))),
          encoding: 'utf8',
          input: '',
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('no terminal: used your flags and the recommended answers');
      expect(existsSync(path.join(target, 'surfaces/main.ts'))).toBe(true);
    }, 20_000);

    it('refuses a directory that already exists, and writes nothing into it', async () => {
      const target = await targetIn('existing');
      await mkdir(target);

      await expect(create([target, '--yes', '--no-install'])).rejects.toThrow(
        `${target} already exists; create writes a new directory`,
      );
      const { terminal, asked } = scriptedTerminal([]);
      await expect(create([target], { terminal })).rejects.toThrow(/already exists/u);
      expect(asked).toEqual([]);
      expect(await readdir(target)).toEqual([]);
    });

    it('refuses a target whose parent does not exist with a plain refusal, not an errno string', async () => {
      const parent = await targetIn('missing-parent');
      const target = path.join(parent, 'deep');

      const refusal = create([target, '--yes', '--no-install']);
      await expect(refusal).rejects.toThrow(
        `${parent} does not exist; create writes one new directory and never its parents.`,
      );
      await expect(refusal).rejects.not.toThrow(/ENOENT/u);
      expect(existsSync(parent)).toBe(false);
    });

    it('refuses a name the file system rejects with a plain refusal', async () => {
      const target = await targetIn('x'.repeat(300));

      const refusal = create([target, '--yes', '--no-install']);
      await expect(refusal).rejects.toThrow(/is not a valid directory name here|does not exist/u);
      await expect(refusal).rejects.not.toThrow(/ENAMETOOLONG|EINVAL|ENOENT/u);
    });

    it('refuses a target holding a control character before anything is written', () => {
      expect(() => parseCreateArguments(['c\nCreated fake', '--yes'])).toThrow(
        /holds a control character/u,
      );
      expect(() => parseCreateArguments(['c\u0007', '--cloud', 'local'])).toThrow(
        /holds a control character/u,
      );
    });

    it('single-quotes a target in the printed hints, so a copied hint runs no embedded command', async () => {
      const target = await targetIn("a$(touch PWNED) b`id` c'd");
      const quoted = `'${target.replaceAll("'", String.raw`'\''`)}'`;
      const output = captureStdout();

      await create([target, '--yes', '--no-install'], { platform: 'linux' });
      expect(output()).toContain(`Next steps:\n  cd ${quoted}\n  npm install\n`);
      expect(output()).not.toContain(`"${target}"`);
    });

    it('writes no file a secret scanner would flag, and no .env', async () => {
      const target = await targetIn('scanned');
      await create([target, '--yes', '--no-install']);
      const patterns: readonly RegExp[] = [
        /sk-ant-/u,
        /AKIA[0-9A-Z]{16}/u,
        /-----BEGIN .*PRIVATE KEY-----/u,
        /ANTHROPIC_API_KEY=\S/u,
        /(?:password|secret|token)\s*[:=]\s*['"]?[^\s'"]{16,}/iu,
        /\b[0-9a-f]{32,}\b/iu,
        /[A-Za-z0-9_-]{32,}/u,
      ];
      const files = await listTree(target);
      expect(files).toEqual([...V2_FILES].sort());
      for (const file of files) {
        const text = await readFile(path.join(target, file), 'utf8');
        for (const pattern of patterns)
          expect(text, `${file} ${String(pattern)}`).not.toMatch(pattern);
      }
      expect(existsSync(path.join(target, '.env'))).toBe(false);
    });

    it.each(['validate', 'render', 'doctor', 'deploy'])(
      'agent-workspace %s refuses the v2 project with the P-2 sentence',
      async (verb) => {
        const target = await targetIn('acme-ai');
        const stdout = captureStdout();
        await create([target, '--yes', '--no-install']);
        stdout();
        const written: string[] = [];
        const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        const status = await runAsProcess(
          async () => {
            const code = await runCli([verb, target]);
            if (code !== 0) throw new Error(`exit ${String(code)}`);
          },
          (chunk) => written.push(chunk),
        );

        errors.mockRestore();
        const everything = `${stdout()}${written.join('')}`;
        expect(status).toBe(1);
        expect(everything).toContain(PROJECT_KIND_REFUSAL);
        expect(everything).not.toContain('\n    at ');
        expect(written.join('').trimEnd().split('\n')).toHaveLength(1);
      },
      20_000,
    );
  });
}
