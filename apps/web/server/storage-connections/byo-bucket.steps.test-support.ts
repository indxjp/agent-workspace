import { CSV, SUMMARY } from './byo-bucket.guide.test-support';
/** The own-bucket tutorial driven through real CLI and HTTP boundaries with a simulated runner. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect } from 'vitest';

import { loadEgressPolicyFromEnv } from '@agent-workspace/core';
import {
  createInMemoryStorageConnectionRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import { encodeUstar } from '@agent-workspace/runtime/transfer';
import { main } from '@indx-workspace/aw';

import { POST as promoteRoute } from '../../app/api/agents/[id]/promote/route';
import { POST as createAgentRoute, GET as listAgentsRoute } from '../../app/api/agents/route';
import { GET as browseRoute } from '../../app/api/storage-connections/[id]/browse/route';
import { GET as getRoute, PATCH as patchRoute } from '../../app/api/storage-connections/[id]/route';
import { POST as testRoute } from '../../app/api/storage-connections/[id]/test/route';
import { POST as createRoute, GET as listRoute } from '../../app/api/storage-connections/route';
import { createInMemoryAgentVersionStoreProvider } from '../agent-versions/memory-store';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { installTestDomains } from '../application-context-fixtures';
import { writeBackStorage } from '../compose/storage-writeback';
import { createRunStorageConnections } from '../composition/wiring/run-resources';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { startRun } from '../runs/api';
import type { RunPrincipal } from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import { installDeliveringRunApi } from '../runs/run-delivery-fixtures.test-support';
import { createStorageService } from '../storage/service';
import { createRepositoryStorageConnectionsStoreProvider } from './store';

import { TUTORIAL, argvOf } from './byo-bucket.guide.test-support';
import { readBucketText, type LaneSetup } from './byo-bucket.lanes.test-support';
const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOLDER = 'storage/acme-data/reports';

type Egress = ReturnType<typeof loadEgressPolicyFromEnv>;
type Domains = ReturnType<typeof installTutorialDomains>;
type TutorialCli = ReturnType<typeof createTutorialCli>;
type PromotedAgent = Awaited<ReturnType<typeof promoteTutorialAgent>>;
type Delivery = { runs?: ReturnType<typeof installDeliveringRunApi> };

export async function runBucketTutorialSteps(
  work: string,
  lane: LaneSetup,
  egress: Egress,
): Promise<void> {
  const { admin } = lane;
  await admin.write('reports/q3.csv', new Blob([CSV]).stream(), {});
  await admin.write('reports/old.csv', new Blob(['q2,40\n']).stream(), {});

  const project = createTutorialProject({ work, lane });
  const domains = installTutorialDomains(lane, egress);
  const delivery: Delivery = {};
  const startedRuns: string[] = [];
  const web = createTutorialWeb({ delivery, startedRuns });
  const aw = createTutorialCli({ work, project: project.project, web });
  const values = { $STORAGE_URL: lane.url, 'credential.json': project.credentialFile };
  await connectTutorialStorage({ aw, lane, work, values });
  const promoted = await promoteTutorialAgent(aw, domains);
  const runs = installTutorialRun({ lane, domains, promoted });
  delivery.runs = runs;
  await verifyTutorialRun({ aw, values, promoted, startedRuns, runs, admin });
}

function createTutorialProject({ work, lane }: { work: string; lane: LaneSetup }) {
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

  return { project, credentialFile };
}

function installTutorialDomains(lane: LaneSetup, egress: Egress) {
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

  return { scopes, store, agents, versions };
}

function createTutorialWeb({
  delivery,
  startedRuns,
}: {
  delivery: Delivery;
  startedRuns: string[];
}) {
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
  return web;
}

function createTutorialCli({
  work,
  project,
  web,
}: {
  work: string;
  project: string;
  web: typeof fetch;
}) {
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
  return aw;
}

async function connectTutorialStorage({
  aw,
  lane,
  work,
  values,
}: {
  aw: TutorialCli;
  lane: LaneSetup;
  work: string;
  values: Readonly<Record<string, string>>;
}) {
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
}

async function promoteTutorialAgent(aw: TutorialCli, { agents, versions }: Domains) {
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

  return { agent, granted };
}

function installTutorialRun({
  lane,
  domains: { store, scopes },
  promoted: { agent, granted },
}: {
  lane: LaneSetup;
  domains: Domains;
  promoted: PromotedAgent;
}) {
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

  return runs;
}

async function verifyTutorialRun({
  aw,
  values,
  promoted: { agent },
  startedRuns,
  runs,
  admin,
}: {
  aw: TutorialCli;
  values: Readonly<Record<string, string>>;
  promoted: PromotedAgent;
  startedRuns: string[];
  runs: ReturnType<typeof installDeliveringRunApi>;
  admin: LaneSetup['admin'];
}) {
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
  expect(await readBucketText(admin, 'reports/summary.md')).toBe(SUMMARY);
  expect(await readBucketText(admin, 'reports/q3.csv')).toBe(CSV);
  // The sandbox dropped `old.csv`; write-back never propagates a delete.
  expect(await readBucketText(admin, 'reports/old.csv')).toBe('q2,40\n');
}
