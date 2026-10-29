/**
 * The Phase 4 done-when (the storage design, §06): a run with 128 MiB of granted files works and
 * the web server's memory grows by less than 64 MiB. It drives the real web-server path: the
 * resource loader turns catalog rows into references, the workspace lifecycle streams one archive,
 * and the launcher's hydrate POST sends it to a sink runner that drains it. The `/run` body is
 * captured too: it carries references only.
 *
 * It always runs at full size (128 MiB, the run limit, `TOTAL_BYTES`), twice the bound, so a
 * buffering path fails here; it takes about 2 s per catalog. Each case runs on both catalogs. The
 * negative control, which shows the measurement sees a buffered archive at the same size, is
 * `run-files-buffering-control.test.ts`: a file of its own, so neither reading shares a process
 * heap with the other (as `server/skills/multipart-buffering-control.test.ts` is). It lives beside
 * the code it drives rather than in `tests/load/`: the root type-check reads `tests/` under Node's
 * ESM rules, which the web server's extensionless imports do not follow.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './memory-store';
import {
  AGENT_ID,
  RSS_BOUND,
  RUN_ID,
  SESSION_ID,
  TOTAL_BYTES,
  grantedRun,
  newMember,
  type World,
} from './run-files-load-fixtures';
import { createResourceCatalogStoreProvider } from '../resources/catalog-store';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { measureRssGrowth, MiB, warmHttpTransport } from '../../../../tests/load/flat-memory';

// Collecting every 4 MiB keeps uncollected socket-read garbage out of the reading (PR #1747).
const SAMPLE_EVERY = 4 * MiB;
const RUN_BODY_BOUND = 64 * 1024;

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL case is never skipped.
  isolated = await createIsolatedTestDatabase('aw_run_files_load');
}, 180_000);

afterAll(async () => isolated?.close());

async function postgresWorld(): Promise<World> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const userId = crypto.randomUUID();
  const member = newMember(userId);
  const { workspaceId, principalId } = member;
  const id = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'load' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId: id });
  });
  return {
    catalogs: createResourceCatalogStoreProvider({
      repositories: createDatabaseResourceCatalogRepositoryProvider(db),
      scopes: createDatabaseWorkspaceScopeResolver(db),
    }),
    member,
  };
}

const memoryWorld = (): Promise<World> =>
  Promise.resolve({ catalogs: createInMemoryCatalogStore(), member: newMember() });

/** A runner stand-in: drains `POST /files` (calling `onBytes` as it goes) and records `/run`. */
async function sinkRunner(onBytes: (total: number) => void): Promise<{
  readonly url: string;
  readonly hydrated: () => number;
  readonly runBodies: string[];
  readonly close: () => Promise<void>;
}> {
  let hydrated = 0;
  const runBodies: string[] = [];
  const text = async (req: IncomingMessage): Promise<string> => {
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) body += String(chunk);
    return body;
  };
  const server: Server = createServer((req, res) => {
    if (req.url === '/files' && req.method === 'POST') {
      req.on('data', (chunk: Buffer) => {
        hydrated += chunk.byteLength;
        onBytes(hydrated);
      });
      req.on('end', () => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'));
      return;
    }
    if (req.url === '/run' && req.method === 'POST') {
      void text(req).then((body) => {
        runBodies.push(body);
        res
          .writeHead(200, { 'Content-Type': 'text/event-stream' })
          .end('event: run-done\ndata: {}\n\n');
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    hydrated: () => hydrated,
    runBodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function settle(store: InMemoryRunStore): Promise<string> {
  for (let i = 0; i < 6000; i += 1) {
    const run = await store.get(RUN_ID);
    if (run !== null && run.endedAt !== null)
      return `${run.status}${run.error === null ? '' : `: ${run.error}`}`;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the run never reached a terminal status');
}

function defineLoadSuite(name: string, setup: () => Promise<World>) {
  describe(`run files on the ${name}`, () => {
    it(
      '[US-STO-06][load][run] a 128 MiB run keeps server memory under 64 MiB',
      { timeout: 300_000 },
      async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'aw-run-files-load-'));
        let next = SAMPLE_EVERY;
        let sampler: () => void = () => undefined;
        const sink = await sinkRunner((total) => {
          if (total >= next) {
            sampler();
            next += SAMPLE_EVERY;
          }
        });
        try {
          const { loader, lifecycle, context, assignments } = await grantedRun(await setup(), root);
          const store = new InMemoryRunStore();
          await store.create({
            engine: 'claude-agent-sdk',
            id: RUN_ID,
            workspaceId: context.principal.workspaceId,
            agentId: AGENT_ID,
            sessionId: SESSION_ID,
          });
          const launch = createRunnerLauncher({
            store,
            runtime: {
              resolve: () =>
                Promise.resolve({
                  runtimeProfileId: 'profile-docker',
                  driver: 'docker',
                  networkPolicy: 'none',
                  filesystem: 'read-write',
                  persistPaths: [],
                  runnerUrl: sink.url,
                  workspaceRoot: '/workspace',
                  fileTransfer: 'push-archive',
                }),
            },
            // The `/run` resources exactly as compose puts them into the body (run-request.ts).
            buildRunRequest: async () => {
              const loaded = await loader.load(context.principal.workspaceId, assignments);
              return {
                runId: RUN_ID,
                sessionId: SESSION_ID,
                resources: { files: loaded.files, skills: loaded.skills },
              };
            },
            workspaceLifecycle: lifecycle,
          });

          await warmHttpTransport();
          let outcome = '';
          const { growth, newSpaceGrowth } = await measureRssGrowth(async (sample) => {
            sampler = sample;
            launch(context);
            outcome = await settle(store);
          });
          const runBody = sink.runBodies[0] ?? '';
          console.info(
            `[load] run files (${name}): peak RSS growth ${(growth / MiB).toFixed(1)} MiB of ${String(TOTAL_BYTES / MiB)} MiB, new space growth ${(newSpaceGrowth / MiB).toFixed(1)} MiB, /run body ${String(Buffer.byteLength(runBody))} bytes`,
          );
          expect(outcome).toBe('completed');
          expect(growth).toBeLessThan(RSS_BOUND);
          expect(sink.hydrated()).toBeGreaterThan(TOTAL_BYTES);
          expect(sink.runBodies).toHaveLength(1);
          expect(Buffer.byteLength(runBody)).toBeLessThan(RUN_BODY_BOUND);
          expect(runBody).not.toContain('contentBase64');
        } finally {
          await sink.close();
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  });
}

defineLoadSuite('in-memory catalog', memoryWorld);
defineLoadSuite('PostgreSQL catalog', () => postgresWorld());
