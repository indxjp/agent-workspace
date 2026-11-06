import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesToStream, encodeUstar } from '@agent-workspace/runtime/transfer';
import { describe, expect, it } from 'vitest';

import { relativeRuntimePath } from '../runtimes/contract';
import { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './memory-store';
import {
  buildRunRequest,
  context,
  emptyWorkspace,
  newRun,
  RUN,
  RUN_DONE,
  runtimeOf,
  SESSION,
  settle,
  silenceErrorLog,
  sse,
  urlOf,
} from './launcher.test-support';

const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

/** A one-file input archive, as `workspaceLifecycle.inputArchive` hands it to the launcher. */
const briefArchive = () =>
  bytesToStream(
    encodeUstar([
      {
        path: `workspace-1/${SESSION}/notes/brief.md`,
        type: 'file',
        mode: 0o444,
        data: Buffer.from('brief'),
      },
    ]),
  );

async function hydratesBeforeExecutionAndPromotesAfter() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const order: string[] = [];
  const inputArchive = new Uint8Array([1, 2, 3]);
  const outputArchive = new Uint8Array([4, 5, 6]);
  let promoted: Uint8Array | null = null;
  const launch = createRunnerLauncher({
    store,
    runtime: runtimeOf({ persistPaths: ['/workspace/output', 'report.txt'] }),
    buildRunRequest,
    workspaceLifecycle: {
      inputArchive: () => Promise.resolve(bytesToStream(inputArchive)),
      promoteOutputs: (_context, _runtime, archive) => {
        order.push('promote');
        promoted = archive;
        return Promise.resolve();
      },
    },
    fetch: async (input, init) => {
      const url = urlOf(input);
      if (url.endsWith('/files') && init?.method === 'POST') {
        order.push('hydrate');
        expect(new Uint8Array(await new Response(init.body).arrayBuffer())).toEqual(inputArchive);
        return Response.json({ hydrated: ['input.txt'] });
      }
      if (url.endsWith('/run')) {
        order.push('run');
        return sse(RUN_DONE);
      }
      expect(url).toBe('http://runtime:8080/files?path=output&path=report.txt');
      order.push('collect');
      return new Response(outputArchive, {
        headers: { 'content-type': 'application/x-tar', 'content-length': '3' },
      });
    },
  });

  launch(context(run));
  expect((await settle(store)).status).toBe('completed');
  expect(order).toEqual(['hydrate', 'run', 'collect', 'promote']);
  expect(promoted).toEqual(outputArchive);
}

// ADR-0163: a run that keeps no memory folder collects exactly what it collected before.
async function collectsOnlyOutputs(_name: string, extra: Record<string, unknown>) {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const cwd = `${WORKSPACE_ID}/${SESSION}`;
  const requested: string[] = [];
  const promotions: unknown[] = [];
  const permissions = {
    readFiles: true,
    writeFiles: true,
    runCommands: false,
    unrestrictedNetwork: false,
    ...extra,
  };
  const launch = createRunnerLauncher({
    store,
    runtime: runtimeOf(),
    buildRunRequest: () => ({ runId: RUN, cwd: `/workspace/${cwd}`, portable: { permissions } }),
    workspaceLifecycle: emptyWorkspace({
      promoteOutputs: (_context, _runtime, _archive, options) => {
        promotions.push(options);
        return Promise.resolve();
      },
    }),
    fetch: (input) => {
      const url = new URL(urlOf(input));
      if (url.pathname === '/run') return Promise.resolve(sse(RUN_DONE));
      requested.push(...url.searchParams.getAll('path'));
      const report = { path: `${cwd}/outputs/report.md`, type: 'file', mode: 0o644 } as const;
      return Promise.resolve(
        new Response(encodeUstar([{ ...report, data: Buffer.from('r') }]).slice()),
      );
    },
  });

  launch(context(run));
  expect((await settle(store)).status).toBe('completed');
  expect(requested).toEqual([`${cwd}/outputs`]);
  expect(promotions).toEqual([{ base: `${cwd}/outputs` }]);
}

// Issue #881: POST /files is not session-scoped on the in-process runner and failed with EACCES.
async function neverCallsLocalFiles() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const urls: string[] = [];
  const launch = createRunnerLauncher({
    store,
    runtime: runtimeOf({
      runtimeProfileId: 'profile-local',
      driver: 'local',
      persistPaths: [],
      fileTransfer: 'local-disk',
    }),
    buildRunRequest,
    workspaceLifecycle: emptyWorkspace(),
    fetch: (input) => {
      urls.push(urlOf(input));
      return Promise.resolve(sse(RUN_DONE));
    },
  });

  launch(context(run));
  expect((await settle(store)).status).toBe('completed');
  expect(urls).toEqual(['http://runtime:8080/run']);
}

