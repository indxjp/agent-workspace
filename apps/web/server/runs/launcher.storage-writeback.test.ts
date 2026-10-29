/**
 * When the launcher saves a run's read-write storage folders (US-STO-12): only for a run decided
 * `completed`, while it is still `running` so its session stays busy, and until its deadline, the
 * host's remaining budget or an interrupt, so a slow or hung store never holds the run for good.
 */
// @story US-STO-12
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { encodeUstar } from '@agent-workspace/runtime/transfer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  writeBackStorage,
  type StorageWriteBackAuditEvent,
  type StorageWriteBackRun,
} from '../compose/storage-writeback';
import type { LaunchContext } from './environment';
import { resetLiveRuns, signalLiveRun } from './interrupt';
import {
  createRunnerLauncher,
  STORAGE_WRITEBACK_HOST_MARGIN_MS,
  staleRunAfterMs,
  type RunnerLauncherOptions,
} from './launcher';
import { InMemoryRunStore } from './memory-store';
import type { RunRecord } from './store';

const RUN = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const CONNECTION = '55555555-5555-4555-8555-555555555555';
const CWD = `${WORKSPACE}/${SESSION}`;
const FOLDER = 'storage/acme-data/reports';

const DONE = 'event: run-done\ndata: {}\n\n';

