/**
 * The own-bucket tutorial (`docs/sdk/site/guides/storage-connections.mdx`) run step for step, the
 * last done-when of the storage design, §06 Phase 5: connect a bucket or folder, grant it to an
 * agent, run, and read both the files the run was given and the file it wrote back (§05).
 *
 * Every CLI line comes from {@link TUTORIAL}, and the guide's code blocks must hold each one, in
 * this order, so a guide that drifts from the tested steps fails here. The CLI runs against the
 * real `/api/storage-connections/**`, `/api/agents` (push), promote and run-start handlers
 * in-process, with the production connection opener and write-back. The runner is a double: there
 * is no sandbox and no model, so a cloud lane proves the real bucket end to end through the
 * product's connection code.
 *
 * The connection gets a least-privilege credential (no delete); the objects are seeded and cleaned
 * up through a separate admin store that may delete.
 *
 * The `file` lane runs in normal CI. A cloud lane is registered only when the live job sets
 * `STORAGE_LIVE_LANE` (`live-e2e.yml`, `suite=storage`), and a lane without its variables fails
 * naming the first one missing; nothing is skipped.
 */
// @story US-STO-12
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fromTokenFile } from '@aws-sdk/credential-provider-web-identity';
import { afterEach, describe, expect, it } from 'vitest';

