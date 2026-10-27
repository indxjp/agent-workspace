/**
 * US-STO-12 write-back, end to end in-process: an agent granted `storage://acme-data/reports/`
 * is started through the real `POST /api/agents/:id/runs` handler, the runner double hands back the
 * folder as the run left it, and the real launcher saves a completed run's new and changed files to
 * the connection (the storage design, §05). The connection is a real `file://` folder and a real S3
 * bucket (`TEST_S3_ENDPOINT`, supplied by the repository test launcher). Every connection is looked
 * up by id, so a rename, a delete or a recreate during the run goes through the same resolution as
 * production. The unit matrix lives in `../compose/storage-writeback.test.ts`.
 */
// @story US-STO-12
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { loadEgressPolicyFromEnv } from '@agent-workspace/core';
import {
  createInMemoryObjectStore,
  openConnectionStore,
  streamToBytes,
  type ObjectStoreV2,
} from '@agent-workspace/core/storage';
import { encodeUstar, type TarEntry } from '@agent-workspace/runtime/transfer';
import { formatStorageUrl } from '@indx-workspace/contracts/storage-url';
import { afterEach, describe, expect, it } from 'vitest';

import { clearApplicationContext } from '../application-context';
import {
  createAgentRunResourceLoader,
  type RunStorageConnections,
  type RunWritableConnectionStore,
} from '../compose/resource-loader';
import { createRunPreflight } from '../compose/run-preflight';
import { writeBackStorage, type StorageWriteBackAuditEvent } from '../compose/storage-writeback';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { startRun } from './api';
import type { RunPrincipal } from './environment';
import { InMemoryRunStore } from './memory-store';
import {
  isTerminalRunStatus,
  SessionBusyError,
  type CreateRunInput,
  type RunRecord,
} from './store';
import { installDeliveringRunApi, runnableAgent, startPreflight } from './run-delivery-fixtures';
import { createStorageService } from '../storage/service';

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const CSV = 'quarter,total\nq3,42\n';
const localEgress = { production: false, allowHosts: [] } as const;
const BLOCK = 512;

interface Backend {
  readonly open: (writable: boolean) => Promise<ObjectStoreV2>;
  readonly teardown: () => Promise<void>;
}

async function fileBackend(): Promise<Backend> {
  const root = await mkdtemp(join(tmpdir(), 'aw-sto12-wb-'));
  return {
    open: (writable) =>
      openConnectionStore(
        `file://${root}`,
        { provider: 'file' },
        {
          writable,
          fileRoots: [root],
          egress: loadEgressPolicyFromEnv(),
        },
      ),
    teardown: () => rm(root, { recursive: true, force: true }),
  };
}

async function s3Backend(): Promise<Backend> {
  const endpoint = process.env['TEST_S3_ENDPOINT'];
  if (endpoint === undefined || endpoint.trim() === '') {
    throw new Error('TEST_S3_ENDPOINT is required (the repository test launcher supplies it)');
  }
  const accessKeyId = process.env['TEST_S3_ACCESS_KEY_ID'] ?? 'agent_workspace';
  const secretAccessKey = process.env['TEST_S3_SECRET_ACCESS_KEY'] ?? 'agent_workspace';
  const region = process.env['TEST_S3_REGION'] ?? 'us-east-1';
  const bucket = `aw-writeback-${randomBytes(6).toString('hex')}`;
  await new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  }).send(new CreateBucketCommand({ Bucket: bucket }));
  const url = formatStorageUrl({
    kind: 's3',
    bucket,
    prefix: '',
    endpoint,
    region,
    forcePathStyle: true,
  });
  return {
    open: (writable) =>
      openConnectionStore(
        url,
        { provider: 's3', accessKeyId, secretAccessKey },
        {
          writable,
          fileRoots: [],
          egress: localEgress,
        },
      ),
    teardown: () => Promise.resolve(),
  };
}

const text = async (store: ObjectStoreV2, key: string): Promise<string | null> => {
  const object = await store.read(key);
  return object === null ? null : Buffer.from(await streamToBytes(object.body)).toString('utf8');
};

/** `entries` with the last member's header rewritten the way a hostile runtime could write it. */
function forged(
  entries: readonly TarEntry[],
  edit: { readonly type?: number; readonly name?: string },
): Uint8Array {
  const tar = Buffer.from(encodeUstar(entries));
  const offset = entries
    .slice(0, -1)
    .reduce((sum, entry) => sum + BLOCK + Math.ceil((entry.data?.length ?? 0) / BLOCK) * BLOCK, 0);
  const header = tar.subarray(offset, offset + BLOCK);
  if (edit.type !== undefined) header[156] = edit.type;
  if (edit.name !== undefined) {
    header.fill(0, 0, 100);
    header.fill(0, 345, 500);
    header.write(edit.name, 0);
  }
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return tar;
}

