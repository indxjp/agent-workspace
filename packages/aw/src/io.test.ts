import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { readStreamWithIdleTimeout, stdinOnce, UsageError, type CliIo } from './io.js';

function ioWith(overrides: Partial<CliIo>): CliIo {
  return {
    stdin: () => Promise.resolve('piped'),
    stdout: () => undefined,
    stderr: () => undefined,
    env: {},
    homeDir: 'C:/nonexistent-home',
    fetch: () => Promise.reject(new Error('no network')),
    isTty: false,
    ...overrides,
  };
}

describe('readStreamWithIdleTimeout (#879)', () => {
  it('rejects a usage error when an open pipe stays silent', async () => {
    const input = new PassThrough();
    await expect(readStreamWithIdleTimeout(input, 20)).rejects.toBeInstanceOf(UsageError);
  });

  it('reads data followed by end', async () => {
    const input = new PassThrough();
    const read = readStreamWithIdleTimeout(input, 1000);
    input.write('hello ');
    input.end('world');
    await expect(read).resolves.toBe('hello world');
  });

  it('gives up on a pipe that goes quiet after some data', async () => {
    const input = new PassThrough();
    const read = readStreamWithIdleTimeout(input, 20);
    input.write('partial');
    await expect(read).rejects.toThrow(/stayed open/u);
  });

  it('reads an empty, already closed input as the empty string', async () => {
    const input = new PassThrough();
    input.end();
    await expect(readStreamWithIdleTimeout(input, 1000)).resolves.toBe('');
  });
});

describe('stdinOnce (#879)', () => {
  it('refuses a terminal instead of waiting for a person', async () => {
    const read = stdinOnce(ioWith({ isTty: true, stdinIsTty: true }));
    await expect(read()).rejects.toThrow(/standard input is a terminal/u);
  });

  it('names a fix that holds for every stdin reader, not one command', async () => {
    const read = stdinOnce(ioWith({ isTty: true, stdinIsTty: true }));
    await expect(read()).rejects.toMatchObject({
      fix: 'pipe the input in (… | aw …) or redirect a file (< file); for a key, set AGENT_WORKSPACE_API_KEY instead',
    });
  });

  it('refuses a terminal on stdin even when CI left isTty false', async () => {
    const read = stdinOnce(ioWith({ isTty: false, stdinIsTty: true }));
    await expect(read()).rejects.toBeInstanceOf(UsageError);
  });

  it('reads a pipe once, and refuses a second reader', async () => {
    const read = stdinOnce(ioWith({}));
    await expect(read()).resolves.toBe('piped');
    await expect(read()).rejects.toBeInstanceOf(UsageError);
  });
});