import { loadEgressPolicyFromEnv } from '@agent-workspace/core';
import {
  createInMemoryStorageConnectionRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import {
  createInMemoryObjectStore,
  openConnectionStore,
  streamToBytes,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { encodeUstar } from '@agent-workspace/runtime/transfer';
import { main } from '@indx-workspace/aw';
import {
  formatStorageUrl,
  parseStorageUrl,
  type StorageLocation,
} from '@indx-workspace/contracts/storage-url';
import type { StorageConnectionCredential } from '@indx-workspace/contracts/storage-connections';

import { POST as promoteRoute } from '../../app/api/agents/[id]/promote/route';
import { GET as listAgentsRoute, POST as createAgentRoute } from '../../app/api/agents/route';
import { GET as browseRoute } from '../../app/api/storage-connections/[id]/browse/route';
import { GET as getRoute, PATCH as patchRoute } from '../../app/api/storage-connections/[id]/route';
import { POST as testRoute } from '../../app/api/storage-connections/[id]/test/route';
import { GET as listRoute, POST as createRoute } from '../../app/api/storage-connections/route';
import { createInMemoryAgentVersionStoreProvider } from '../agent-versions/memory-store';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { writeBackStorage } from '../compose/storage-writeback';
import { createRunStorageConnections } from '../composition/wiring/run-resources';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import type { RunPrincipal } from '../runs/environment';
import { startRun } from '../runs/api';
import { InMemoryRunStore } from '../runs/memory-store';
import { installDeliveringRunApi } from '../runs/run-delivery-fixtures';
import { createStorageService } from '../storage/service';
import { createRepositoryStorageConnectionsStoreProvider } from './store';

const GUIDE_URL = new URL(
  '../../../../docs/sdk/site/guides/storage-connections.mdx',
  import.meta.url,
);

/**
 * The guide's steps, in the order a reader runs them. `$STORAGE_URL`, `$AGENT_ID` and the
 * `.json` name are the lane's values.
 */
const TUTORIAL = {
  create:
    'aw storage connections create --name acme-data --storage-url "$STORAGE_URL" --allow reports --credential-file credential.json',
  test: 'aw storage connections test acme-data',
  ls: 'aw storage ls acme-data/reports/',
  allowWrites: 'aw storage connections update acme-data --write-allowed',
  grant: "files('storage://acme-data/reports', 'read-write')",
  permissions: 'permissions: { readFiles: true, writeFiles: true },',
  push: 'aw push --yes',
  promote: 'aw promote --yes',
  run: 'aw runs start "$AGENT_ID" --prompt "Summarise the Q3 reports into summary.md"',
} as const;

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CSV = 'quarter,total\nq3,42\n';
const SUMMARY = '# Q3\nTotal: 42\n';
const FOLDER = 'storage/acme-data/reports';

interface LaneSetup {
  readonly url: string;
  /** The connection's credential: least privilege, never delete. */
  readonly credential: StorageConnectionCredential;
  /** Seeds the folder and cleans it up, with a credential that may delete. */
  readonly admin: ObjectStore;
  readonly fileRoots: readonly string[];
}

type Lane = (work: string) => Promise<LaneSetup>;

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name} is not set`);
  return value;
};

/** A prefix of its own for this run, so two runs never meet and cleanup knows what it made. */
const livePrefix = (): string =>
  `aw-byo-live/${process.env['GITHUB_RUN_ID'] ?? 'local'}-${randomBytes(4).toString('hex')}`;

const egress = loadEgressPolicyFromEnv();
const openStore = (
  url: string,
  credential: StorageConnectionCredential,
  fileRoots: readonly string[],
): Promise<ObjectStore> =>
  openConnectionStore(url, credential, { writable: true, fileRoots, egress });

/** The ambient AWS settings a lane removes, so the connection can only use its own credential. */
const AMBIENT_AWS = [
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_EC2_METADATA_DISABLED',
] as const;
const savedEnv = new Map<string, string | undefined>();

/** The S3 lane's role: STS sessions as the role itself, or as the role cut down to a policy. */
const s3Role = () => {
  const bucket = requireEnv('TEST_AWS_S3_BUCKET');
  const region = requireEnv('TEST_AWS_REGION');
  const roleArn = requireEnv('AWS_ROLE_ARN');
  const webIdentityTokenFile = requireEnv('AWS_WEB_IDENTITY_TOKEN_FILE');
  const session = async (sessionPolicy?: string): Promise<StorageConnectionCredential> => {
    const identity = await fromTokenFile({
      roleArn,
      webIdentityTokenFile,
      ...(sessionPolicy === undefined ? {} : { policy: sessionPolicy }),
      clientConfig: { region },
    })();
    if (identity.sessionToken === undefined) throw new Error('STS returned no session token');
    return {
      provider: 's3',
      accessKeyId: identity.accessKeyId,
      secretAccessKey: identity.secretAccessKey,
      sessionToken: identity.sessionToken,
    };
  };
  return { bucket, region, session };
};

/** The guide's S3 policy for one folder: `s3:ListBucket` under the `s3:prefix` condition, get and put in it. */
const folderPolicy = (bucket: string, folder: string): string =>
  JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: `arn:aws:s3:::${bucket}`,
        Condition: { StringLike: { 's3:prefix': `${folder}/*` } },
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject'],
        Resource: `arn:aws:s3:::${bucket}/${folder}/*`,
      },
    ],
  });

/** From here on nothing ambient can authenticate: the stores hold the explicit credentials. */
const isolateFromAmbientAws = (work: string): void => {
  for (const name of AMBIENT_AWS) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  process.env['AWS_EC2_METADATA_DISABLED'] = 'true';
  process.env['AWS_SHARED_CREDENTIALS_FILE'] = path.join(work, 'no-aws-credentials');
  process.env['AWS_CONFIG_FILE'] = path.join(work, 'no-aws-config');
};

const fileLane: Lane = async (work) => {
  const root = path.join(work, 'roots');
  const folder = path.join(root, 'acme-data');
  mkdirSync(folder, { recursive: true });
  const url = `file://${folder}`;
  const credential = { provider: 'file' } as const;
  return { url, credential, admin: await openStore(url, credential, [root]), fileRoots: [root] };
};

const cloudLanes: Readonly<Record<string, Lane>> = {
  s3: async (work) => {
    const { bucket, region, session } = s3Role();
    const prefix = livePrefix();
    // The connection's session is the role cut down to the guide's policy: list, get and put on
    // the prefix, never delete. The admin session is the role itself.
    const credential = await session(folderPolicy(bucket, prefix));
    const adminCredential = await session();
    isolateFromAmbientAws(work);
    const url = formatStorageUrl({ kind: 's3', bucket, prefix, region, forcePathStyle: false });
    return { url, credential, admin: await openStore(url, adminCredential, []), fileRoots: [] };
  },
  gcs: async () => {
    // The workflow's workload identity mints one short-lived access token. The connection gets it
    // as its credential; the guide's least-privilege IAM grant is what a customer's key holds. The
    // admin store uses the same token because the service account may delete, which cleanup needs.
    const accessToken = requireEnv('GCS_LIVE_ACCESS_TOKEN');
    const url = formatStorageUrl({
      kind: 'gcs',
      bucket: requireEnv('TEST_GCS_BUCKET'),
      prefix: livePrefix(),
      projectId: requireEnv('TEST_GCP_PROJECT'),
    });
    const credential = { provider: 'gcs', accessToken } as const;
    return { url, credential, admin: await openStore(url, credential, []), fileRoots: [] };
  },
  azblob: async () => {
    // `az` prints the service URL with a trailing slash; the account is its first host label.
    const serviceUrl = requireEnv('AZURE_BLOB_LIVE_SERVICE_URL').replace(/\/+$/u, '');
    const location: StorageLocation = {
      kind: 'azblob',
      account: new URL(serviceUrl).hostname.split('.')[0] ?? '',
      serviceUrl,
      container: requireEnv('AZURE_BLOB_LIVE_CONTAINER'),
      prefix: livePrefix(),
    };
    const url = formatStorageUrl(location);
    // Two user-delegation SAS tokens: `rlcw` for the connection, `rlcwd` for seeding and cleanup.
    const credential = { provider: 'azblob', sasToken: requireEnv('AZURE_BLOB_LIVE_SAS') } as const;
    const adminSas = requireEnv('AZURE_BLOB_LIVE_ADMIN_SAS');
    return {
      url,
      credential,
      admin: await openStore(url, { provider: 'azblob', sasToken: adminSas }, []),
      fileRoots: [],
    };
  },
};

const liveLane = process.env['STORAGE_LIVE_LANE'];
if (liveLane !== undefined && !Object.hasOwn(cloudLanes, liveLane)) {
  throw new Error(`STORAGE_LIVE_LANE must be one of ${Object.keys(cloudLanes).join(', ')}`);
}

const text = async (store: ObjectStore, key: string): Promise<string | null> => {
  const object = await store.read(key);
  return object === null ? null : Buffer.from(await streamToBytes(object.body)).toString('utf8');
};

/** `aw <line>` with the lane's values in place of the guide's placeholders. */
const argvOf = (line: string, values: Readonly<Record<string, string>>): string[] =>
  Array.from(line.matchAll(/"([^"]*)"|(\S+)/gu), (token) => token[1] ?? token[2] ?? '')
    .slice(1)
    .map((token) => values[token] ?? token);

/** The bodies of the guide's fenced code blocks, tabs included, in page order. */
const guideCode = (): string =>
  Array.from(
    readFileSync(GUIDE_URL, 'utf8').matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gmu),
    (block) => block[1] ?? '',
  ).join('\n');

