/**
 * A PATCH that narrows a storage connection is enforced on the next run, for delivery and for the
 * write-back (#1835 STO-506). The PATCH leaves agent-version grants in place by design: no grant is
 * rewritten and no version is flagged. What a run delivers and writes is judged against the
 * connection as it is when the run reads it — `allowedPrefixes` and `writeAllowed` are read again
 * by the resource loader at launch and by the write-back at the end — so a narrowed connection can
 * never be widened by a grant made before the PATCH.
 *
 * The connection is created and patched through the real routes over the in-memory repository and
 * secret store, and read through the production run seam (`createRunStorageConnections`), so the
 * PATCH and the run see the same rows. The folder is a real `file://` connection.
 */
// @story US-STO-12
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createInMemoryStorageConnectionRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import { encodeUstar } from '@agent-workspace/runtime/transfer';
import { StorageConnectionResourceSchema } from '@indx-workspace/contracts/storage-connections';
import { formatStorageUrl } from '@indx-workspace/contracts/storage-url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PATCH as patchRoute } from '../../app/api/storage-connections/[id]/route';
import { POST as createRoute } from '../../app/api/storage-connections/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import {
  createAgentRunResourceLoader,
  type AgentRunResourceSelection,
} from '../compose/resource-loader';
import { writeBackStorage, type StorageWriteBackAuditEvent } from '../compose/storage-writeback';
import { createRunStorageConnections } from '../composition/wiring/run-resources';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import type { LaunchContext } from '../runs/environment';
import { createRepositoryStorageConnectionsStoreProvider } from './store';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = '44444444-4444-4444-8444-444444444444';
const CWD = `${WORKSPACE}/${SESSION}`;
const FOLDER = 'storage/acme-data/reports';
const CSV = 'quarter,total\nq3,42\n';
const PERMISSIONS = {
  readFiles: true,
  writeFiles: true,
  runCommands: false,
  unrestrictedNetwork: false,
};

const fileRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'aw-sto506-narrowing-')));
afterAll(() => rmSync(fileRoot, { recursive: true, force: true }));

/** The URL of a folder on this host, as the product writes one on every platform. */
const folderUrl = (dir: string): string =>
  formatStorageUrl({ kind: 'file', root: dir.split(path.sep).join('/') });

const scopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'w' }]);
let store = createRepositoryStorageConnectionsStoreProvider({
  repositories: createInMemoryStorageConnectionRepositoryProvider(),
  scopes,
  secrets: createInMemorySecretsService(),
});
let folder = '';

beforeEach(() => {
  store = createRepositoryStorageConnectionsStoreProvider({
    repositories: createInMemoryStorageConnectionRepositoryProvider(),
    scopes,
    secrets: createInMemorySecretsService(),
  });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory(),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: ACTOR,
            apiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            workspaceId: WORKSPACE,
            role: 'admin',
            label: 'Narrowing test',
          }),
        ),
    },
    storageConnections: {
      kind: 'serving',
      runtime: {
        store,
        fileRoots: [fileRoot],
        egress: { production: true, allowHosts: [] },
        // The agent's grant holds the connection, as it would in production.
        isConnectionGranted: () => Promise.resolve(true),
        audit: () => Promise.resolve(),
      },
    },
  });
  folder = mkdtempSync(path.join(fileRoot, 'acme-'));
  mkdirSync(path.join(folder, 'reports'));
  mkdirSync(path.join(folder, 'archive'));
  writeFileSync(path.join(folder, 'reports', 'q3.csv'), CSV);
});

afterEach(() => {
  clearApplicationContext();
});

const json = (method: string, url: string, payload: unknown) =>
  new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