const filesIn = (folder: string, files: Readonly<Record<string, string>>): TarEntry[] =>
  Object.entries(files).map(([name, content]) => ({
    path: `${folder}/${name}`,
    type: 'file' as const,
    mode: 0o644,
    data: Buffer.from(content),
  }));

interface ConnectionRow {
  name: string;
  readonly allowedPrefixes: readonly string[];
  writeAllowed: boolean;
}

/** What a test may change while the run is in flight: the connections and the run's gates. */
interface World {
  readonly rows: Map<string, ConnectionRow>;
  readonly backends: Map<string, Backend>;
  readonly makeBackend: () => Promise<Backend>;
  agentWrites: boolean;
  grantAccess: 'read' | 'read-write';
}

/**
 * The in-memory store with the PostgreSQL store's session-busy rule: a session with a run that is
 * not terminal refuses the next one.
 */
class SessionBusyRunStore extends InMemoryRunStore {
  readonly #ids: string[] = [];

  override async create(input: CreateRunInput): Promise<RunRecord> {
    for (const id of this.#ids) {
      const held = await this.get(id);
      if (held?.sessionId === input.sessionId && !isTerminalRunStatus(held.status)) {
        throw new SessionBusyError(input.sessionId);
      }
    }
    const created = await super.create(input);
    this.#ids.push(created.id);
    return created;
  }
}

const backends: Backend[] = [];

afterEach(async () => {
  clearApplicationContext();
  await Promise.all(backends.splice(0).map((backend) => backend.teardown()));
});