/** Every storage URL the guide's code blocks give `--storage-url`, directly or as `STORAGE_URL`. */
const guideStorageUrls = (code: string): string[] =>
  Array.from(
    code.matchAll(/(?:--storage-url\s+|STORAGE_URL=)"?([^"\s$][^"\s]*)/gu),
    (url) => url[1] ?? '',
  );

const queryNames = (url: string): string[] =>
  [...new URLSearchParams(url.split('?')[1] ?? '').keys()].sort();

const tempDirs: string[] = [];
afterEach(() => {
  clearApplicationContext();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The tutorial from the guide's first line to the file written back, on one lane. */
async function tutorial(prepare: Lane): Promise<void> {
  // The credential file lives under the runner's own temporary directory when there is one.
  const work = realpathSync(
    mkdtempSync(path.join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'aw-byo-')),
  );
  tempDirs.push(work);
  const lane = await prepare(work);
  // The lane's URL has the shape the guide gives its kind.
  const kind = parseStorageUrl(lane.url);
  if (!kind.ok) throw new Error('the lane URL does not parse');
  const guideUrl = guideStorageUrls(guideCode()).find(
    (url) => parseStorageUrl(url).ok && url.startsWith(`${kind.location.kind}://`),
  );
  expect(queryNames(lane.url)).toEqual(queryNames(guideUrl ?? ''));
  const { admin } = lane;
  const written = ['reports/q3.csv', 'reports/old.csv', 'reports/summary.md'];
  let failure: { readonly error: unknown } | undefined;
  try {
    await steps(work, lane);
  } catch (error) {
    failure = { error };
  }
  const cleanup = await Promise.allSettled(written.map((key) => admin.delete(key)));
  const cleanupErrors = cleanup.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failure !== undefined && cleanupErrors.length > 0) {
    // Both are reported, the tutorial's own error first.
    throw new AggregateError(
      [failure.error, ...cleanupErrors],
      `the tutorial failed (${String(failure.error)}), and so did its cleanup`,
    );
  }
  if (failure !== undefined) throw failure.error;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'the cleanup failed');
}