/** `POST /api/storage-connections`: `acme-data` over the folder, both folders allowed, writable. */
async function connect(): Promise<string> {
  const response = await createRoute(
    json('POST', 'http://localhost/api/storage-connections', {
      name: 'acme-data',
      url: folderUrl(folder),
      allowedPrefixes: ['reports', 'archive'],
      writeAllowed: true,
    }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return StorageConnectionResourceSchema.parse(await response.json()).id;
}

/** `PATCH /api/storage-connections/:id`. */
async function narrow(id: string, patch: Record<string, unknown>): Promise<void> {
  const response = await patchRoute(
    json('PATCH', `http://localhost/api/storage-connections/${id}`, patch),
    { params: Promise.resolve({ id }) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

const runConnections = () =>
  createRunStorageConnections({ storage: { store, fileRoots: [fileRoot] }, scopes });

/** What a run launched now is delivered for a `read-write` grant of `reports`, made before any PATCH. */
function deliver(id: string): Promise<AgentRunResourceSelection> {
  return createAgentRunResourceLoader({
    catalog: createInMemoryCatalogStore(),
    storageConnections: runConnections(),
  }).load(
    WORKSPACE,
    {
      files: [],
      skillIds: [],
      connectorIds: [],
      storageGrants: [{ connectionId: id, prefix: 'reports', access: 'read-write' }],
    },
    null,
    PERMISSIONS,
  );
}

/** The write-back of a run delivered `selection` that left `summary.md` in the folder. */
async function writeBack(id: string, selection: AgentRunResourceSelection) {
  const audits: StorageWriteBackAuditEvent[] = [];
  const member = `${CWD}/${FOLDER}/summary.md`;
  await writeBackStorage(
    {
      context: {
        run: { id: crypto.randomUUID() },
        agent: { id: crypto.randomUUID() },
        session: { id: SESSION, agentVersionId: null },
        principal: { workspaceId: WORKSPACE, principalId: ACTOR, userId: null },
      } as unknown as LaunchContext,
      body: {
        portable: { permissions: { writeFiles: true } },
        resources: { files: selection.files },
      },
      cwd: CWD,
      collect: (collected) =>
        Promise.resolve(
          collected === `${CWD}/${FOLDER}`
            ? new Blob([
                Buffer.from(
                  encodeUstar([
                    { path: member, type: 'file', mode: 0o644, data: Buffer.from('# Q3\n') },
                  ]),
                ),
              ]).stream()
            : null,
        ),
      folders: selection.storageFolders ?? new Map(),
      signal: new AbortController().signal,
    },
    {
      readRunAgent: () =>
        Promise.resolve({
          agent: { permissions: PERMISSIONS },
          assignments: {
            files: [],
            skillIds: [],
            connectorIds: [],
            storageGrants: [{ connectionId: id, prefix: 'reports', access: 'read-write' }],
          },
        } as never),
      connections: runConnections(),
      audit: (event) => {
        audits.push(event);
        return Promise.resolve();
      },
      stillRunning: () => Promise.resolve(true),
    },
  );
  const summary = path.join(folder, 'reports', 'summary.md');
  const saved = existsSync(summary) ? readFileSync(summary, 'utf8') : null;
  return { saved, labels: audits.map((event) => event.subjectLabel) };
}

describe('a PATCH that narrows a storage connection', () => {
  it('[US-STO-12][api][run] the grant is delivered writable, and written back, before any PATCH', async () => {
    const id = await connect();
    const selection = await deliver(id);

    expect(selection.files).toContainEqual({
      kind: 'directory',
      path: FOLDER,
      access: 'read-write',
    });
    expect((await writeBack(id, selection)).saved).toBe('# Q3\n');
  });

  it('[US-STO-12][api][run] allowedPrefixes narrowed past the granted folder: the next run is refused', async () => {
    const id = await connect();
    await narrow(id, { allowedPrefixes: ['archive'] });

    await expect(deliver(id)).rejects.toMatchObject({
      code: 'run_storage_grant_unavailable',
      publicMessage: expect.stringContaining(
        'the folder "reports" is no longer one the connection "acme-data" allows',
      ) as string,
    });
  });

  it('[US-STO-12][api][run] writeAllowed turned off: the next run gets the folder read-only and writes nothing back', async () => {
    const id = await connect();
    await narrow(id, { writeAllowed: false });

    const selection = await deliver(id);
    expect(selection.files).toContainEqual({ kind: 'directory', path: FOLDER, access: 'read' });
    expect(selection.storageFolders).toBeUndefined();

    const written = await writeBack(id, selection);
    expect(written.saved).toBeNull();
    expect(written.labels).toEqual([]);
  });

  it('[US-STO-12][api][run] writeAllowed turned off while a run is in flight: its write-back is refused', async () => {
    const id = await connect();
    const selection = await deliver(id);
    await narrow(id, { writeAllowed: false });

    const written = await writeBack(id, selection);
    expect(written.saved).toBeNull();
    expect(written.labels).toEqual([expect.stringContaining('refused: write_not_allowed')]);
  });

  it('[US-STO-12][api][run] allowedPrefixes narrowed while a run is in flight: its write-back is refused', async () => {
    const id = await connect();
    const selection = await deliver(id);
    await narrow(id, { allowedPrefixes: ['archive'] });

    const written = await writeBack(id, selection);
    expect(written.saved).toBeNull();
    expect(written.labels).toEqual([expect.stringContaining('refused: prefix_not_allowed')]);
  });
});
