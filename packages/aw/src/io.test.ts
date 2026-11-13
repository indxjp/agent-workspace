import { once } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  discardTypedAhead,
  InterruptedError,
  promptLine,
  readStreamWithIdleTimeout,
  stdinOnce,
  UsageError,
  type TypedAheadInput,
  type CliIo,
} from './io.js';

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

describe('promptLine', () => {
  // readline's question() never settles once its input has ended; the command must not hang there.
  it.each([
    [
      'is ended before it is asked',
      async (input: PassThrough) => {
        input.end();
        input.resume();
        await once(input, 'end');
      },
    ],
    [
      'is destroyed before it is asked',
      (input: PassThrough) => {
        input.destroy();
        return Promise.resolve();
      },
    ],
    [
      'ends while it waits',
      (input: PassThrough) => {
        setTimeout(() => input.end(), 10);
        return Promise.resolve();
      },
    ],
  ])('rejects as an interrupt when the input %s', async (_name, end) => {
    const input = new PassThrough();
    await end(input);
    const answer = promptLine(input, new PassThrough(), 'Save this draft? [y/N] ');
    const timeout = new Promise((resolve) => setTimeout(() => resolve('unsettled'), 1000));
    await expect(Promise.race([answer, timeout])).rejects.toBeInstanceOf(InterruptedError);
  });

  it('answers the line typed', async () => {
    const input = new PassThrough();
    const answer = promptLine(input, new PassThrough(), 'q? ');
    input.write('y\n');
    await expect(answer).resolves.toBe('y');
  });
});

describe('discardTypedAhead', () => {
  /** A terminal that delivers `typed` in the window; `modes` records every raw-mode change. */
  function terminal(typed: readonly string[], isTTY = true) {
    const modes: boolean[] = [];
    const listeners = new Set<(chunk: Buffer | string) => void>();
    let paused = false;
    const stdin: TypedAheadInput = {
      isTTY,
      setRawMode: (raw) => modes.push(raw),
      on: (_event, listener) => listeners.add(listener),
      off: (_event, listener) => listeners.delete(listener),
      resume: () => {
        paused = false;
      },
      pause: () => {
        paused = true;
      },
    };
    const wait = (): Promise<void> => {
      for (const text of typed) for (const listener of listeners) listener(Buffer.from(text));
      return Promise.resolve();
    };
    return { stdin, wait, modes, listeners, isPaused: () => paused };
  }

  it('drops what was typed ahead, a half-typed line included, and restores the terminal', async () => {
    const { stdin, wait, modes, listeners, isPaused } = terminal(['yes', 'no\n', 'half']);
    await expect(discardTypedAhead(stdin, 30, wait)).resolves.toBeUndefined();
    expect(modes).toEqual([true, false]);
    expect(listeners.size).toBe(0);
    expect(isPaused()).toBe(true);
  });

  it('is an interrupt when Ctrl-C was typed in the window, and still restores the terminal', async () => {
    const { stdin, wait, modes, listeners } = terminal(['abc', '\x03']);
    await expect(discardTypedAhead(stdin, 30, wait)).rejects.toBeInstanceOf(InterruptedError);
    expect(modes).toEqual([true, false]);
    expect(listeners.size).toBe(0);
  });

  it('restores the terminal when waiting fails', async () => {
    const { stdin, modes } = terminal([]);
    const failing = (): Promise<void> => Promise.reject(new Error('timer failed'));
    await expect(discardTypedAhead(stdin, 30, failing)).rejects.toThrow('timer failed');
    expect(modes).toEqual([true, false]);
  });

  it('does nothing when standard input is not a terminal', async () => {
    const { stdin, wait, modes } = terminal(['\x03'], false);
    await expect(discardTypedAhead(stdin, 30, wait)).resolves.toBeUndefined();
    expect(modes).toEqual([]);
  });
});