/**
 * The guide's own S3 shape (#1925 item 17): a prefix-less `s3://bucket?region=…` URL whose key may
 * list only one folder, `s3:ListBucket` conditioned on that folder's `s3:prefix`. Opening the store
 * must not probe the bucket root, the folder lists and reads, and a listing of the root is refused
 * with the provider's 403. The folder is the run's own prefix, so the role's grant is unchanged.
 */
async function prefixlessFolder(): Promise<void> {
  const work = realpathSync(
    mkdtempSync(path.join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'aw-byo-')),
  );
  tempDirs.push(work);
  const { bucket, region, session } = s3Role();
  const folder = livePrefix();
  const credential = await session(folderPolicy(bucket, folder));
  const adminCredential = await session();
  isolateFromAmbientAws(work);
  const url = formatStorageUrl({ kind: 's3', bucket, prefix: '', region, forcePathStyle: false });
  expect(url).toBe(`s3://${bucket}?region=${region}`);
  const admin = await openStore(url, adminCredential, []);
  const seeded = `${folder}/q3.csv`;
  const written = `${folder}/summary.md`;
  try {
    await admin.write(seeded, new Blob([CSV]).stream(), {});
    const store = await openStore(url, credential, []);
    const page = await store.listPage(folder, { limit: 10 });
    expect(page.entries.map((entry) => entry.key)).toEqual([seeded]);
    expect(await text(store, seeded)).toBe(CSV);
    await store.write(written, new Blob([SUMMARY]).stream(), {});
    expect(await text(admin, written)).toBe(SUMMARY);
    const outside: unknown = await store.listPage('', { limit: 1 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outside).toMatchObject({ $metadata: { httpStatusCode: 403 } });
    // The key has no delete, as the guide grants it.
    await expect(store.delete(written)).rejects.toMatchObject({
      $metadata: { httpStatusCode: 403 },
    });
  } finally {
    await Promise.allSettled([admin.delete(seeded), admin.delete(written)]);
  }
}

