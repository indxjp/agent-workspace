import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { created } from './create-test-fixtures.test-support.js';

export function describeCreateAnswers(): void {
  describe('create --answers (#879)', () => {
    const sourceEntry = fileURLToPath(new URL('./create.ts', import.meta.url));
    const ANSWERS = [
      'setup.theme: copilot',
      'admin.modelProvider: openai-compatible',
      'admin.modelBaseUrl: https://models.example.com/v1',
      'content.internalTools:',
      '  - openapi',
      'content.openapiDocument: apis/orders.json',
      'embedder.brandColour: "#0f6b77"',
      '',
    ].join('\n');
    const EQUIVALENT_FLAGS = [
      '--theme',
      'copilot',
      '--provider',
      'openai-compatible',
      '--model-base-url',
      'https://models.example.com/v1',
      '--tools',
      'openapi',
      '--openapi',
      'apis/orders.json',
      '--color',
      '#0f6b77',
    ];

    async function workDirectory(): Promise<string> {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-answers-'));
      created.push(parent);
      return parent;
    }

    function run(parent: string, args: readonly string[]) {
      return spawnSync(process.execPath, [sourceEntry, ...args], {
        cwd: parent,
        encoding: 'utf8',
        env: { ...process.env, CI: 'true' },
        input: '',
        timeout: 20_000,
      });
    }

    async function tree(directory: string): Promise<Record<string, string>> {
      const entries = await readdir(directory, { recursive: true, withFileTypes: true });
      const files = await Promise.all(
        entries
          .filter((entry) => entry.isFile())
          .map(async (entry) => {
            const file = path.join(entry.parentPath, entry.name);
            return [
              path.relative(directory, file).replaceAll('\\', '/'),
              await readFile(file, 'utf8'),
            ] as const;
          }),
      );
      return Object.fromEntries(files.toSorted(([left], [right]) => left.localeCompare(right)));
    }

    it('writes the same files as the equivalent flags', async () => {
      const parent = await workDirectory();
      await writeFile(path.join(parent, 'answers.yaml'), ANSWERS);
      const fromFile = run(parent, ['from-file', '--answers', 'answers.yaml', '--no-install']);
      expect(fromFile.status, fromFile.stderr).toBe(0);
      const fromFlags = run(parent, ['from-flags', '--yes', '--no-install', ...EQUIVALENT_FLAGS]);
      expect(fromFlags.status, fromFlags.stderr).toBe(0);
      // The project name is the directory's, so compare with it normalised.
      const normalise = (files: Record<string, string>, name: string) =>
        Object.fromEntries(
          Object.entries(files).map(([file, text]) => [file, text.replaceAll(name, 'NAME')]),
        );
      expect(normalise(await tree(path.join(parent, 'from-file')), 'from-file')).toEqual(
        normalise(await tree(path.join(parent, 'from-flags')), 'from-flags'),
      );
    }, 30_000);

    it('lets a flag win over the file', async () => {
      const parent = await workDirectory();
      await writeFile(path.join(parent, 'answers.json'), '{"content.agentName": "from-file"}');
      const result = run(parent, [
        'acme',
        '--answers',
        'answers.json',
        '--agent',
        'from-flag',
        '--no-install',
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(path.join(parent, 'acme/agents/from-flag.ts'))).toBe(true);
      expect(existsSync(path.join(parent, 'acme/agents/from-file.ts'))).toBe(false);
    }, 20_000);

    it.each([
      ['an unknown key', 'content.engin: x\n', /content\.engin/u],
      ['a bad value', 'content.engine: nope\n', /content\.engine/u],
      [
        'an answer that does not apply',
        'admin.modelBaseUrl: https://x.example\n',
        /admin\.modelBaseUrl/u,
      ],
      ['a file that is not an object', '- a\n', /object keyed by setup question id/u],
    ])(
      'exits 2 naming the problem for %s, and writes nothing',
      async (_name, text, message) => {
        const parent = await workDirectory();
        await writeFile(path.join(parent, 'answers.yaml'), text);
        const result = run(parent, ['acme', '--answers', 'answers.yaml']);
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(message);
        expect(result.stderr).toContain('answers.yaml');
        expect(existsSync(path.join(parent, 'acme'))).toBe(false);
      },
      20_000,
    );

    it('exits 2 naming a file that does not exist', async () => {
      const parent = await workDirectory();
      const result = run(parent, ['acme', '--answers', 'missing.yaml']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--answers missing.yaml: the file does not exist');
      expect(existsSync(path.join(parent, 'acme'))).toBe(false);
    }, 20_000);

    it('is refused with --cloud', async () => {
      const parent = await workDirectory();
      await writeFile(path.join(parent, 'answers.yaml'), 'setup.theme: blank\n');
      const result = run(parent, ['acme', '--cloud', 'aws', '--answers', 'answers.yaml']);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/--answers/u);
      expect(existsSync(path.join(parent, 'acme'))).toBe(false);
    }, 20_000);
  });
}
