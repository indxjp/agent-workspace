import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { InterruptedError } from '../io.js';
import { unsetProblem } from './project-resources.js';
import { keyShell, missingKeyLines, promptSecret } from './environment.js';

const KEY = 'sk-ant-api03-never-echoed-0123456789';

describe('promptSecret (issue #690)', () => {
  it('returns the typed line, writes the question and never echoes what was typed', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8');
    });
    const answer = promptSecret('  key › ', input, output);
    input.write(`${KEY}\n`);
    expect(await answer).toBe(KEY);
    expect(written).toContain('key ›');
    expect(written).not.toContain(KEY);
    expect(written).not.toContain('sk-ant');
  });

  it('ends as an interrupt on Ctrl-C, Ctrl-D and an aborted signal, not as an unexpected error', async () => {
    for (const keypress of ['\u0003', '\u0004']) {
      const input = new PassThrough();
      const answer = promptSecret('key › ', input, new PassThrough());
      input.write(keypress);
      await expect(answer).rejects.toBeInstanceOf(InterruptedError);
    }
    const controller = new AbortController();
    const answer = promptSecret('key › ', new PassThrough(), new PassThrough(), controller.signal);
    controller.abort();
    await expect(answer).rejects.toBeInstanceOf(InterruptedError);
  });

  it('names only the variable in the missing-key lines', () => {
    expect(missingKeyLines('ANTHROPIC_API_KEY', 'posix')).toEqual([
      'no ANTHROPIC_API_KEY in this shell',
      'export ANTHROPIC_API_KEY=sk-ant-\u2026',
    ]);
    expect(missingKeyLines('OPENAI_API_KEY', 'posix')[1]).toBe('export OPENAI_API_KEY=<your key>');
  });

  it('prints both Windows lines, and the POSIX line elsewhere (UX-B)', () => {
    expect(missingKeyLines('ANTHROPIC_API_KEY', keyShell('win32')).slice(1)).toEqual([
      'PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-…"',
      'cmd:        set ANTHROPIC_API_KEY=sk-ant-…',
    ]);
    for (const platform of ['linux', 'darwin'] as const) {
      expect(missingKeyLines('OPENAI_API_KEY', keyShell(platform))).toEqual([
        'no OPENAI_API_KEY in this shell',
        'export OPENAI_API_KEY=<your key>',
      ]);
    }
  });

  it('says the Windows fix as one sentence, with no column padding (UX-B)', () => {
    const { fix } = unsetProblem('ANTHROPIC_API_KEY', 'windows');
    expect(fix).toBe(
      'Run: PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-…" or cmd: set ANTHROPIC_API_KEY=sk-ant-…, then restart aw dev.',
    );
    expect(unsetProblem('OPENAI_API_KEY', 'posix').fix).toBe(
      'Run: export OPENAI_API_KEY=<your key>, then restart aw dev.',
    );
  });
});
