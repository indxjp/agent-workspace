import { rm } from 'node:fs/promises';
import path from 'node:path';

import { TransportError } from '@indx-workspace/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROJECT_API_VERSION,
  PROJECT_KIND,
  type ProjectDocument,
} from '@indx-workspace/contracts/project-file';

import type { CliIo } from '../io.js';
import type { PushReport } from '../project/index.js';
import { tempDirectory, tempFile } from '../testing.js';
import { createDevSyncClient, DEV_SYNC_TIMEOUT_MS, startDevSync, type DevSync } from './sync.js';

/**
 * Issue #453 (S1-15): how the sync loop classifies failures a real project cannot be made to
 * produce on every platform — an unreadable directory (`icacls` on Windows, `chmod` elsewhere,
 * neither honoured for every user) — and the deadline its client puts on a silent runtime.
 * `pushProject` is replaced so each case decides what one sync throws.
 */

type Answer = (root: string) => Promise<PushReport>;

/** The project file the sync plans tools against: no `connectors`, so every tool name is free. */
const PROJECT_DOCUMENT: ProjectDocument = {
  apiVersion: PROJECT_API_VERSION,
  kind: PROJECT_KIND,
  name: 'demo',
  environments: { local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } } },
};
/** The local workspace's API key `aw dev` holds (ADR-0109, S1-21), shaped as `API_KEY_PATTERN`. */
const API_KEY = `ak_live_${'A'.repeat(22)}_${'S'.repeat(43)}`;

/** What the next syncs answer, in order; once empty, a sync pushes nothing and succeeds. */
const pushes = vi.hoisted(() => ({ next: [] as Answer[], count: 0 }));

vi.mock('../project/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../project/index.js')>();
  return {
    ...actual,
    pushProject: (options: { readonly root: string }): Promise<PushReport> => {
      pushes.count += 1;
      const answer = pushes.next.shift();
      return answer === undefined
        ? Promise.resolve({
            saved: true,
            problems: [],
            agents: [],
            skills: { skills: [], workspaceOnly: [] },
            tools: [],
            bundles: [],
            secrets: [],
          })
        : answer(options.root);
    },
  };
});

const ORIGIN = 'http://127.0.0.1:3000';
const DEBOUNCE_MS = 50;

function noRequest(): Promise<Response> {
  return Promise.reject(new Error('no request is expected'));
}
const DEADLINE_MS = 5000;

/** What Node throws when `readdir` is refused: a system error carrying code, syscall and path. */
function systemError(code: string, syscall: string, at: string): Error {
  return Object.assign(new Error(`${code}: operation not permitted, ${syscall} '${at}'`), {
    errno: -1,
    code,
    syscall,
    path: at,
  });
}

interface Running {
  readonly root: string;
  readonly sync: DevSync;
  readonly controller: AbortController;
  readonly fatal: Error[];
  readonly stderr: () => string;
}

const running: Running[] = [];

afterEach(async () => {
  pushes.next.length = 0;
  pushes.count = 0;
  vi.useRealTimers();
  for (const run of running.splice(0)) {
    run.controller.abort();
    await run.sync.closed;
    await rm(run.root, { recursive: true, force: true });
  }
});

async function start(): Promise<Running> {
  const root = await tempDirectory();
  await tempFile(root, 'agents/assistant.ts', 'export default {};\n');
  let stderr = '';
  const io: CliIo = {
    stdin: () => Promise.resolve(''),
    stdout: () => undefined,
    stderr: (text) => {
      stderr += text;
    },
    env: {},
    homeDir: root,
    fetch: noRequest,
    isTty: false,
  };
  const controller = new AbortController();
  const fatal: Error[] = [];
  const sync = startDevSync({
    // pushProject is replaced, so the client sends nothing.
    client: createDevSyncClient({ baseUrl: ORIGIN, apiKey: API_KEY, fetch: noRequest }),
    root,
    io,
    signal: controller.signal,
    origin: ORIGIN,
    debounceMs: DEBOUNCE_MS,
    forkWithheld: [],
    project: PROJECT_DOCUMENT,
    onFatal: (error) => {
      fatal.push(error);
    },
  });
  const run: Running = {
    root,
    sync,
    controller,
    fatal,
    stderr: () => stderr,
  };
  running.push(run);
  return run;
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('startDevSync failures (issue #453)', () => {
  it('says an unreadable project directory and keeps watching', async () => {
    pushes.next.push((root) =>
      Promise.reject(systemError('EPERM', 'scandir', path.join(root, 'surfaces'))),
    );
    const run = await start();
    await until(() => run.stderr().includes('sync: EPERM'));
    expect(run.fatal).toEqual([]);

    await tempFile(run.root, 'agents/assistant.ts', 'export default { saved: true };\n');
    await until(() => pushes.count === 2);
    expect(run.fatal).toEqual([]);
    expect(run.stderr()).toBe(
      `sync: EPERM: operation not permitted, scandir '${path.join(run.root, 'surfaces')}'\n`,
    );
  });

  it('stops on a filesystem error outside the project', async () => {
    pushes.next.push((root) =>
      Promise.reject(systemError('EACCES', 'open', path.join(path.dirname(root), 'elsewhere'))),
    );
    const run = await start();
    await until(() => run.fatal.length === 1);
    expect(run.fatal[0]?.message).toContain('EACCES');
    expect(run.stderr()).toBe('');
  });
});

describe('createDevSyncClient (issue #453)', () => {
  it('sends the local runtime API key as the bearer credential (ADR-0109, S1-21)', async () => {
    const seen: (string | null)[] = [];
    const client = createDevSyncClient({
      baseUrl: 'http://127.0.0.1:3000',
      apiKey: API_KEY,
      fetch: (input, init) => {
        seen.push(new Request(input, init).headers.get('authorization'));
        return Promise.reject(new Error('no runtime in this test'));
      },
    });
    const settled = await client.agents.list().then(
      () => null,
      (error: unknown) => error,
    );
    expect(settled).toBeInstanceOf(TransportError);
    expect(seen).toEqual([`Bearer ${API_KEY}`]);
    expect(settled instanceof Error ? settled.message : '').not.toContain('ak_live_');
  });

  it('fails a request the runtime never answers at the deadline, as a TransportError', async () => {
    vi.useFakeTimers();
    const client = createDevSyncClient({
      baseUrl: 'http://127.0.0.1:3000',
      apiKey: API_KEY,
      // Accepts the request and never answers, until the request's signal aborts.
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(
              init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'),
            );
          });
        }),
    });
    const listed = client.agents.list();
    const settled = listed.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(DEV_SYNC_TIMEOUT_MS);
    expect(await settled).toBeInstanceOf(TransportError);
  });
});
