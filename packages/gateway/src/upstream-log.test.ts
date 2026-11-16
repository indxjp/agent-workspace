import { describe, expect, it, vi } from 'vitest';

import { createJsonLogger, type LogLevel } from '@agent-workspace/core/telemetry';

import { guardedFetch } from '@agent-workspace/core';
import { loggedFetch } from './upstream-log.js';

describe('loggedFetch', () => {
  it('logs the host of the call and nothing else, then delegates', async () => {
    const lines: string[] = [];
    const log = createJsonLogger({
      service: 'gateway',
      write: (_l: LogLevel, line) => lines.push(line),
    });
    const base = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const call = loggedFetch(log, base);

    await call('https://aiplatform.googleapis.com/v1/projects/p/secret-path?key=1', {
      headers: { authorization: 'Bearer abc' },
      body: 'payload',
    });

    expect(base).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({
      msg: 'model upstream request',
      host: 'aiplatform.googleapis.com',
    });
    expect(lines[0]).not.toMatch(/secret-path|abc|payload|key=1/u);
  });
});

describe('loggedFetch with guardedFetch', () => {
  it('keeps pinning an http target to the address that was checked', async () => {
    const log = createJsonLogger({ service: 'gateway', write: () => undefined });
    const real = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    try {
      await guardedFetch(
        'http://localhost:9500/v1',
        {},
        { production: false, allowHosts: [] },
        loggedFetch(log),
        () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      );
      // The wrapper is called with the pinned URL, and is treated as real so the http target is pinned.
      expect(real.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9500/v1');
    } finally {
      real.mockRestore();
    }
  });

  it('writes the host log line when guardedFetch sends an https request through it', async () => {
    const lines: string[] = [];
    const log = createJsonLogger({
      service: 'gateway',
      write: (_l: LogLevel, line) => lines.push(line),
    });
    const real = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    try {
      await guardedFetch(
        'https://aiplatform.googleapis.com/v1/x',
        {},
        { production: true, allowHosts: [] },
        loggedFetch(log),
        () => Promise.resolve([{ address: '142.250.0.1', family: 4 }]),
      );
      expect(real).toHaveBeenCalledTimes(1);
      expect(real.mock.calls[0]?.[0]).toBe('https://aiplatform.googleapis.com/v1/x');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
        msg: 'model upstream request',
        host: 'aiplatform.googleapis.com',
      });
    } finally {
      real.mockRestore();
    }
  });
});
