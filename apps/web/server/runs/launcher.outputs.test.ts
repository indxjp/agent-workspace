import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCatalogFiles } from '@agent-workspace/core/db';
import { createInMemoryCatalog } from '@agent-workspace/core/db/unscoped';
import { createInMemoryObjectStore, streamToBytes } from '@agent-workspace/core/storage';
import { encodeUstar, RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { describe, expect, it } from 'vitest';

import { createRuntimeWorkspaceLifecycle } from '../compose/workspace-lifecycle';
import { createStorageService } from '../storage/service';
import { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './memory-store';
import {
  context,
  newRun,
  PRINCIPAL,
  quietLog,
  RUN,
  RUN_DONE,
  runtimeOf,
  settle,
  silenceErrorLog,
  sse,
  urlOf,
  USER,
} from './launcher.test-support';

const OUTPUTS = 'workspace-1/session-1/outputs';
const CWD = '/workspace/workspace-1/session-1';
const RUN_URL = 'http://runtime:8080/run';
const NOT_SAVED = 'Run output could not be saved.';

function outputsArchive(): Uint8Array {
  return encodeUstar([
    { path: OUTPUTS, type: 'directory', mode: 0o755 },
    { path: `${OUTPUTS}/report.md`, type: 'file', mode: 0o644, data: Buffer.from('# report') },
  ]);
}

interface OutputsScenario {
  readonly writeFiles?: boolean;
  readonly cwd?: string;
  readonly driver?: 'docker' | 'local';
  readonly workspaceRoot?: string;
  readonly runFrame?: string;
  readonly files?: () => Response;
  readonly maxOutputArchiveBytes?: number;
  readonly persistPaths?: readonly string[];
  readonly persisted?: () => Response;
  /** Replaces durable promotion, so a large archive is not copied into the in-memory store. */
  readonly promoteOutputs?: (archive: Uint8Array) => Promise<void>;
}

/** An in-memory storage service and the workspace lifecycle that promotes into it. */
function inMemoryStorage(workspaceId: string) {
  const catalog = createInMemoryCatalog().forWorkspace(workspaceId);
  const storage = createStorageService({
    catalog: () => Promise.resolve(catalog),
    objects: createInMemoryObjectStore(),
    log: quietLog,
  });
  const lifecycle = createRuntimeWorkspaceLifecycle({
    storage,
    granted: () => Promise.resolve({ files: [], skills: [] }),
    resources: { load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }) },
  });
  return { catalog, storage, lifecycle };
}

/** What the fake runtime answers for each URL the launcher requests. */
function runtimeAnswer(scenario: OutputsScenario, url: string): Response {
  if (url.endsWith('/run')) return sse(scenario.runFrame ?? RUN_DONE);
  if (scenario.persisted !== undefined && !url.includes(encodeURIComponent(OUTPUTS))) {
    return scenario.persisted();
  }
  return scenario.files?.() ?? new Response(Uint8Array.from(outputsArchive()));
}

function outputsRuntime(scenario: OutputsScenario) {
  const local = scenario.driver === 'local';
  return runtimeOf({
    runtimeProfileId: 'profile',
    driver: scenario.driver ?? 'docker',
    workspaceRoot: scenario.workspaceRoot ?? '/workspace',
    fileTransfer: local ? 'local-disk' : 'push-archive',
    ...(scenario.persistPaths === undefined ? {} : { persistPaths: scenario.persistPaths }),
  });
}

async function launchOutputs(scenario: OutputsScenario) {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const { catalog, storage, lifecycle } = inMemoryStorage(run.workspaceId);
  const promote = scenario.promoteOutputs;
  const urls: string[] = [];
  const launch = createRunnerLauncher({
    store,
    runtime: outputsRuntime(scenario),
    buildRunRequest: () => ({
      runId: RUN,
      cwd: scenario.cwd ?? CWD,
      portable: { permissions: { writeFiles: scenario.writeFiles ?? true } },
    }),
    ...(scenario.maxOutputArchiveBytes === undefined
      ? {}
      : { maxOutputArchiveBytes: scenario.maxOutputArchiveBytes }),
    workspaceLifecycle:
      promote === undefined
        ? lifecycle
        : { ...lifecycle, promoteOutputs: (_context, _runtime, archive) => promote(archive) },
    fetch: (request) => {
      const url = urlOf(request);
      urls.push(url);
      return Promise.resolve(runtimeAnswer(scenario, url));
    },
  });
  launch(context(run));
  const settled = await settle(store);
  const caller = { workspaceId: run.workspaceId, principalId: PRINCIPAL, userId: USER };
  const keys = (await listCatalogFiles(catalog))
    .filter((row) => row.kind === 'file')
    .map((row) => row.path);
  /** The saved text at `path`, or null when the catalog holds no such file. */
  const read = async (path: string): Promise<string | null> => {
    const row = await storage.get(caller, 'files', path);
    const opened = row === null ? null : await storage.open(caller, row);
    return opened === null ? null : new TextDecoder().decode(await streamToBytes(opened.body));
  };
  return { settled, urls, keys, read };
}