function context(run: RunRecord, outputSchema?: Record<string, unknown>): LaunchContext {
  return {
    run,
    agent: { id: AGENT, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' },
    session: { id: SESSION, agentId: AGENT, engine: null },
    principal: {
      principalId: '77777777-7777-4777-8777-777777777777',
      ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
      userId: '66666666-6666-4666-8666-666666666666',
      workspaceId: WORKSPACE,
      scope: null,
    },
    prompt: 'hello',
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}

const tar = (files: Readonly<Record<string, string>>, folder: string) =>
  encodeUstar(
    Object.entries(files).map(([name, content]) => ({
      path: `${folder}/${name}`,
      type: 'file' as const,
      mode: 0o644,
      data: Buffer.from(content),
    })),
  );

/** An SSE body that sends `frames` only after `delayMs`, ignoring any abort. */
function late(frames: string, delayMs: number): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      controller.enqueue(new TextEncoder().encode(frames));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

const urlOf = (input: string | URL | Request) =>
  new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

interface Launch {
  /** The `/run` answer. */
  readonly run: () => Response;
  readonly outputSchema?: Record<string, unknown>;
  readonly promoteOutputs?: () => Promise<void>;
  readonly storageWriteback: NonNullable<RunnerLauncherOptions['storageWriteback']>;
  readonly maxRunDurationMs?: number;
  readonly hostMaxRunDurationMs?: number;
  /** How the runtime's files reach this host; `push-archive` (streamed over `GET /files`) by default. */
  readonly fileTransfer?: 'push-archive' | 'local-disk';
  /** The runtime root; a real directory for `local-disk`. */
  readonly workspaceRoot?: string;
  /** The launch body's `resources.files`; the read-write folder alone by default. */
  readonly bodyFiles?: readonly Record<string, string>[];
  /** What the runtime answers for the folder over `GET /files`. */
  readonly folderFiles?: Readonly<Record<string, string>>;
}

/** Launches one run against a runner double; answers when the launch has settled. */
async function launch(options: Launch, store = new InMemoryRunStore()) {
  const run = await store.create({
    engine: 'claude-agent-sdk',
    id: RUN,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    sessionId: SESSION,
  });
  let settled!: () => void;
  const done = new Promise<void>((resolve) => {
    settled = resolve;
  });
  createRunnerLauncher({
    store,
    runtime: {
      resolve: () =>
        Promise.resolve({
          runtimeProfileId: 'profile-docker',
          driver: 'docker',
          networkPolicy: 'none',
          filesystem: 'read-write',
          runnerUrl: 'http://runtime:8080',
          workspaceRoot: options.workspaceRoot ?? '/workspace',
          fileTransfer: options.fileTransfer ?? 'push-archive',
        }),
    },
    buildRunRequest: () => ({
      runId: RUN,
      cwd: `${options.workspaceRoot ?? '/workspace'}/${CWD}`,
      portable: { permissions: { writeFiles: true } },
      resources: {
        files: options.bodyFiles ?? [{ kind: 'directory', path: FOLDER, access: 'read-write' }],
      },
    }),
    workspaceLifecycle: {
      inputArchive: () => Promise.resolve(null),
      promoteOutputs: options.promoteOutputs ?? (() => Promise.resolve()),
    },
    fetch: (input) => {
      const url = urlOf(input);
      if (url.pathname === '/run') return Promise.resolve(options.run());
      if (url.pathname === '/interrupt') return Promise.resolve(Response.json({}, { status: 202 }));
      const path = url.searchParams.get('path');
      if (path === `${CWD}/outputs`) {
        return Promise.resolve(new Response(tar({ 'out.md': 'out' }, path).slice()));
      }
      if (path === `${CWD}/${FOLDER}`) {
        return Promise.resolve(
          new Response(
            tar(options.folderFiles ?? { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' }, path).slice(),
          ),
        );
      }
      return Promise.resolve(Response.json({ error: 'file_not_found' }, { status: 404 }));
    },
    storageWriteback: options.storageWriteback,
    ...(options.maxRunDurationMs === undefined
      ? {}
      : { maxRunDurationMs: options.maxRunDurationMs }),
    ...(options.hostMaxRunDurationMs === undefined
      ? {}
      : { hostMaxRunDurationMs: options.hostMaxRunDurationMs }),
    onLaunchSettled: () => settled(),
  })(context(run, options.outputSchema));
  await done;
  return store.get(RUN);
}

const completing = () => new Response(DONE, { headers: { 'Content-Type': 'text/event-stream' } });

const roots: string[] = [];

afterEach(async () => {
  resetLiveRuns();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('a run that did not conclude completed leaves the connection untouched', () => {
  const untouched: readonly [string, Omit<Launch, 'storageWriteback'>, string][] = [
    [
      'output promotion fails',
      {
        run: () => new Response(DONE, { headers: { 'Content-Type': 'text/event-stream' } }),
        promoteOutputs: () => Promise.reject(new Error('object store unavailable')),
      },
      'failed',
    ],
    [
      'the output schema is unsatisfied',
      {
        run: () => new Response(DONE, { headers: { 'Content-Type': 'text/event-stream' } }),
        outputSchema: { type: 'object' },
      },
      'failed',
    ],
    [
      'the runtime reports a failure',
      {
        run: () =>
          new Response('event: run-error\ndata: {"message":"sdk failed"}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
      },
      'failed',
    ],
    [
      'the run is cancelled',
      {
        run: () =>
          new Response('event: run-interrupted\ndata: {"interrupted":true}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
      },
      'cancelled',
    ],
    [
      'the lifetime expired before the runtime reported completion',
      { run: () => late(DONE, 80), maxRunDurationMs: 20 },
      'failed',
    ],
  ];

  it.each(untouched)('[US-STO-12][unit][run] when %s', async (_name, options, status) => {
    const storageWriteback = vi.fn(() => Promise.resolve());
    const record = await launch({ ...options, storageWriteback });

    expect(record?.status).toBe(status);
    expect(storageWriteback).not.toHaveBeenCalled();
  });

  it('[US-STO-12][unit][run] saves a run decided completed while it is still running, then concludes it', async () => {
    const store = new InMemoryRunStore();
    const statusAtSave: (string | undefined)[] = [];
    const record = await launch(
      {
        run: completing,
        storageWriteback: async () => {
          statusAtSave.push((await store.get(RUN))?.status);
        },
      },
      store,
    );

    // Still `running`, so the session is still busy: no next run hydrates over the folders.
    expect(statusAtSave).toEqual(['running']);
    expect(record?.status).toBe('completed');
  });

  it('[US-STO-12][unit][run] writes nothing for a run another replica made terminal just before the save', async () => {
    const store = new InMemoryRunStore();
    let saved: Awaited<ReturnType<typeof saveToHungStore>> | undefined;
    const record = await launch(
      {
        run: completing,
        // The last step before the save: an interrupt served by another replica lands here.
        promoteOutputs: async () => {
          await store.finish(RUN, 'cancelled', 'interrupted elsewhere', true);
        },
        storageWriteback: async (run) => {
          const stop = new AbortController();
          saved = await saveToHungStore(
            { ...run, signal: AbortSignal.any([run.signal, stop.signal]) },
            () => stop.abort(),
          );
        },
      },
      store,
    );

    expect(record?.status).toBe('cancelled');
    expect(saved?.writes ?? []).toEqual([]);
    expect(saved?.labels ?? []).toEqual([]);
  });

  it('[US-STO-12][unit][run] concludes completed when the write-back itself fails', async () => {
    const record = await launch({
      run: completing,
      storageWriteback: () => Promise.reject(new Error('the connection store is down')),
    });

    expect(record?.status).toBe('completed');
  });
});

/** Saves `run` to a connection whose `write` calls `onWrite`, then never answers: a hung store. */
async function saveToHungStore(
  run: Omit<StorageWriteBackRun, 'folders'>,
  onWrite: (key: string) => void,
) {
  const writes: string[] = [];
  const labels: string[] = [];
  const counts = await writeBackStorage(
    { ...run, folders: new Map([[FOLDER, { connectionId: CONNECTION, prefix: 'reports' }]]) },
    {
      readRunAgent: () =>
        Promise.resolve({
          agent: { permissions: { writeFiles: true } },
          assignments: {
            files: [],
            skillIds: [],
            connectorIds: [],
            storageGrants: [{ connectionId: CONNECTION, prefix: 'reports', access: 'read-write' }],
          },
        } as never),
      connections: {
        get: (_workspaceId, connectionId) =>
          Promise.resolve(
            connectionId === CONNECTION
              ? { name: 'acme-data', allowedPrefixes: ['reports'], writeAllowed: true }
              : null,
          ),
        openWritable: () =>
          Promise.resolve({
            read: () => Promise.resolve(null),
            write: (key: string) => {
              writes.push(key);
              onWrite(key);
              return new Promise<never>(() => undefined);
            },
          }),
      },
      audit: (event: StorageWriteBackAuditEvent) => {
        labels.push(event.subjectLabel);
        return Promise.resolve();
      },
      stillRunning: () => Promise.resolve(true),
    },
  );
  return { writes, labels, counts: counts.get(CONNECTION) };
}

describe('the write-back stops', () => {
  it('[US-STO-12][unit][run] between files on a hung store, the run concluding completed and the slot released', async () => {
    let saved: Awaited<ReturnType<typeof saveToHungStore>> | undefined;
    const record = await launch({
      run: completing,
      storageWriteback: async (run) => {
        // The deadline passes inside the first write, so no assertion depends on how long planning
        // took. It aborts with the reason `AbortSignal.timeout` gives.
        const stop = new AbortController();
        saved = await saveToHungStore(
          { ...run, signal: AbortSignal.any([run.signal, stop.signal]) },
          () => stop.abort(new DOMException('the write-back deadline passed', 'TimeoutError')),
        );
      },
    });

    expect(record?.status).toBe('completed');
    expect(saved?.writes).toEqual(['reports/a.md']);
    expect(saved?.counts).toMatchObject({ written: 0, failed: 3 });
    expect(saved?.labels).toEqual([
      expect.stringContaining(' · 3 failed · 0 bytes · refused: deadline'),
    ]);
    // Released once the write-back ended: this process no longer signals the run's runtime.
    const signals = vi.fn(() => Promise.resolve(Response.json({}, { status: 202 })));
    await signalLiveRun(RUN, signals);
    expect(signals).not.toHaveBeenCalled();
  });

  it("[US-STO-12][unit][run] at the host's remaining budget, before its own deadline, recording the row", async () => {
    let saved: Awaited<ReturnType<typeof saveToHungStore>> | undefined;
    let reason: unknown;
    const record = await launch({
      run: completing,
      // The host leaves the write-back a few milliseconds of its five-minute deadline.
      hostMaxRunDurationMs: STORAGE_WRITEBACK_HOST_MARGIN_MS + 50,
      storageWriteback: async (run) => {
        saved = await saveToHungStore(run, () => undefined);
        reason = run.signal.reason;
      },
    });

    expect(record?.status).toBe('completed');
    expect(reason).toMatchObject({ name: 'TimeoutError' });
    expect(saved?.labels).toEqual([expect.stringContaining('refused: deadline')]);
  });

  it('[US-STO-12][unit][run] short of the stale-run sweep for a run that used almost all its lifetime', async () => {
    const maxRunDurationMs = 60_000;
    const staleAfterMs = staleRunAfterMs(maxRunDurationMs);
    // The store's clock stamps `startedAt` so far back that the sweep is a margin and 50 ms away.
    const store = new InMemoryRunStore({
      now: () => new Date(Date.now() - (staleAfterMs - STORAGE_WRITEBACK_HOST_MARGIN_MS - 50)),
    });
    let saved: Awaited<ReturnType<typeof saveToHungStore>> | undefined;
    let reason: unknown;
    let sweepWouldFail: boolean | undefined;
    const record = await launch(
      {
        run: completing,
        maxRunDurationMs,
        storageWriteback: async (run) => {
          const startedAt = (await store.get(RUN))?.startedAt ?? new Date(0);
          // The sweep's own test (`listStaleRunIds`), at the moment the write-back is stopped.
          run.signal.addEventListener('abort', () => {
            sweepWouldFail = startedAt.getTime() < Date.now() - staleAfterMs;
          });
          saved = await saveToHungStore(run, () => undefined);
          reason = run.signal.reason;
        },
      },
      store,
    );

    expect(record?.status).toBe('completed');
    expect(reason).toMatchObject({ name: 'TimeoutError' });
    expect(sweepWouldFail).toBe(false);
    expect(saved?.labels).toEqual([expect.stringContaining('refused: deadline')]);
  });

  it('[US-STO-12][unit][run] on an interrupt, writing nothing more, the run concluding cancelled with its row', async () => {
    const store = new InMemoryRunStore();
    let saved: Awaited<ReturnType<typeof saveToHungStore>> | undefined;
    // What `POST /api/runs/:id/interrupt` does on this process: the terminal status, then the signal.
    const interrupt = async () => {
      await store.finish(RUN, 'cancelled', 'the run was interrupted by request', true);
      await signalLiveRun(RUN, () => Promise.resolve(Response.json({}, { status: 202 })));
    };
    const record = await launch(
      {
        run: completing,
        storageWriteback: async (run) => {
          saved = await saveToHungStore(run, () => void interrupt());
        },
      },
      store,
    );

    expect(record?.status).toBe('cancelled');
    expect(saved?.writes).toEqual(['reports/a.md']);
    expect(saved?.counts).toMatchObject({ written: 0, failed: 3 });
    expect(saved?.labels).toEqual([expect.stringContaining(' · 3 failed · ')]);
  });
});

/** Saves `run` with the run's grants as they are now, to a connection that records every write. */
async function saveWithGrants(
  run: Omit<StorageWriteBackRun, 'folders'>,
  grants: readonly { prefix: string; access: 'read' | 'read-write' }[],
) {
  const writes: string[] = [];
  const counts = await writeBackStorage(
    { ...run, folders: new Map([[FOLDER, { connectionId: CONNECTION, prefix: 'reports' }]]) },
    {
      readRunAgent: () =>
        Promise.resolve({
          agent: { permissions: { writeFiles: true } },
          assignments: {
            files: [],
            skillIds: [],
            connectorIds: [],
            storageGrants: grants.map((grant) => ({ connectionId: CONNECTION, ...grant })),
          },
        } as never),
      connections: {
        get: () =>
          Promise.resolve({ name: 'acme-data', allowedPrefixes: ['reports'], writeAllowed: true }),
        openWritable: () =>
          Promise.resolve({
            read: () => Promise.resolve(null),
            write: async (key: string, body: ReadableStream<Uint8Array> | Uint8Array) => {
              writes.push(key);
              if (!(body instanceof Uint8Array)) await new Response(body).arrayBuffer();
              return { sizeBytes: 0, contentType: null, etag: '"e"', lastModified: new Date(0) };
            },
          }),
      },
      audit: () => Promise.resolve(),
      stillRunning: () => Promise.resolve(true),
    },
  );
  return { writes, counts: counts.get(CONNECTION) };
}

// `push-archive` streams the folder from the runtime's `GET /files`; `local-disk` archives it here.
describe.each(['push-archive', 'local-disk'] as const)(
  'a %s write-back keeps the launch body read-only paths',
  (fileTransfer) => {
    const after = { '2026/q3.csv': 'q3,43\n', 'top.md': '# Top\n' };

    /** Launches with `reports` read-write and `reports/2026` read-only; `grants` are the ones now. */
    async function saveAfter(grants: readonly { prefix: string; access: 'read' | 'read-write' }[]) {
      const root = await mkdtemp(join(tmpdir(), 'aw-wb-launch-'));
      roots.push(root);
      for (const [name, content] of Object.entries(after)) {
        const file = join(root, CWD, FOLDER, name);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content);
      }
      let saved: Awaited<ReturnType<typeof saveWithGrants>> | undefined;
      const record = await launch({
        run: completing,
        fileTransfer,
        workspaceRoot: root,
        folderFiles: after,
        bodyFiles: [
          { kind: 'directory', path: FOLDER, access: 'read-write' },
          { kind: 'directory', path: `${FOLDER}/2026`, access: 'read' },
          { kind: 'file', path: `${FOLDER}/2026/q3.csv`, access: 'read' },
        ],
        storageWriteback: async (run) => {
          saved = await saveWithGrants(run, grants);
        },
      });
      expect(record?.status).toBe('completed');
      return saved;
    }

    it('[US-STO-12][unit][run] writes only the sibling once the read grant is removed during the run', async () => {
      const saved = await saveAfter([{ prefix: 'reports', access: 'read-write' }]);

      expect(saved?.writes).toEqual(['reports/top.md']);
      expect(saved?.counts).toMatchObject({ written: 1, refused: 1 });
    });

    it('[US-STO-12][unit][run] writes nothing once the read-write grant is removed during the run', async () => {
      const saved = await saveAfter([{ prefix: 'reports/2026', access: 'read' }]);

      expect(saved?.writes).toEqual([]);
      expect(saved?.counts).toMatchObject({ written: 0, refused: 1 });
    });
  },
);
