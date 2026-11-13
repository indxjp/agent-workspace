import { existsSync } from 'node:fs';

import { readdir, readFile, writeFile } from 'node:fs/promises';

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';

import { emptyProject, init } from './init.fixture.test-support.js';
describe('aw init --yes with a provider that needs an endpoint (#879)', () => {
  it('writes the project once the endpoint is given', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, [
      '--yes',
      '--provider',
      'openai-compatible',
      '--model-base-url',
      'https://models.example.com/v1',
    ]);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8')).toContain(
      'https://models.example.com/v1',
    );
  });
});
describe('aw init --answers (#879)', () => {
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

  async function written(cwd: string): Promise<Record<string, string>> {
    const files = await readdir(cwd, { recursive: true, withFileTypes: true });
    const entries = await Promise.all(
      files
        .filter((entry) => entry.isFile() && entry.name !== 'answers.yaml')
        .map(async (entry) => {
          const file = path.join(entry.parentPath, entry.name);
          return [path.relative(cwd, file), await readFile(file, 'utf8')] as const;
        }),
    );
    return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
  }

  it('writes the same files as the equivalent flags', async () => {
    const withFile = await emptyProject();
    await writeFile(path.join(withFile, 'answers.yaml'), ANSWERS);
    const fromFile = await init(withFile, ['--yes', '--answers', 'answers.yaml']);
    expect(fromFile.code, fromFile.stderr).toBe(EXIT_CODE.ok);
    const withFlags = await emptyProject();
    const fromFlags = await init(withFlags, ['--yes', ...EQUIVALENT_FLAGS]);
    expect(fromFlags.code, fromFlags.stderr).toBe(EXIT_CODE.ok);
    expect(await written(withFile)).toEqual(await written(withFlags));
  });

  it('reads JSON too, and lets a flag win over the file', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'answers.json'), '{"content.agentName": "from-file"}');
    const run = await init(cwd, ['--yes', '--answers', 'answers.json', '--agent', 'from-flag']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(existsSync(path.join(cwd, 'agents/from-flag.ts'))).toBe(true);
    expect(existsSync(path.join(cwd, 'agents/from-file.ts'))).toBe(false);
  });

  it.each([
    ['an unknown key', 'content.engin: x\n', /content\.engin/u],
    ['a bad value', 'content.engine: nope\n', /content\.engine/u],
    [
      'a conditional answer that does not apply',
      'admin.modelBaseUrl: https://x.example\n',
      /admin\.modelBaseUrl: is asked only when/u,
    ],
    ['a file that is not an object', '- a\n', /object keyed by setup question id/u],
  ])('exits 2 naming the problem for %s, and writes nothing', async (_name, text, message) => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'answers.yaml'), text);
    const run = await init(cwd, ['--yes', '--answers', 'answers.yaml']);
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toMatch(message);
    expect(run.stderr).toContain('answers.yaml');
    expect(await readdir(cwd)).toEqual(['answers.yaml']);
  });

  it('exits 2 naming a file that does not exist', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, ['--yes', '--answers', 'missing.yaml']);
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--answers missing.yaml: the file does not exist');
  });

  it('still needs --yes (or a terminal) to write: the file answers, it does not confirm', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'answers.yaml'), 'setup.theme: blank\n');
    const run = await init(cwd, ['--answers', 'answers.yaml']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('fix: aw init --yes');
  });
});
