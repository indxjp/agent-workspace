import type { IncomingMessage, ServerResponse } from 'node:http';
import { bytesToStream } from '@agent-workspace/runtime/transfer';
import { parseRunFailure } from '@indx-workspace/contracts/runs';
import { describe, expect, it, vi } from 'vitest';

import { DomainError } from '../errors';
import { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './memory-store';
import {
  buildRunRequest,
  closeRunner,
  context,
  emptyWorkspace,
  listenRunner,
  newRun,
  RUN_DONE,
  runnerUrl,
  runtimeOf,
  settle,
  silenceErrorLog,
  sse,
  urlOf,
} from './launcher.test-support';

/**
 * A 4 MiB archive pulled chunk by chunk, so the body is never held whole. The last chunk waits
 * (at most 2 s) for the runner's first byte: socket buffers can take a 4 MiB body whole before the
 * runner reads, so without the wait the order would be timing, not streaming. A launcher that
 * buffers pulls every chunk before it sends one, so the runner still sees its first byte only
 * after the last pull.
 */
function pacedArchive(total: number) {
  const seen = { pulled: 0, received: 0, pulledAtFirstByte: -1, transferEncoding: '' };
  let sawFirstByte = (): void => undefined;
  const firstByte = new Promise<void>((resolve) => {
    sawFirstByte = resolve;
  });
  const archive = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (seen.pulled === total) {
          controller.close();
          return;
        }
        if (seen.pulled + 64 * 1024 === total) {
          await Promise.race([firstByte, new Promise<void>((r) => setTimeout(r, 2_000))]);
        }
        controller.enqueue(new Uint8Array(64 * 1024).fill(7));
        seen.pulled += 64 * 1024;
      },
    },
    { highWaterMark: 0 },
  );
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== '/files') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(RUN_DONE);
      return;
    }
    seen.transferEncoding = String(req.headers['transfer-encoding']);
    req.on('data', (chunk: Buffer) => {
      if (seen.received === 0) {
        seen.pulledAtFirstByte = seen.pulled;
        sawFirstByte();
      }
      seen.received += chunk.byteLength;
    });
    req.on('end', () => res.writeHead(200).end('{}'));
  };
  return { archive, seen, handler };
}

// @story US-STO-06
async function hydrateSendsAStreamingBody() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const total = 4 * 1024 * 1024;
  const { archive, seen, handler } = pacedArchive(total);
  const runner = await listenRunner(handler);
  try {
    const launch = createRunnerLauncher({
      store,
      runtime: runtimeOf({ persistPaths: [], runnerUrl: runnerUrl(runner) }),
      buildRunRequest,
      workspaceLifecycle: emptyWorkspace({ inputArchive: () => Promise.resolve(archive) }),
    });

    launch(context(run));
    expect((await settle(store)).status).toBe('completed');
    expect(seen.received).toBe(total);
    // A streamed request body has no Content-Length; the runner saw bytes before the last pull.
    expect(seen.transferEncoding).toBe('chunked');
    expect(seen.pulledAtFirstByte).toBeLessThan(total);
  } finally {
    await closeRunner(runner);
  }
}

// @story US-STO-06
async function filesOverTheRunLimitFailBeforeSandbox() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const resolve = vi.fn();
  const urls: string[] = [];
  const launch = createRunnerLauncher({
    store,
    runtime: { resolve },
    buildRunRequest,
    workspaceLifecycle: emptyWorkspace({
      inputArchive: () =>
        Promise.reject(
          new DomainError({
            category: 'validation',
            code: 'run_files_too_large',
            publicMessage: 'run_files_too_large: the run is over the limit.',
          }),
        ),
    }),
    fetch: (input) => {
      urls.push(urlOf(input));
      return Promise.resolve(sse(RUN_DONE));
    },
  });

  launch(context(run));
  const settled = await settle(store);
  expect(settled.status).toBe('failed');
  expect(parseRunFailure(settled.error)?.code).toBe('run_files_too_large');
  // The runtime resolver allocates the sandbox; it was never asked, and nothing was sent.
  expect(resolve).not.toHaveBeenCalled();
  expect(urls).toEqual([]);
}

/** One 512-byte chunk, then the checksum check errors the archive part-way. */
function corruptingArchive(corrupt: DomainError): ReadableStream<Uint8Array> {
  let first = true;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(new Uint8Array(512));
          return;
        }
        controller.error(corrupt);
      },
    },
    { highWaterMark: 0 },
  );
}

// @story US-STO-06
async function corruptFileFailsWithRunFileCorrupt() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const corrupt = new DomainError({
    category: 'conflict',
    code: 'run_file_corrupt',
    publicMessage: 'run_file_corrupt: a granted file is corrupt.',
  });
  const runner = await listenRunner((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(200).end('{}'));
    req.on('error', () => undefined);
  });
  try {
    const launch = createRunnerLauncher({
      store,
      runtime: runtimeOf({ persistPaths: [], runnerUrl: runnerUrl(runner) }),
      buildRunRequest,
      workspaceLifecycle: emptyWorkspace({
        inputArchive: () => Promise.resolve(corruptingArchive(corrupt)),
      }),
    });

    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(parseRunFailure(settled.error)).toEqual({
      code: 'run_file_corrupt',
      message: 'a granted file is corrupt.',
    });
  } finally {
    await closeRunner(runner);
  }
}

async function logsRunnerReasonWhenHydrationIsRefused() {
  const log = silenceErrorLog();
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const launch = createRunnerLauncher({
    store,
    runtime: runtimeOf({ persistPaths: [] }),
    buildRunRequest,
    workspaceLifecycle: emptyWorkspace({
      inputArchive: () => Promise.resolve(bytesToStream(new Uint8Array([1]))),
    }),
    fetch: () =>
      Promise.resolve(
        Response.json(
          { error: 'invalid_archive', message: "EACCES: mkdir '/workspace'" },
          { status: 400 },
        ),
      ),
  });

  launch(context(run));
  const settled = await settle(store);
  expect(settled.error).toContain('The workspace could not be prepared.');
  expect(settled.error).not.toContain('EACCES');
  const causes = log.mock.calls
    .map(([, fields]) => String((fields as { error?: Error } | undefined)?.error?.cause))
    .join('\n');
  expect(causes).toContain('runtime returned HTTP 400');
  expect(causes).toContain('invalid_archive');
  expect(causes).toContain("EACCES: mkdir '/workspace'");
  log.mockRestore();
}

describe('createRunnerLauncher', () => {
  it('[US-STO-06][unit][run] hydrate sends a streaming body', hydrateSendsAStreamingBody);
  it(
    '[US-STO-06][unit][run] files over the run limit fail the run before a sandbox is created',
    filesOverTheRunLimitFailBeforeSandbox,
  );
  it(
    '[US-STO-06][unit][run] a corrupt file fails the run with run_file_corrupt',
    corruptFileFailsWithRunFileCorrupt,
  );
  it(
    "logs the runner's own reason when hydration is refused, and keeps it off the run",
    logsRunnerReasonWhenHydrationIsRefused,
  );
});