/** A temp workspace root for a local-disk target, removed afterwards. */
async function withLocalRoot(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'aw-local-outputs-'));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const localScenario = (root: string): OutputsScenario => ({
  driver: 'local',
  workspaceRoot: root,
  cwd: `${root}/workspace-1/session-1`,
});

async function writeLocalReport(root: string, text: string) {
  await mkdir(join(root, OUTPUTS), { recursive: true });
  await writeFile(join(root, OUTPUTS, 'report.md'), text);
}

async function promotesFilesUnderOutputs() {
  const { settled, urls, read } = await launchOutputs({});
  expect(settled.status).toBe('completed');
  expect(urls).toEqual([RUN_URL, `http://runtime:8080/files?path=${encodeURIComponent(OUTPUTS)}`]);
  expect(await read(`runs/${RUN}/outputs/report.md`)).toBe('# report');
}

async function collectsNothingFromAFailedRun() {
  const { settled, urls, keys } = await launchOutputs({
    runFrame: 'event: run-error\ndata: {"message":"sdk failed"}\n\n',
  });
  expect(settled.status).toBe('failed');
  expect(urls).toEqual([RUN_URL]);
  expect(keys).toEqual([]);
}

async function doesNotCollectWithoutWriteFiles() {
  const { settled, urls, keys } = await launchOutputs({ writeFiles: false });
  expect(settled.status).toBe('completed');
  expect(urls).toEqual([RUN_URL]);
  expect(keys).toEqual([]);
}

// Issue #1576: a local runner writes on this host, so its outputs/ is read from disk directly.
function promotesALocalTargetFromDisk() {
  return withLocalRoot(async (root) => {
    await writeLocalReport(root, '# local report');
    const { settled, urls, read } = await launchOutputs(localScenario(root));
    expect(settled.status).toBe('completed');
    expect(urls).toEqual([RUN_URL]);
    expect(await read(`runs/${RUN}/outputs/report.md`)).toBe('# local report');
  });
}

function leavesALocalRunCompletedWithoutOutputs() {
  return withLocalRoot(async (root) => {
    const { settled, urls, keys } = await launchOutputs(localScenario(root));
    expect(settled.status).toBe('completed');
    expect(urls).toEqual([RUN_URL]);
    expect(keys).toEqual([]);
  });
}

function failsALocalRunOverTheSizeCap() {
  const log = silenceErrorLog();
  return withLocalRoot(async (root) => {
    await writeLocalReport(root, 'x'.repeat(64));
    const { settled, keys } = await launchOutputs({
      ...localScenario(root),
      maxOutputArchiveBytes: 16,
    });
    expect(settled.status).toBe('failed');
    expect(settled.error).toBe(NOT_SAVED);
    expect(keys).toEqual([]);
  }).finally(() => log.mockRestore());
}

async function leavesTheRunCompletedWhenNoOutputsWereWritten() {
  const { settled, keys } = await launchOutputs({
    files: () =>
      Response.json({ error: 'file_not_found', message: 'no such file' }, { status: 404 }),
  });
  expect(settled.status).toBe('completed');
  expect(keys).toEqual([]);
}

async function expectPublicFailure(scenario: OutputsScenario) {
  const log = silenceErrorLog();
  const { settled, keys } = await launchOutputs(scenario);
  expect(settled.status).toBe('failed');
  expect(settled.error).toBe(NOT_SAVED);
  expect(keys).toEqual([]);
  log.mockRestore();
}

const failsPubliclyForAnyOtherFailure = () =>
  expectPublicFailure({ files: () => Response.json({ error: 'internal_error' }, { status: 500 }) });

const failsPubliclyForA404ThatIsNotFileNotFound = () =>
  expectPublicFailure({ files: () => Response.json({ error: 'not_found' }, { status: 404 }) });

const failsPubliclyOverTheSizeCap = () => expectPublicFailure({ maxOutputArchiveBytes: 16 });