async function steps(work: string, lane: LaneSetup): Promise<void> {
  const { admin } = lane;
  await admin.write('reports/q3.csv', new Blob([CSV]).stream(), {});
  await admin.write('reports/old.csv', new Blob(['q2,40\n']).stream(), {});

  const credentialFile = path.join(work, 'credential.json');
  writeFileSync(credentialFile, JSON.stringify(lane.credential), { mode: 0o600 });
  // The project `aw push` reads: the guide's agent, its grant and permissions the tested lines.
  const project = path.join(work, 'project');
  mkdirSync(path.join(project, 'agents'), { recursive: true });
  writeFileSync(
    path.join(project, 'agents', 'summarizer.ts'),
    [
      "import { defineAgent, files } from '@indx-workspace/sdk/define';",
      '',
      'export default defineAgent({',
      "  name: 'summarizer',",
      "  instructions: 'Summarise the reports you are given.',",
      `  files: [${TUTORIAL.grant}],`,
      `  ${TUTORIAL.permissions}`,
      '});',
      '',
    ].join('\n'),
  );

  const scopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'byo' }]);
  const secrets = createInMemorySecretsService();
  const store = createRepositoryStorageConnectionsStoreProvider({
    repositories: createInMemoryStorageConnectionRepositoryProvider(),
    scopes,
    secrets,
  });
  const agents = createInMemoryAgentStoreProvider();
  const versions = createInMemoryAgentVersionStoreProvider({ agents });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory(),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: ACTOR,
            apiKeyId: randomUUID(),
            workspaceId: WORKSPACE,
            role: 'owner',
            label: 'byo-bucket tutorial',
          }),
        ),
    },
    agents: {
      agents,
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
    },
    agentVersions: { versions },
    storageConnections: {
      kind: 'serving',
      runtime: {
        store,
        fileRoots: lane.fileRoots,
        egress,
        isConnectionGranted: () => Promise.resolve(false),
        audit: () => Promise.resolve(),
      },
    },
  });

  // Installed once the agent is promoted: its run API replaces the agents domain push used.
  const delivery: { runs?: ReturnType<typeof installDeliveringRunApi> } = {};
  const startedRuns: string[] = [];
  /** The web app in-process: the storage-connection, agent, promote and run-start routes. */
  const web = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    if (pathname === '/api/storage-connections') {
      return (request.method === 'GET' ? listRoute : createRoute)(request);
    }
    if (pathname === '/api/agents') {
      return (request.method === 'GET' ? listAgentsRoute : createAgentRoute)(request);
    }
    const promote = /^\/api\/agents\/([^/]+)\/promote$/u.exec(pathname);
    if (promote?.[1] !== undefined) {
      return promoteRoute(request, { params: Promise.resolve({ id: promote[1] }) });
    }
    if (/^\/api\/agents\/[^/]+\/runs$/u.test(pathname) && delivery.runs !== undefined) {
      const response = await startRun(request, delivery.runs.agentId);
      const body = (await response.clone().json()) as { run?: { id: string } };
      if (body.run !== undefined) startedRuns.push(body.run.id);
      return response;
    }
    const match = /^\/api\/storage-connections\/([^/]+)(\/test|\/browse)?$/u.exec(pathname);
    if (match?.[1] === undefined) return new Response(null, { status: 404 });
    const handlers = {
      GET: match[2] === '/browse' ? browseRoute : getRoute,
      POST: testRoute,
      PATCH: patchRoute,
    } as const;
    const handler = handlers[request.method as keyof typeof handlers];
    if (handler === undefined) return new Response(null, { status: 405 });
    return handler(request, { params: Promise.resolve({ id: match[1] }) });
  };
  /**
   * `aw <line>`, run in-process. A failing step's stdout is the assertion message: it is the API's
   * typed answer (a test outcome such as `{ "ok": false, "code": "forbidden" }`, or a connection
   * without its credential), never a credential.
   */
  const aw = async (line: string, values: Readonly<Record<string, string>> = {}) => {
    let stdout = '';
    let stderr = '';
    const code = await main(argvOf(line, values), {
      stdin: () => Promise.resolve(''),
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      },
      env: { AGENT_WORKSPACE_URL: 'http://127.0.0.1:3000', AGENT_WORKSPACE_API_KEY: 'ak_test' },
      homeDir: path.join(work, 'no-home'),
      cwd: project,
      fetch: web,
      isTty: false,
      sleep: () => Promise.resolve(),
    });
    return { code, stdout, stderr };
  };
  const values = {
    $STORAGE_URL: lane.url,
    'credential.json': credentialFile,
  };

  if (lane.fileRoots.length > 0) {
    // A folder outside the operator's roots is refused.
    const outside = await aw(TUTORIAL.create.replace('acme-data', 'outside'), {
      ...values,
      $STORAGE_URL: `file://${work}`,
    });
    expect(outside.code).toBe(1);
  }

  // Connect, test and list: the connection is read-only until the owner allows writes.
  const created = await aw(TUTORIAL.create, values);
  expect({ stderr: created.stderr, code: created.code }, created.stdout).toEqual({
    stderr: '',
    code: 0,
  });
  const tested = await aw(TUTORIAL.test);
  expect({ stderr: tested.stderr, code: tested.code }, tested.stdout).toEqual({
    stderr: '',
    code: 0,
  });
  const before = await aw(TUTORIAL.ls);
  expect(before.code).toBe(0);
  expect(before.stdout).toContain('reports/q3.csv');
  expect(before.stdout).toContain('reports/old.csv');

  // Pushing the read-write grant is refused while the connection is read-only, as the guide warns.
  const early = await aw(TUTORIAL.push);
  expect(early.code).toBe(1);
  expect(early.stderr + early.stdout).toContain('storage_connection_write_not_allowed');
  const allowed = await aw(TUTORIAL.allowWrites, values);
  expect({ stderr: allowed.stderr, code: allowed.code }, allowed.stdout).toEqual({
    stderr: '',
    code: 0,
  });

  // Save and promote: the push binds the grant to the connection.
  const pushed = await aw(TUTORIAL.push);
  expect({ stderr: pushed.stderr, code: pushed.code }, pushed.stdout).toEqual({
    stderr: '',
    code: 0,
  });
  const promoted = await aw(TUTORIAL.promote);
  expect(promoted.code, promoted.stderr).toBe(0);
  const [agent] = await agents.forWorkspace(WORKSPACE).list();
  if (agent === undefined) throw new Error('aw push saved no agent');
  const versionStore = await versions.forWorkspace(WORKSPACE);
  const production = (await versionStore?.list(agent.id))?.pointers.find(
    (pointer) => pointer.environment === 'production',
  );
  if (versionStore === null || production === undefined) throw new Error('nothing was promoted');
  const granted = await versionStore.storageGrantsOf(production.versionId);
  expect(granted.map(({ prefix, access }) => ({ prefix, access }))).toEqual([
    { prefix: 'reports', access: 'read-write' },
  ]);

  // The run, as the composition root wires it: the real connection opener and write-back.
  const connections = createRunStorageConnections({
    storage: { store, fileRoots: lane.fileRoots },
    scopes,
  });
  const userId = randomUUID();
  const principal: RunPrincipal = {
    principalId: randomUUID(),
    ownerPrincipalId: randomUUID(),
    userId,
    workspaceId: WORKSPACE,
    role: 'owner',
    scope: null,
  };
  const catalogs = createInMemoryCatalogStore();
  const sessionId = randomUUID();
  const folder = `${WORKSPACE}/${sessionId}/${FOLDER}`;
  const runs = installDeliveringRunApi({
    world: { catalogs, workspaceId: WORKSPACE, principalId: principal.principalId, userId },
    storage: createStorageService({
      catalog: (workspaceId) => catalogs.forWorkspace(workspaceId),
      objects: createInMemoryObjectStore(),
      log: noLog,
    }),
    store: new InMemoryRunStore(),
    authenticate: () => Promise.resolve(principal),
    storageGrants: granted,
    storageConnections: connections,
    agentId: agent.id,
    sessionId,
    // What the sandbox leaves in the folder: the report as it was, a new summary, `old.csv` gone.
    runnerFiles: (requested) =>
      requested === folder
        ? encodeUstar(
            Object.entries({ 'q3.csv': CSV, 'summary.md': SUMMARY }).map(([name, data]) => ({
              path: `${folder}/${name}`,
              type: 'file' as const,
              mode: 0o644,
              data: Buffer.from(data),
            })),
          )
        : null,
    storageWriteback: (writeBack) =>
      writeBackStorage(writeBack, {
        readRunAgent: () =>
          Promise.resolve({
            agent,
            assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: granted },
            toolBundles: [],
            subagents: [],
          }),
        connections,
        audit: () => Promise.resolve(),
        stillRunning: () => Promise.resolve(true),
      }),
  });
  delivery.runs = runs;

  // Run it, wait for the write-back, and read the result through the CLI and from the bucket.
  const started = await aw(TUTORIAL.run, { ...values, $AGENT_ID: agent.id });
  expect({ stderr: started.stderr, code: started.code }, started.stdout).toEqual({
    stderr: '',
    code: 0,
  });
  const [runId] = startedRuns;
  if (runId === undefined) throw new Error('the run was not started');
  const delivered = await runs.delivered(runId);
  expect(delivered.archive.some((member) => member.path.endsWith(`/${FOLDER}/q3.csv`))).toBe(true);

  const after = await aw(TUTORIAL.ls);
  expect(after.code).toBe(0);
  expect(after.stdout).toContain('reports/summary.md');
  expect(await text(admin, 'reports/summary.md')).toBe(SUMMARY);
  expect(await text(admin, 'reports/q3.csv')).toBe(CSV);
  // The sandbox dropped `old.csv`; write-back never propagates a delete.
  expect(await text(admin, 'reports/old.csv')).toBe('q2,40\n');
}

