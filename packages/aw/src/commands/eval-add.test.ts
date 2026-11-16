import { existsSync } from 'node:fs';

import { readFile, rm } from 'node:fs/promises';

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';

import { json, runCli, stdoutJson, tempDirectory, tempFile } from '../testing.js';

import './eval.fixture.test-support.js';

import { COMMENTED } from './eval.scenarios.test-support.js';
describe('aw eval add', () => {
  it('appends a case to the only evals file, keeping comments, and sends nothing', async () => {
    const cwd = await tempDirectory();
    await tempFile(cwd, 'evals/Summariser.yaml', COMMENTED);
    const run = await runCli(
      [
        'eval',
        'add',
        'where is my order?',
        '--expect-tool',
        'get_order',
        '--expect-contains',
        'order',
      ],
      { cwd, route: () => json(500, {}) },
    );
    const text = await readFile(path.join(cwd, 'evals/Summariser.yaml'), 'utf8');
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls).toHaveLength(0);
    expect(text).toContain('# the cases that gate a release');
    expect(text).toContain('# greeting');
    expect(text.indexOf('name: greets')).toBeLessThan(text.indexOf('where is my order?'));
    expect(text).toContain('tool: get_order');
    expect(run.stderr).toContain('added "where is my order?" to evals/Summariser.yaml');
  });

  it('creates the file for a named agent that has none', async () => {
    const cwd = await tempDirectory();
    const run = await runCli(
      ['eval', 'add', 'hi', '--agent', 'Fresh', '--expect-contains', 'hello'],
      {
        cwd,
        route: () => json(500, {}),
      },
    );
    const text = await readFile(path.join(cwd, 'evals/Fresh.yaml'), 'utf8');
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(text).toContain('name: hi');
  });

  it('refuses a case with no expectation, with the schema message, and leaves the file alone', async () => {
    const cwd = await tempDirectory();
    await tempFile(cwd, 'evals/Summariser.yaml', COMMENTED);
    const run = await runCli(['eval', 'add', 'hi there'], { cwd, route: () => json(500, {}) });
    const text = await readFile(path.join(cwd, 'evals/Summariser.yaml'), 'utf8');
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('expect must name at least one of');
    expect(text).toBe(COMMENTED);
  });

  it('asks for --agent when several evals files exist', async () => {
    const cwd = await tempDirectory();
    await tempFile(cwd, 'evals/A.yaml', COMMENTED);
    await tempFile(cwd, 'evals/B.yaml', COMMENTED);
    const run = await runCli(['eval', 'add', 'hi', '--expect-tool', 'x'], {
      cwd,
      route: () => json(500, {}),
    });
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--agent <name> (found A.yaml, B.yaml)');
  });

  it('refuses a repeated --agent and writes nothing', async () => {
    const cwd = await tempDirectory();
    const run = await runCli(
      ['eval', 'add', 'hi', '--agent', 'A', '--agent', 'B', '--expect-contains', 'hello'],
      { cwd, env: {} },
    );
    const written = existsSync(path.join(cwd, 'evals'));
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--agent was given more than once');
    expect(written).toBe(false);
  });

  it('says --agent creates the file when the project has no evals file', async () => {
    const cwd = await tempDirectory();
    const run = await runCli(['eval', 'add', 'hi', '--expect-tool', 'x'], { cwd, env: {} });
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--agent <name>; it creates evals/<name>.yaml');
  });

  it('needs no URL or credential: it runs with an empty environment', async () => {
    const cwd = await tempDirectory();
    const run = await runCli(
      ['eval', 'add', 'hi', '--agent', 'Fresh', '--expect-contains', 'hello'],
      { cwd, env: {} },
    );
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.ok);
  });

  it('prints the file and the case as JSON with --json', async () => {
    const cwd = await tempDirectory();
    const run = await runCli(
      ['eval', 'add', 'hi', '--agent', 'Fresh', '--expect-contains', 'hello', '--json'],
      { cwd, env: {} },
    );
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(stdoutJson(run)).toEqual({
      file: 'evals/Fresh.yaml',
      case: { name: 'hi', input: 'hi', expect: { contains: ['hello'] } },
    });
  });

  it('treats an empty cases: as no cases and adds the first one', async () => {
    const cwd = await tempDirectory();
    await tempFile(cwd, 'evals/A.yaml', 'cases:\n');
    const run = await runCli(['eval', 'add', 'hi', '--expect-tool', 'x'], { cwd });
    const text = await readFile(path.join(cwd, 'evals/A.yaml'), 'utf8');
    await rm(cwd, { recursive: true, force: true });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(text).toContain('name: hi');
  });

  it.each(['cases: [\n', '- a\n', 'cases: hello\n'])(
    'refuses the existing file %j as a usage error naming it, and leaves it alone',
    async (existing) => {
      const cwd = await tempDirectory();
      await tempFile(cwd, 'evals/A.yaml', existing);
      const run = await runCli(['eval', 'add', 'hi', '--expect-tool', 'x'], { cwd });
      const text = await readFile(path.join(cwd, 'evals/A.yaml'), 'utf8');
      await rm(cwd, { recursive: true, force: true });
      expect(run.code).toBe(EXIT_CODE.usage);
      expect(run.stderr).toContain('evals/A.yaml line');
      expect(text).toBe(existing);
    },
  );
});