describe.each([
  ['file://', fileBackend],
  ['S3', s3Backend],
] as const)('a completed run granted a %s connection folder', (_name, makeBackend) => {
  /**
   * Seeds `reports/2026/q3.csv` and `q2.csv`, runs an agent that leaves `after` (or the archive
   * `tar` builds), lets `duringRun` change the world once the run is composed, and answers the
   * connection's bucket, the uploads it was asked for and the audit rows.
   */
  async function run(options: {
    readonly access?: 'read' | 'read-write';
    readonly after?: Readonly<Record<string, string>>;
    readonly tar?: (folder: string) => Uint8Array;
    readonly duringRun?: (world: World) => Promise<void>;
    /** Runs once the write-back has started; `post` sends the session a second message. */
    readonly duringWriteBack?: (post: () => Promise<Response>) => Promise<void>;
  }) {
    const connectionId = randomUUID();
    const backend = await makeBackend();
    backends.push(backend);
    const bucket = await backend.open(true);
    await bucket.write('reports/2026/q3.csv', new Blob([CSV]).stream(), {});
    await bucket.write('reports/2026/q2.csv', new Blob(['q2,40\n']).stream(), {});
    const state: World = {
      rows: new Map([
        [connectionId, { name: 'acme-data', allowedPrefixes: ['reports'], writeAllowed: true }],
      ]),
      backends: new Map([[connectionId, backend]]),
      makeBackend: async () => {
        const made = await makeBackend();
        backends.push(made);
        return made;
      },
      agentWrites: true,
      grantAccess: options.access ?? 'read-write',
    };
    const uploads: string[] = [];
    const audits: StorageWriteBackAuditEvent[] = [];
    const world = {
      catalogs: createInMemoryCatalogStore(),
      workspaceId: randomUUID(),
      principalId: randomUUID(),
      userId: randomUUID(),
    };
    const storage = createStorageService({
      catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
      objects: createInMemoryObjectStore(),
      log: noLog,
    });
    const backendOf = (id: string) => {
      const found = state.backends.get(id);
      if (found === undefined) throw new Error('no such connection');
      return found;
    };
    const connections: RunStorageConnections = {
      get: (_workspaceId, id) => {
        const row = state.rows.get(id);
        return Promise.resolve(row === undefined ? null : { ...row });
      },
      open: (_workspaceId, id) => backendOf(id).open(false),
      openWritable: async (_workspaceId, id): Promise<RunWritableConnectionStore> => {
        const store = await backendOf(id).open(true);
        return {
          read: (key) => store.read(key),
          write: (key, body, writeOptions) => {
            uploads.push(key);
            return store.write(key, body, writeOptions);
          },
        };
      },
    };
    const bearer = randomUUID();
    const principal: RunPrincipal = {
      principalId: world.principalId,
      ownerPrincipalId: world.principalId,
      userId: world.userId,
      workspaceId: world.workspaceId,
      role: 'owner',
      scope: null,
    };
    const storageGrants = [{ connectionId, prefix: 'reports', access: state.grantAccess }];
    const { agents, profiles, models, discover, agent } = await runnableAgent(
      world.workspaceId,
      principal,
    );
    // The run's agent and grants as they are when read: a test may close a gate during the run.
    const readRunAgent = () =>
      Promise.resolve({
        agent: { ...agent, permissions: { ...agent.permissions, writeFiles: state.agentWrites } },
        assignments: {
          files: [],
          skillIds: [],
          connectorIds: [],
          storageGrants: [{ connectionId, prefix: 'reports', access: state.grantAccess }],
        },
        toolBundles: [],
        subagents: [],
      });
    const preflight = createRunPreflight({
      agents,
      profiles,
      models: { models, discover },
      workspaceDefault: () => Promise.resolve(null),
      projectDefault: () => Promise.resolve(null),
      projectDefaults: () => Promise.resolve(new Map()),
      deploymentDefaultModels: {},
      policyCeiling: null,
      runFiles: {
        loader: createAgentRunResourceLoader({
          catalog: world.catalogs,
          storage,
          storageConnections: connections,
          sizesOnly: true,
        }),
        readRunAgent,
        projectOf: () => Promise.resolve(null),
      },
    });
    const sessionId = randomUUID();
    const cwd = `${world.workspaceId}/${sessionId}`;
    const folder = `${cwd}/storage/acme-data/reports`;
    const post = () =>
      startRun(
        new Request(`http://web.test/api/agents/${runs.agentId}/runs`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'summarise' }),
        }),
        runs.agentId,
      );
    const runs = installDeliveringRunApi({
      world,
      storage,
      store: new SessionBusyRunStore(),
      authenticate: (request) =>
        Promise.resolve(
          request.headers.get('authorization') === `Bearer ${bearer}` ? principal : null,
        ),
      storageGrants,
      storageConnections: connections,
      agentId: agent.id,
      sessionId,
      preflight: startPreflight(preflight),
      runnerFiles: (path) =>
        path === folder
          ? (options.tar?.(folder) ?? encodeUstar(filesIn(folder, options.after ?? {})))
          : null,
      onRun: () => options.duringRun?.(state) ?? Promise.resolve(),
      storageWriteback: async (writeBack) => {
        await options.duringWriteBack?.(post);
        return writeBackStorage(writeBack, {
          readRunAgent,
          connections,
          audit: (event) => {
            audits.push(event);
            return Promise.resolve();
          },
        });
      },
    });
    const response = await post();
    expect(response.status, await response.clone().text()).toBe(202);
    const { run: started } = (await response.json()) as { run: { id: string } };
    await runs.delivered(started.id);
    return {
      text: (key: string) => text(bucket, key),
      uploads,
      labels: audits.map((event) => event.subjectLabel),
      state,
    };
  }

  it('[US-STO-12][api][run] a write grant saves a file the agent created', async () => {
    const saved = await run({ after: { '2026/q3.csv': CSV, 'summary.md': '# Q3\n' } });
    expect(await saved.text('reports/summary.md')).toBe('# Q3\n');
  });

  it('[US-STO-12][api][run] a write grant replaces a changed file and deletes nothing', async () => {
    const saved = await run({ after: { '2026/q3.csv': 'q3,43\n' } });
    expect(await saved.text('reports/2026/q3.csv')).toBe('q3,43\n');
    expect(await saved.text('reports/2026/q2.csv')).toBe('q2,40\n');
  });

  it('[US-STO-12][api][run] uploads only the files that changed, never the unchanged ones', async () => {
    const saved = await run({
      after: { '2026/q3.csv': CSV, '2026/q2.csv': 'q2,41\n', 'summary.md': '# Q3\n' },
    });
    expect(saved.uploads.sort()).toEqual(['reports/2026/q2.csv', 'reports/summary.md']);
    expect(saved.labels).toEqual([
      expect.stringMatching(/ · 2 written · 1 unchanged · 0 conflicted · 0 refused · 0 failed · /u),
    ]);
  });

  it('[US-STO-12][api][run] saves the run even when a second message arrives during the write-back', async () => {
    const answers: number[] = [];
    const saved = await run({
      after: { '2026/q3.csv': 'q3,43\n', 'a.md': '# A\n' },
      duringWriteBack: async (post) => {
        // The run is still `running`, so its session refuses the next run until the save ends.
        answers.push((await post()).status);
      },
    });

    expect(answers).toEqual([409]);
    expect(await saved.text('reports/a.md')).toBe('# A\n');
    expect(await saved.text('reports/2026/q3.csv')).toBe('q3,43\n');
  });

  it('[US-STO-12][api][run] a read grant never writes', async () => {
    const saved = await run({
      access: 'read',
      after: { '2026/q3.csv': 'tampered\n', 'summary.md': '# Q3\n' },
    });
    expect(await saved.text('reports/2026/q3.csv')).toBe(CSV);
    expect(await saved.text('reports/summary.md')).toBeNull();
    expect(saved.uploads).toEqual([]);
  });

  const gates: readonly [string, (world: World) => void, string][] = [
    [
      'the connection stops allowing writes',
      (world) => {
        for (const row of world.rows.values()) row.writeAllowed = false;
      },
      'write_not_allowed',
    ],
    [
      'the grant becomes read only',
      (world) => {
        world.grantAccess = 'read';
      },
      'grant_missing',
    ],
    [
      'the agent may no longer write files',
      (world) => {
        world.agentWrites = false;
      },
      'agent_cannot_write',
    ],
  ];

  it.each(gates)(
    '[US-STO-12][api][run] writes nothing when %s during the run',
    async (_gate, close, reason) => {
      const saved = await run({
        after: { '2026/q3.csv': 'q3,43\n', 'summary.md': '# Q3\n' },
        duringRun: (world) => {
          close(world);
          return Promise.resolve();
        },
      });
      expect(saved.uploads).toEqual([]);
      expect(await saved.text('reports/2026/q3.csv')).toBe(CSV);
      expect(await saved.text('reports/summary.md')).toBeNull();
      expect(saved.labels).toEqual([expect.stringContaining(`refused: ${reason}`)]);
    },
  );

  const escapes: readonly [string, (folder: string) => Uint8Array][] = [
    [
      'a parent segment',
      (folder) =>
        forged(filesIn(folder, { 'ok.md': 'ok', 'x.md': 'x' }), { name: `${folder}/../x.md` }),
    ],
    [
      "another folder's member",
      (folder) =>
        encodeUstar([
          ...filesIn(folder, { 'ok.md': 'ok' }),
          ...filesIn(folder.replace(/reports$/u, 'archive'), { 'x.md': 'x' }),
        ]),
    ],
    [
      'a link member',
      (folder) => forged(filesIn(folder, { 'ok.md': 'ok', 'x.md': 'x' }), { type: 0x32 }),
    ],
  ];

  it.each(escapes)(
    '[US-STO-12][api][run] never writes %s that reaches outside the folder',
    async (_name, tar) => {
      const saved = await run({ tar });
      expect(saved.uploads.filter((key) => key !== 'reports/ok.md')).toEqual([]);
      expect(await saved.text('reports/x.md')).toBeNull();
      expect(await saved.text('x.md')).toBeNull();
      expect(await saved.text('archive/x.md')).toBeNull();
      expect(saved.labels).toEqual([expect.stringMatching(/ · [1-9]\d* refused · /u)]);
    },
  );

  it('[US-STO-12][api][run] keeps a file changed in the bucket during the run, as conflicted', async () => {
    const saved = await run({
      after: { '2026/q3.csv': 'q3,43\n' },
      duringRun: async (world) => {
        const [backend] = world.backends.values();
        const store = await backend?.open(true);
        await store?.write('reports/2026/q3.csv', new Blob(['edited elsewhere\n']).stream(), {});
      },
    });
    expect(await saved.text('reports/2026/q3.csv')).toBe('edited elsewhere\n');
    expect(saved.labels).toEqual([expect.stringContaining(' · 1 conflicted · ')]);
  });

  it('[US-STO-12][api][run] still writes to a connection renamed during the run', async () => {
    const saved = await run({
      after: { 'summary.md': '# Q3\n' },
      duringRun: (world) => {
        for (const row of world.rows.values()) row.name = 'acme-renamed';
        return Promise.resolve();
      },
    });
    expect(await saved.text('reports/summary.md')).toBe('# Q3\n');
  });

  it('[US-STO-12][api][run] a connection deleted and recreated under the same name receives nothing', async () => {
    const recreated: { store?: ObjectStoreV2 } = {};
    const saved = await run({
      after: { 'summary.md': '# Q3\n' },
      duringRun: async (world) => {
        const row = [...world.rows.values()][0];
        world.rows.clear();
        const id = randomUUID();
        const backend = await world.makeBackend();
        world.rows.set(id, { name: 'acme-data', allowedPrefixes: ['reports'], writeAllowed: true });
        world.backends.set(id, backend);
        recreated.store = await backend.open(true);
        expect(row?.name).toBe('acme-data');
      },
    });
    expect(saved.uploads).toEqual([]);
    expect(await saved.text('reports/summary.md')).toBeNull();
    expect(recreated.store).toBeDefined();
    expect(
      recreated.store === undefined ? 'missing' : await text(recreated.store, 'reports/summary.md'),
    ).toBeNull();
    expect(saved.labels).toEqual([expect.stringContaining('refused: connection_missing')]);
  });
});