/** `admin` that cannot delete, and reads no `summary.md`, so both the tutorial and its cleanup fail. */
function sabotaged(admin: ObjectStore): ObjectStore {
  return new Proxy(admin, {
    get(target, name) {
      if (name === 'delete') return () => Promise.reject(new Error('cleanup refused'));
      if (name === 'read') {
        return (key: string) =>
          key === 'reports/summary.md' ? Promise.resolve(null) : target.read(key);
      }
      const member: unknown = Reflect.get(target, name);
      return typeof member === 'function'
        ? (member as (...args: unknown[]) => unknown).bind(target)
        : member;
    },
  });
}

describe('the own-bucket tutorial', () => {
  // @story US-STO-12
  it('[US-STO-12][api][cli] the guide gives the tested steps in order', () => {
    const code = guideCode();
    let at = -1;
    for (const line of Object.values(TUTORIAL)) {
      const next = code.indexOf(line, at + 1);
      expect(
        next,
        `the guide's code blocks lack the step, or give it too early: ${line}`,
      ).toBeGreaterThan(at);
      at = next;
    }
  });

  // @story US-STO-12
  it('[US-STO-12][api][cli] every storage URL the guide gives parses, one per kind', () => {
    const urls = guideStorageUrls(guideCode());
    const kinds = urls.map((url) => {
      const parsed = parseStorageUrl(url);
      expect(parsed, url).toMatchObject({ ok: true });
      return parsed.ok ? parsed.location.kind : url;
    });
    expect(kinds.sort()).toEqual(['azblob', 'file', 'gcs', 's3']);
    // The lanes copy the guide's query names, so a dropped `?region=` would otherwise pass unseen.
    const names = (scheme: string): string[] =>
      queryNames(urls.find((url) => url.startsWith(`${scheme}://`)) ?? '');
    expect(names('s3'), 'the guide gives the s3 URL its region').toContain('region');
    expect(names('gcs'), 'the guide gives the gcs URL its project').toContain('project');
  });

  if (liveLane === undefined) {
    // @story US-STO-12
    it('[US-STO-12][api][cli] the tutorial works on a local folder', () => tutorial(fileLane));

    // @story US-STO-12
    it('[US-STO-12][api][cli] a cleanup failure is reported without hiding the tutorial failure', async () => {
      const outcome = await tutorial(async (work) => {
        const lane = await fileLane(work);
        return { ...lane, admin: sabotaged(lane.admin) };
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(AggregateError);
      const errors: unknown[] = (outcome as AggregateError).errors;
      const [own, ...cleanup] = errors;
      expect(String(own)).toContain('# Q3');
      expect(cleanup.map(String)).toEqual(Array(3).fill('Error: cleanup refused'));
    });
  }

  const cloud = liveLane === undefined ? undefined : cloudLanes[liveLane];
  if (liveLane === 's3' && cloud !== undefined) {
    // @story US-STO-12
    it('[US-STO-12][api][cli] the tutorial works on S3', () => tutorial(cloud), 120_000);
    // @story US-STO-12
    it(
      '[US-STO-12][api][cli] a key limited to one folder opens a prefix-less S3 URL, as the guide gives it',
      prefixlessFolder,
      120_000,
    );
  }
  if (liveLane === 'gcs' && cloud !== undefined) {
    // @story US-STO-12
    it('[US-STO-12][api][cli] the tutorial works on GCS', () => tutorial(cloud), 120_000);
  }
  if (liveLane === 'azblob' && cloud !== undefined) {
    // @story US-STO-12
    it('[US-STO-12][api][cli] the tutorial works on Azure Blob', () => tutorial(cloud), 120_000);
  }
});
