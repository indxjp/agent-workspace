/**
 * The tools a use-cases entry's recording plays against: `Read` and `Write` on the run's working
 * directory only, and `run_skill_script`, which runs a granted skill's real script there (the entry's
 * own or a built-in one) and refuses anything else, as the platform does.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import budgetAgent from '../../../use-cases/budget/agents/budget.ts';
import proposalAgent from '../../../use-cases/proposal/agents/proposal.ts';
import { fileTools, skillScripts } from './use-case-desk.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const NO_SCOPE = { fileScope: null };

let work = '';
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'use-case-desk-tools-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('Read and Write in a recording', () => {
  it('writes a file under the working directory and reads it back', async () => {
    const tools = fileTools(work);
    const wrote = await tools('Write', { file_path: '/workspace/drafts/a.json', content: '{}' });
    expect(wrote).toEqual({ text: 'ok', isError: false });
    expect(readFileSync(path.join(work, 'drafts', 'a.json'), 'utf8')).toBe('{}');
    expect(await tools('Read', { file_path: '/workspace/drafts/a.json' })).toEqual({
      text: '{}',
      isError: false,
    });
  });

  it('refuses a path outside the working directory, and reads no missing file', async () => {
    const tools = fileTools(work);
    const escape = `${path.basename(work)}-escape`;
    for (const file of ['/etc/x', `/workspace/../${escape}`]) {
      expect(await tools('Write', { file_path: file, content: 'x' })).toEqual({
        text: `Path is outside the workspace: ${file}`,
        isError: true,
      });
    }
    expect(existsSync(path.join(work, '..', escape))).toBe(false);
    expect(await tools('Read', { file_path: '/workspace/none.md' })).toEqual({
      text: 'File does not exist: /workspace/none.md',
      isError: true,
    });
    expect(tools('Glob', {})).toBeNull();
  });
});

describe('run_skill_script in a recording', () => {
  const source = path.join(ROOT, 'use-cases', 'proposal');
  const run = (args: Record<string, unknown>, agent = proposalAgent) => {
    const { run_skill_script: call } = skillScripts(agent, source, work);
    if (call === undefined) throw new Error('no run_skill_script');
    return call(args, NO_SCOPE);
  };

  it('runs the granted built-in office-writer into outputs/, which it creates', async () => {
    writeFileSync(
      path.join(work, 'deck.json'),
      JSON.stringify({ format: 'pptx', slides: [{ title: 'T', bullets: ['b'] }] }),
    );
    const result = await run({
      skill: 'office-writer',
      script: 'write.mjs',
      args: ['deck.json', 'outputs/deck.pptx'],
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ written: 'outputs/deck.pptx' });
    expect(existsSync(path.join(work, 'outputs', 'deck.pptx'))).toBe(true);
  });

  it('answers the script’s refusal as an error, with what it printed', async () => {
    const result = await run({
      skill: 'office-writer',
      script: 'write.mjs',
      args: ['none.json', 'outputs/deck.pptx'],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('unreadable_model');
  });

  it('refuses an argument that is absolute or climbs out of the run’s folder, running nothing', async () => {
    writeFileSync(
      path.join(work, 'deck.json'),
      JSON.stringify({ format: 'pptx', slides: [{ title: 'T' }] }),
    );
    for (const args of [
      ['deck.json', '/tmp/deck.pptx'],
      ['deck.json', 'outputs/../../deck.pptx'],
      ['../deck.json', 'outputs/deck.pptx'],
    ]) {
      const result = await run({ skill: 'office-writer', script: 'write.mjs', args });
      expect(result.isError, args.join(' ')).toBe(true);
      expect(result.text).toMatch(/^argument outside the run's folder/u);
    }
    expect(existsSync(path.join(work, 'outputs'))).toBe(false);
  });

  it('refuses a skill the agent is not granted, a script outside scripts/ and a missing one', async () => {
    const refused = [
      // budget is granted no office-writer.
      run({ skill: 'office-writer', script: 'write.mjs', args: [] }, budgetAgent),
      run({ skill: 'office-writer', script: '../SKILL.md', args: [] }),
      run({ skill: 'proposal', script: 'none.mjs', args: [] }),
    ];
    for (const result of await Promise.all(refused)) expect(result.isError).toBe(true);
  });
});