// Issue #1576: a local run gets its input archive written into its cwd on this host before
// launch, still without a runner /files call.
async function writesLocalInputArchiveBeforeRun() {
  const root = await mkdtemp(join(tmpdir(), 'aw-local-attachments-'));
  const attachment = join(root, 'workspace-1', SESSION, 'notes', 'brief.md');
  try {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const urls: string[] = [];
    let presentAtLaunch = false;
    const launch = createRunnerLauncher({
      store,
      runtime: runtimeOf({
        runtimeProfileId: 'profile-local',
        driver: 'local',
        persistPaths: [],
        workspaceRoot: root,
        fileTransfer: 'local-disk',
      }),
      buildRunRequest,
      workspaceLifecycle: emptyWorkspace({ inputArchive: () => Promise.resolve(briefArchive()) }),
      fetch: async (input) => {
        urls.push(urlOf(input));
        presentAtLaunch = (await readFile(attachment, 'utf8')) === 'brief';
        return sse(RUN_DONE);
      },
    });

    launch(context(run));
    expect((await settle(store)).status).toBe('completed');
    expect(urls).toEqual(['http://runtime:8080/run']);
    expect(presentAtLaunch).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function hydrate(
  driver: 'docker' | 'local',
  fileTransfer: 'push-archive' | 'local-disk',
  workspaceRoot: string,
) {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const calls: string[] = [];
  const launch = createRunnerLauncher({
    store,
    runtime: runtimeOf({
      runtimeProfileId: 'profile',
      driver,
      persistPaths: [],
      workspaceRoot,
      fileTransfer,
    }),
    buildRunRequest,
    workspaceLifecycle: emptyWorkspace({ inputArchive: () => Promise.resolve(briefArchive()) }),
    fetch: async (input, init) => {
      const url = urlOf(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      // A streamed request body must be drained, as the real runner does.
      await new Response(init?.body).arrayBuffer();
      return url.endsWith('/files') ? new Response(null, { status: 204 }) : sse(RUN_DONE);
    },
  });
  launch(context(run));
  expect((await settle(store)).status).toBe('completed');
  return calls;
}

async function withTempRoot(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'aw-filetransfer-'));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const briefPath = (root: string) => join(root, 'workspace-1', SESSION, 'notes', 'brief.md');

async function extractsOnThisHostForLocalDisk() {
  await withTempRoot(async (root) => {
    const calls = await hydrate('docker', 'local-disk', root);
    expect(calls).toEqual(['POST http://runtime:8080/run']);
    expect(await readFile(briefPath(root), 'utf8')).toBe('brief');
  });
}

async function pushesArchiveForPushArchive() {
  await withTempRoot(async (root) => {
    const calls = await hydrate('local', 'push-archive', root);
    expect(calls).toEqual(['POST http://runtime:8080/files', 'POST http://runtime:8080/run']);
    await expect(readFile(briefPath(root), 'utf8')).rejects.toThrow();
  });
}

async function preservesRunFailureWhenPromotionFails() {
  const log = silenceErrorLog();
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const launch = createRunnerLauncher({
    store,
    runtime: runtimeOf({ persistPaths: ['output'] }),
    buildRunRequest,
    workspaceLifecycle: emptyWorkspace({
      promoteOutputs: () => Promise.reject(new Error('object store unavailable')),
    }),
    fetch: (input) =>
      Promise.resolve(
        urlOf(input).endsWith('/run')
          ? sse('event: run-error\ndata: {"message":"sdk failed"}\n\n')
          : new Response(new Uint8Array([1]), { headers: { 'content-type': 'application/x-tar' } }),
      ),
  });

  launch(context(run));
  const settled = await settle(store);
  expect(settled.status).toBe('failed');
  expect(settled.error).toContain('The runtime reported a run failure.');
  expect(settled.error).not.toContain('sdk failed');
  expect(settled.error).toContain('Run output could not be saved.');
  expect(settled.error).not.toContain('object store unavailable');
  expect(log).toHaveBeenCalled();
  log.mockRestore();
}

async function unsafePersistPathFailsTheRun() {
  const hostile = `a${String.fromCharCode(1)}b`;
  expect(() => relativeRuntimePath(hostile)).toThrow(/is not workspace-relative/u);

  const log = silenceErrorLog();
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const urls: string[] = [];
  const launch = createRunnerLauncher({
    store,
    runtime: runtimeOf({ persistPaths: [hostile] }),
    buildRunRequest,
    workspaceLifecycle: emptyWorkspace(),
    fetch: (input) => {
      urls.push(urlOf(input));
      return Promise.resolve(sse(RUN_DONE));
    },
  });

  launch(context(run));
  const settled = await settle(store);
  expect(settled.status).toBe('failed');
  expect(settled.error).toContain('Run output could not be saved.');
  expect(urls.filter((url) => url.includes('/files'))).toEqual([]);
  expect(JSON.stringify(log.mock.calls)).toContain('collect-workspace-outputs');
  log.mockRestore();
}

describe('createRunnerLauncher', () => {
  it(
    'hydrates before execution and durably promotes declared outputs afterward',
    hydratesBeforeExecutionAndPromotesAfter,
  );
  it.each([
    ['without memory', {}],
    ['with memory but no read switch', { memory: 'agent', readFiles: false }],
  ])('collects only outputs/ into runs/<id>/outputs for an agent %s', collectsOnlyOutputs);
  it("never calls a local target's /files, and the run still completes", neverCallsLocalFiles);
  it(
    'writes a local target input archive into the run cwd before the run starts',
    writesLocalInputArchiveBeforeRun,
  );

  // @story US-STO-06
  describe("[US-STO-06][unit][run] hydration follows the target's fileTransfer", () => {
    it(
      'extracts on this host for local-disk, whatever the driver id',
      extractsOnThisHostForLocalDisk,
    );
    it(
      'pushes the archive to the runtime for push-archive, even for the local id',
      pushesArchiveForPushArchive,
    );
  });

  it(
    'preserves the run failure while also reporting output-promotion failure',
    preservesRunFailureWhenPromotionFails,
  );
  it('a persist path key-safety refuses fails the run', unsafePersistPathFailsTheRun);
});
