import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';
import { renderProjectFiles } from '@indx-workspace/sdk/project';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { runCli, stdoutJson, tempDirectory } from '../testing.js';

// These tests start a real child process (the project loader or the tool host): a second or more
// each on a shared CI runner, past vitest's 5 s default when several run.
vi.setConfig({ testTimeout: 30_000 });

// What `defineTool` makes: a declaration branded as a code tool (the temporary project cannot import the SDK).
const DECLARATION = `const tool = ${JSON.stringify({
  name: 'get_order',
  description: 'Look an order up',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  run: './tools/get-order.run.js',
  limits: { timeoutMs: 5000 },
})};
Object.defineProperty(tool, Symbol.for('agentworkspace.dev/define'), { value: 'code' });
export default tool;
`;

const RUN = `export default async ({ id }, { runId }) => {
  if (id === 'boom') throw new Error('order boom exploded');
  console.log('looking up ' + id);
  return { id, runId };
};
`;

let project: string;
let bare: string;

beforeAll(async () => {
  project = await tempDirectory();
  bare = await tempDirectory();
  const [file] = renderProjectFiles(withRecommendedAnswers({}), { name: 'demo' });
  await writeFile(path.join(project, 'agent-workspace.yaml'), file?.contents ?? '');
  await mkdir(path.join(project, 'tools'));
  await writeFile(path.join(project, 'tools', 'get-order.ts'), DECLARATION);
  await writeFile(path.join(project, 'tools', 'get-order.run.js'), RUN);
});

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
  await rm(bare, { recursive: true, force: true });
});

const call = (argv: readonly string[], stdin?: string) =>
  runCli(['tool', 'call', ...argv], {
    cwd: project,
    env: process.env,
    ...(stdin === undefined ? {} : { stdin }),
  });

describe('aw tool call', () => {
  it('runs the tool through the host: the result on stdout, the tool output on stderr', async () => {
    const run = await call(['get_order', '--input', '{"id":"A-1"}']);
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('{"id":"A-1","runId":"local"}\n');
    expect(run.stderr).toContain('[tool get_order] looking up A-1');
    expect(run.calls).toHaveLength(0);
  });

  it('reads the input from stdin with --input -', async () => {
    const run = await call(['get_order', '--input', '-'], '{"id":"B-2"}');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('{"id":"B-2","runId":"local"}\n');
  });

  it('--json prints the whole MCP result', async () => {
    const run = await call(['get_order', '--input', '{"id":"A-1"}', '--json']);
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(stdoutJson(run)).toEqual({
      content: [{ type: 'text', text: '{"id":"A-1","runId":"local"}' }],
    });
  });

  it('--jsonl prints the whole MCP result on one line', async () => {
    const run = await call(['get_order', '--input', '{"id":"A-1"}', '--jsonl']);
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe(
      `${JSON.stringify({ content: [{ type: 'text', text: '{"id":"A-1","runId":"local"}' }] })}\n`,
    );
  });

  it('refuses an --input that is not a JSON object, and a missing name, before starting anything', async () => {
    for (const argv of [
      ['get_order', '--input', 'not json'],
      ['get_order', '--input', '[1]'],
      ['get_order', '--input', '"text"'],
      [],
    ]) {
      const refused = await call(argv);
      expect(refused.code, argv.join(' ')).toBe(EXIT_CODE.usage);
      expect(refused.stderr).not.toContain('[tool host]');
    }
  });

  it('names the tools that are served when the name is unknown', async () => {
    const run = await call(['nope']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('no tool named nope');
    expect(run.stderr).toContain('the tools served are: get_order');
  });

  it('says a file name is not a tool name (BH061-048)', async () => {
    const run = await call(['get-order']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('tools/get-order.ts is a file');
    expect(run.stderr).toContain('the tools served are: get_order');
  });

  it('exits 1 with the tool message when the tool throws or the input breaks its schema', async () => {
    const thrown = await call(['get_order', '--input', '{"id":"boom"}']);
    expect(thrown.code).toBe(EXIT_CODE.problem);
    expect(thrown.stdout).toBe('order boom exploded\n');
    expect(thrown.stderr).toContain('tool get_order reported an error');

    const invalid = await call(['get_order']);
    expect(invalid.code).toBe(EXIT_CODE.problem);
    expect(invalid.stderr).toContain('tool get_order reported an error');
    // BH061-048: a readable line per issue, not ZodError's raw JSON.
    expect(invalid.stdout).toMatch(/^invalid input:\n[\s\S]*\bid\b/u);
    expect(invalid.stdout).not.toContain('"code"');
  });

  it('refuses a directory with no project file', async () => {
    const run = await runCli(['tool', 'call', 'get_order'], { cwd: bare, env: process.env });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('no agent-workspace.yaml in this directory');
    expect(run.stderr).toContain('fix: aw init --yes');
  });
});