/** A tar header that declares a `size`-byte file, with a valid checksum. */
function tarHeaderFor(size: number): Buffer {
  const header = Buffer.from(
    encodeUstar([{ path: `${OUTPUTS}/big.bin`, type: 'file', mode: 0o644 }]).subarray(0, 512),
  );
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

/** A response streaming the header, `size` bytes of body, and a 1 KiB tar trailer. */
function largeArchiveResponse(size: number): Response {
  const header = tarHeaderFor(size);
  const chunk = new Uint8Array(1024 * 1024);
  const chunks = size / chunk.byteLength;
  let sent = -1;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === -1) controller.enqueue(header);
        else if (sent < chunks) controller.enqueue(chunk);
        else {
          controller.enqueue(new Uint8Array(1024));
          controller.close();
        }
        sent += 1;
      },
    }),
  );
}

// #1991 D2: the default cap counts wire bytes, so tar framing never refuses a full payload.
async function completesAnOutputAtThePayloadLimit() {
  const size = RUN_FILES_MAX_BYTES;
  let promoted = 0;
  const { settled } = await launchOutputs({
    files: () => largeArchiveResponse(size),
    promoteOutputs: (archive) => {
      promoted = archive.byteLength;
      return Promise.resolve();
    },
  });
  expect(settled.status).toBe('completed');
  expect(promoted).toBe(size + 512 + 1024);
}

// FX-4: a chunked archive has no Content-Length, so the cap must count the bytes as they arrive.
async function cancelsAChunkedArchivePastTheCap() {
  const log = silenceErrorLog();
  let pulls = 0;
  let cancelled = false;
  const { settled, keys } = await launchOutputs({
    maxOutputArchiveBytes: 16,
    files: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls > 100) controller.close();
            else controller.enqueue(new Uint8Array(8));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  expect(settled.status).toBe('failed');
  expect(settled.error).toBe(NOT_SAVED);
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThan(10);
  expect(keys).toEqual([]);
  log.mockRestore();
}

// FX-4: persistPaths and outputs/ are collected independently.
async function stillPromotesOutputsWhenAPersistPathFails() {
  const log = silenceErrorLog();
  const { settled, read } = await launchOutputs({
    persistPaths: ['missing'],
    persisted: () => Response.json({ error: 'internal_error' }, { status: 500 }),
  });
  expect(settled.status).toBe('failed');
  expect(settled.error).toBe(NOT_SAVED);
  expect(await read(`runs/${RUN}/outputs/report.md`)).toBe('# report');
  log.mockRestore();
}

async function failsSafelyOutsideTheWorkspaceRoot() {
  const log = silenceErrorLog();
  const { settled, urls } = await launchOutputs({ cwd: '/elsewhere/session-1' });
  expect(settled.status).toBe('failed');
  expect(settled.error).toBe(NOT_SAVED);
  expect(urls).toEqual([RUN_URL]);
  log.mockRestore();
}

describe('createRunnerLauncher collects outputs/ (issue #1274)', () => {
  it(
    'promotes the files under outputs/ to runs/<runId>/outputs/ without a profile setting',
    promotesFilesUnderOutputs,
  );
  it('collects nothing from a failed run', collectsNothingFromAFailedRun);
  it('does not collect for an agent without writeFiles', doesNotCollectWithoutWriteFiles);
  it(
    'promotes a local target outputs/ from the run cwd on disk, without a /files call',
    promotesALocalTargetFromDisk,
  );
  it(
    'leaves a local run completed when the agent wrote no outputs/',
    leavesALocalRunCompletedWithoutOutputs,
  );
  it(
    'fails a local run with the public message when outputs/ exceeds the size cap',
    failsALocalRunOverTheSizeCap,
  );
  it(
    'leaves the run completed when the agent wrote no outputs/',
    leavesTheRunCompletedWhenNoOutputsWereWritten,
  );
  it(
    'fails with the public message for any other collection failure',
    failsPubliclyForAnyOtherFailure,
  );
  it(
    'fails with the public message for a 404 that is not file_not_found',
    failsPubliclyForA404ThatIsNotFileNotFound,
  );
  it(
    'fails with the public message when the archive exceeds the size cap',
    failsPubliclyOverTheSizeCap,
  );
  it(
    'completes a run whose output is exactly the payload limit plus its tar framing',
    completesAnOutputAtThePayloadLimit,
  );
  it(
    'cancels a chunked archive once it passes the size cap, without buffering the rest',
    cancelsAChunkedArchivePastTheCap,
  );
  it(
    'still promotes outputs/ when a persistPaths entry fails, and reports the failure',
    stillPromotesOutputsWhenAPersistPathFails,
  );
  it(
    'fails safely, without collecting, when the run directory is outside the workspace root',
    failsSafelyOutsideTheWorkspaceRoot,
  );
});
