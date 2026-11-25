/**
 * The command line of a use case's skill script (ADR-0173): arguments it does not know are refused,
 * a result is JSON on stdout, a refusal is JSON on stderr with a non-zero exit code.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EXIT_CODES,
  type ParsedArgs,
  parseArgs,
  runScript,
  runWhenMain,
} from '../office-reader/scripts/lib/cli.mjs';
import { TableError, readTable } from '../office-reader/scripts/lib/table.mjs';

const SPEC = {
  usage: 'sum.mjs <file.csv> [--column <name>] [--round <digits>]',
  positionals: ['file'],
  options: { column: { default: 'amount' }, round: {} },
} as const;

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
  };
}

function usageOf(argv: readonly string[]): string {
  try {
    parseArgs(argv, SPEC);
  } catch (error) {
    if (error instanceof TableError && error.code === 'usage') return error.message;
    throw error;
  }
  throw new Error('expected a usage refusal');
}

describe('parseArgs', () => {
  it('names the positionals, takes --name value and --name=value, and fills defaults', () => {
    expect(parseArgs(['a.csv', '--round', '-1'], SPEC)).toStrictEqual({
      positionals: { file: 'a.csv' },
      options: { round: '-1', column: 'amount' },
    });
    expect(parseArgs(['--column=予算', 'a.csv'], SPEC)).toStrictEqual({
      positionals: { file: 'a.csv' },
      options: { column: '予算' },
    });
    expect(parseArgs([], { usage: 'x.mjs', positionals: [] })).toStrictEqual({
      positionals: {},
      options: {},
    });
  });

  it('takes everything after a lone -- as positional', () => {
    expect(parseArgs(['--round', '2', '--', '--odd.csv'], SPEC)).toStrictEqual({
      positionals: { file: '--odd.csv' },
      options: { round: '2', column: 'amount' },
    });
    expect(usageOf(['--', 'a.csv', '--round'])).toContain('got 2');
  });

  it('refuses an unknown, repeated or empty option and a wrong number of arguments', () => {
    expect(usageOf(['a.csv', '--month', '2026-09'])).toBe(
      `unknown option --month; usage: ${SPEC.usage}`,
    );
    expect(usageOf(['a.csv', '--round', '1', '--round=2'])).toBe(
      `--round is given twice; usage: ${SPEC.usage}`,
    );
    for (const argv of [
      ['a.csv', '--round'],
      ['a.csv', '--round='],
      ['a.csv', '--round', '--column'],
    ])
      expect(usageOf(argv)).toBe(`--round needs a value; usage: ${SPEC.usage}`);
    expect(usageOf(['a.csv', 'b.csv'])).toBe(
      `1 argument(s) expected (file), got 2; usage: ${SPEC.usage}`,
    );
    expect(usageOf([])).toContain('got 0');
  });
});

async function csv(content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cli-'));
  const file = path.join(dir, 'amounts.csv');
  await writeFile(file, content);
  return file;
}

/** A use case's whole script: its calculation, over the table reader. */
const sum = ({ positionals, options }: ParsedArgs<'file', 'column' | 'round'>) => {
  const column = options.column ?? 'amount';
  const { rows } = readTable(positionals.file, {
    columns: { amount: { names: [column], type: 'whole' } },
  });
  return { total: rows.reduce((total, row) => total + row.amount, 0) };
};

describe('runScript', () => {
  it('prints the result as JSON on stdout and exits 0', async () => {
    const streams = io();
    const file = await csv('amount\n"1,000"\n234\n');
    expect(runScript([file], SPEC, sum, streams)).toBe(EXIT_CODES.ok);
    expect(JSON.parse(streams.out.join(''))).toStrictEqual({ total: 1234 });
    expect(streams.err).toStrictEqual([]);
  });

  it('prints a refusal of the data as JSON on stderr and exits 1', async () => {
    const streams = io();
    const file = await csv('amount\n1\n"2\n');
    expect(runScript([file], SPEC, sum, streams)).toBe(EXIT_CODES.refused);
    expect(JSON.parse(streams.err.join(''))).toStrictEqual({
      error: 'unclosed_quote',
      message: 'row 3: a quoted field is never closed',
      row: 3,
    });
    expect(streams.out).toStrictEqual([]);
  });

  it('prints a usage refusal and exits 2, without running the calculation', () => {
    const streams = io();
    const compute = vi.fn();
    expect(runScript(['--nope'], SPEC, compute, streams)).toBe(EXIT_CODES.usage);
    expect(JSON.parse(streams.err.join(''))).toMatchObject({ error: 'usage' });
    expect(compute).not.toHaveBeenCalled();
  });

  it('throws when compute returns a promise, printing nothing', () => {
    const streams = io();
    expect(() => runScript(['a.csv'], SPEC, () => Promise.resolve({ total: 1 }), streams)).toThrow(
      'compute returned a promise; a skill script computes synchronously',
    );
    expect(streams.out).toStrictEqual([]);
  });

  it('throws any other error: a fault of the script is not a refusal', () => {
    const fault = () => {
      throw new RangeError('bug');
    };
    expect(() => runScript(['a.csv'], SPEC, fault, io())).toThrow('bug');
  });
});

describe('runWhenMain', () => {
  const argv = process.argv;

  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('runs the script with the process arguments when it is the one Node started', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const script = path.join(tmpdir(), 'sum.mjs');
    process.argv = [process.execPath, script, await csv('amount\n5\n')];
    runWhenMain(pathToFileURL(script).href, SPEC, sum);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toStrictEqual({ total: 5 });
  });

  it('does nothing when a test imports the script', () => {
    const compute = vi.fn();
    runWhenMain(pathToFileURL(path.join(tmpdir(), 'other.mjs')).href, SPEC, compute);
    expect(compute).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
