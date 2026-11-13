/**
 * An agent's memory folder through the launcher (ADR-0163): the folder `memory/<agentId>/` is
 * handed to a run read-write at `memory/`, and a completed run's `memory/` is written back to it,
 * within its bounds, with one `memory-updated` audit row naming the run.
 *
 * The runtime is a scripted double that keeps one sandbox per session: it unpacks the hydrate,
 * runs a script against the sandbox (the "engine"), and answers `GET /files` from the sandbox. The
 * lifecycle, the resource loader and the storage service are the real ones, over the in-memory
 * catalog and object store. Docker and a real model are not used; see the ADR's declared gap.
 */
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInMemoryCatalog } from '@agent-workspace/core/db/unscoped';
import { createInMemoryObjectStore, streamToBytes } from '@agent-workspace/core/storage';
import { decodeUstar, encodeUstar } from '@agent-workspace/runtime/transfer';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_MEMORY_LIMIT_EXCEEDED,
  AGENT_MEMORY_MAX_BYTES,
  AGENT_MEMORY_MAX_FILES,
  type AgentPermissions,
} from '@indx-workspace/contracts/agents';

import { createAgentRunResourceLoader } from '../compose/resource-loader';
import {
  createRuntimeWorkspaceLifecycle,
  type MemoryUpdatedAuditEvent,
} from '../compose/workspace-lifecycle';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createStorageService } from '../storage/service';
import type { LaunchContext } from './environment';
import { resetLiveRuns } from './interrupt';
import { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './memory-store';
import type { RunRecord } from './store';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const OTHER_AGENT = '99999999-9999-4999-8999-999999999999';
const PRINCIPAL = '77777777-7777-4777-8777-777777777777';
const FOLDER = `memory/${AGENT}`;

const REMEMBERING: AgentPermissions = {
  readFiles: true,
  writeFiles: true,
  memory: 'agent',
  runCommands: false,
  unrestrictedNetwork: false,
};

const DONE = 'event: run-done\ndata: {}\n\n';
const FAILED = 'event: run-error\ndata: {"message":"sdk failed"}\n\n';
const CANCELLED = 'event: run-interrupted\ndata: {"interrupted":true}\n\n';

const quietLog = { info() {}, warn() {}, error() {}, child: () => quietLog };

/** One session's sandbox: its files by path under the session's cwd. */
type Sandbox = Map<string, string>;

/**
 * What the scripted engine does in a session: reads and writes its sandbox (or, for a local-disk
 * run, the real directory `disk`), then answers its frames.
 */
type Script = (sandbox: Sandbox, disk: string | null) => string | Promise<string>;

const urlOf = (input: string | URL | Request) =>
  new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

function sseResponse(frames: string): Response {
  return new Response(frames, { headers: { 'Content-Type': 'text/event-stream' } });
}

/** The workspace: one in-memory catalog and object store, the storage service and the audit rows. */
function workspace() {
  const catalog = createInMemoryCatalog().forWorkspace(WORKSPACE);
  const storage = createStorageService({
    catalog: () => Promise.resolve(catalog),
    objects: createInMemoryObjectStore(),
    log: quietLog,
  });
  const loader = createAgentRunResourceLoader({ catalog: createInMemoryCatalogStore(), storage });
  const audits: MemoryUpdatedAuditEvent[] = [];
  const store = new InMemoryRunStore();
  let runs = 0;

  /** Every file of the `files` area under `folder`, by path, as text. */
  async function files(folder = FOLDER): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const { rows } = await storage.list({ workspaceId: WORKSPACE }, 'files', folder);
    for (const row of rows) {
      const body = await storage.open({ workspaceId: WORKSPACE }, row);
      out[row.path] = body === null ? '' : Buffer.from(await streamToBytes(body.body)).toString();
    }
    return out;
  }

  /** A member deletes one file in the file browser (`client.files.remove`). */
  async function remove(path: string): Promise<void> {
    const result = await storage.remove({ workspaceId: WORKSPACE }, 'files', path, {
      recursive: false,
    });
    expect(result.ok).toBe(true);
  }

  interface Session {
    readonly script: Script;
    readonly permissions?: AgentPermissions;
    readonly agentId?: string;
    /** `local-disk` runs on this host under `workspaceRoot`; push-archive by default. */
    readonly workspaceRoot?: string;
  }

  /** One run in a new session; answers its record and what the sandbox held when the script ran. */
  async function session(options: Session) {
    runs += 1;
    const n = String(runs).padStart(12, '0');
    const runId = `11111111-1111-4111-8111-${n}`;
    const sessionId = `44444444-4444-4444-8444-${n}`;
    const agentId = options.agentId ?? AGENT;
    const cwd = `${WORKSPACE}/${sessionId}`;
    const permissions = options.permissions ?? REMEMBERING;
    const localRoot = options.workspaceRoot;
    const sandbox: Sandbox = new Map();
    let hydrated: Sandbox = new Map();
    const memoryPaths: string[] = [];

    const run: RunRecord = await store.create({
      engine: 'claude-agent-sdk',
      id: runId,
      workspaceId: WORKSPACE,
      agentId,
      sessionId,
    });
    const context: LaunchContext = {
      run,
      agent: { id: agentId, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' },
      session: { id: sessionId, agentId, engine: null },
      principal: {
        principalId: PRINCIPAL,
        ownerPrincipalId: PRINCIPAL,
        userId: '66666666-6666-4666-8666-666666666666',
        workspaceId: WORKSPACE,
        scope: null,
      },
      prompt: 'Which VPN gateway do we use?',
    };
    const lifecycle = createRuntimeWorkspaceLifecycle({
      resources: loader,
      // The real loader, asked for this agent's memory folder as compose asks for it.
      granted: () =>
        loader.load(
          WORKSPACE,
          { files: [], skillIds: [], connectorIds: [] },
          null,
          permissions,
          [],
          permissions.memory === 'agent' && permissions.readFiles && permissions.writeFiles
            ? agentId
            : null,
        ),
      storage,
      audit: (event) => {
        audits.push(event);
        return Promise.resolve();
      },
    });

    let settled!: () => void;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const root = localRoot ?? '/workspace';
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
            workspaceRoot: root,
            fileTransfer: localRoot === undefined ? 'push-archive' : 'local-disk',
          }),
      },
      buildRunRequest: () => ({
        runId,
        cwd: `${root}/${cwd}`,
        portable: { permissions },
        resources: { files: [] },
      }),
      workspaceLifecycle: lifecycle,
      fetch: async (input, init) => {
        const url = urlOf(input);
        if (url.pathname === '/files' && init?.method === 'POST') {
          const entries = decodeUstar(new Uint8Array(await new Response(init.body).arrayBuffer()));
          for (const entry of entries) {
            if (entry.type !== 'file') continue;
            sandbox.set(entry.path.slice(cwd.length + 1), Buffer.from(entry.data ?? []).toString());
          }
          hydrated = new Map(sandbox);
          return new Response(null, { status: 204 });
        }
        if (url.pathname === '/run') {
          // A local-disk run was hydrated on this host: its script works on the real directory.
          const disk = localRoot === undefined ? null : join(localRoot, cwd);
          return sseResponse(await options.script(sandbox, disk));
        }
        if (url.pathname === '/interrupt') return Response.json({}, { status: 202 });
        const path = url.searchParams.get('path');
        if (path === `${cwd}/memory`) memoryPaths.push(path);
        const prefix = `${path ?? ''}/`.slice(cwd.length + 1);
        const members = [...sandbox].filter(([rel]) => rel.startsWith(prefix));
        if (path === null || members.length === 0) {
          return Response.json({ error: 'file_not_found' }, { status: 404 });
        }
        return new Response(
          encodeUstar(
            members.map(([rel, text]) => ({
              path: `${cwd}/${rel}`,
              type: 'file' as const,
              mode: 0o644,
              data: Buffer.from(text),
            })),
          ).slice(),
        );
      },
      onLaunchSettled: () => settled(),
    })(context);
    await done;
    return { record: await store.get(runId), runId, hydrated, memoryPaths };
  }

  return { session, files, remove, audits, storage };
}

/** The scripted engine of the acceptance: remember a fact, or just report what memory holds. */
const writesFact: Script = (sandbox) => {
  sandbox.set('memory/MEMORY.md', '# Facts\n\n- the VPN gateway is vpn2\n');
  return DONE;
};
const readsOnly: Script = () => DONE;

const roots: string[] = [];

afterEach(async () => {
  resetLiveRuns();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('the three-session acceptance: write, recall, delete and no recall (ADR-0163)', () => {
  it('carries a fact into a new session, and a deleted fact into none', async () => {
    const ws = workspace();

    // Session 1: the agent writes the fact to memory/MEMORY.md.
    const first = await ws.session({ script: writesFact });
    expect(first.record?.status).toBe('completed');
    expect(first.hydrated.has('memory/MEMORY.md')).toBe(false);
    expect(await ws.files()).toEqual({
      [`${FOLDER}/MEMORY.md`]: '# Facts\n\n- the VPN gateway is vpn2\n',
    });

    // Session 2: a new session is handed the fact before the engine runs.
    const second = await ws.session({ script: readsOnly });
    expect(second.record?.status).toBe('completed');
    expect(second.hydrated.get('memory/MEMORY.md')).toContain('the VPN gateway is vpn2');

    // A member deletes the fact in the file browser; session 3 is not handed it.
    await ws.remove(`${FOLDER}/MEMORY.md`);
    const third = await ws.session({ script: readsOnly });
    expect(third.record?.status).toBe('completed');
    expect(third.hydrated.has('memory/MEMORY.md')).toBe(false);
    expect(await ws.files()).toEqual({});
  });
});

describe('the memory write-back', () => {
  it("saves a completed run's memory files under memory/<agentId>/ in the files area", async () => {
    const ws = workspace();
    const { record } = await ws.session({
      script: (sandbox) => {
        sandbox.set('memory/MEMORY.md', 'vpn2');
        sandbox.set('memory/people/alice.md', 'on call');
        return DONE;
      },
    });
    expect(record?.status).toBe('completed');
    expect(await ws.files()).toEqual({
      [`${FOLDER}/MEMORY.md`]: 'vpn2',
      [`${FOLDER}/people/alice.md`]: 'on call',
    });
    // Nothing of the memory folder is filed as a run output.
    expect(await ws.files('runs')).toEqual({});
  });

  it.each([
    ['fails', FAILED, 'failed'],
    ['is cancelled', CANCELLED, 'cancelled'],
  ])('writes nothing back for a run that %s', async (_name, frames, status) => {
    const ws = workspace();
    const { record, memoryPaths } = await ws.session({
      script: (sandbox) => {
        sandbox.set('memory/MEMORY.md', 'vpn2');
        return frames;
      },
    });
    expect(record?.status).toBe(status);
    expect(memoryPaths).toEqual([]);
    expect(await ws.files()).toEqual({});
    expect(ws.audits).toEqual([]);
  });

  it(`refuses more than ${String(AGENT_MEMORY_MAX_FILES)} files by name, saving none`, async () => {
    const ws = workspace();
    const { record } = await ws.session({
      script: (sandbox) => {
        for (let index = 0; index <= AGENT_MEMORY_MAX_FILES; index += 1) {
          sandbox.set(`memory/fact-${String(index)}.md`, 'x');
        }
        return DONE;
      },
    });
    expect(record?.status).toBe('failed');
    expect(record?.error).toMatch(new RegExp(`^${AGENT_MEMORY_LIMIT_EXCEEDED}: `, 'u'));
    expect(await ws.files()).toEqual({});
    expect(ws.audits).toEqual([]);
  });

  it(`accepts exactly ${String(AGENT_MEMORY_MAX_FILES)} files`, async () => {
    const ws = workspace();
    const { record } = await ws.session({
      script: (sandbox) => {
        for (let index = 0; index < AGENT_MEMORY_MAX_FILES; index += 1) {
          sandbox.set(`memory/fact-${String(index)}.md`, 'x');
        }
        return DONE;
      },
    });
    expect(record?.status).toBe('completed');
    expect(Object.keys(await ws.files())).toHaveLength(AGENT_MEMORY_MAX_FILES);
  });

  it(`refuses more than ${String(AGENT_MEMORY_MAX_BYTES)} bytes by name, saving none`, async () => {
    const ws = workspace();
    const { record } = await ws.session({
      script: (sandbox) => {
        sandbox.set('memory/MEMORY.md', 'x'.repeat(AGENT_MEMORY_MAX_BYTES / 2));
        sandbox.set('memory/more.md', 'y'.repeat(AGENT_MEMORY_MAX_BYTES / 2 + 1));
        return DONE;
      },
    });
    expect(record?.status).toBe('failed');
    expect(record?.error).toMatch(new RegExp(`^${AGENT_MEMORY_LIMIT_EXCEEDED}: `, 'u'));
    expect(await ws.files()).toEqual({});
  });

  it('writes a local-disk run back from this host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aw-memory-'));
    roots.push(root);
    const ws = workspace();
    const { record } = await ws.session({
      workspaceRoot: root,
      script: async (_sandbox, disk) => {
        if (disk === null) throw new Error('a local-disk run has a directory');
        await writeFile(join(disk, 'memory', 'MEMORY.md'), 'vpn2');
        return DONE;
      },
    });
    expect(record?.status).toBe('completed');
    expect(await ws.files()).toEqual({ [`${FOLDER}/MEMORY.md`]: 'vpn2' });
  });

  it('refuses a memory folder holding a symlink, saving none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aw-memory-'));
    roots.push(root);
    const outside = join(root, 'host-secret.txt');
    await writeFile(outside, 'host secret');
    const ws = workspace();
    const { record } = await ws.session({
      workspaceRoot: root,
      script: async (_sandbox, disk) => {
        if (disk === null) throw new Error('a local-disk run has a directory');
        await writeFile(join(disk, 'memory', 'MEMORY.md'), 'vpn2');
        await symlink(outside, join(disk, 'memory', 'leak.md'));
        return DONE;
      },
    });
    expect(record?.status).toBe('failed');
    expect(await ws.files()).toEqual({});
    expect(ws.audits).toEqual([]);
  });

  it('records one memory-updated row per run that wrote, naming the run and no fact', async () => {
    const ws = workspace();
    const first = await ws.session({ script: writesFact });
    // The same bytes again: nothing is rewritten and no row is recorded.
    const again = await ws.session({ script: writesFact });
    expect(again.record?.status).toBe('completed');
    expect(ws.audits).toEqual([
      {
        workspaceId: WORKSPACE,
        actorPrincipalId: PRINCIPAL,
        actorUserId: '66666666-6666-4666-8666-666666666666',
        actorLabel: `run ${first.runId}`,
        action: 'memory-updated',
        subjectId: AGENT,
        subjectLabel: `run ${first.runId} · 1 written · 0 unchanged · 35 bytes`,
      },
    ]);
    expect(JSON.stringify(ws.audits)).not.toContain('vpn2');
  });

  it("keeps one agent's memory from another agent", async () => {
    const ws = workspace();
    await ws.session({ script: writesFact });
    const other = await ws.session({ script: readsOnly, agentId: OTHER_AGENT });
    expect(other.hydrated.has('memory/MEMORY.md')).toBe(false);
    expect(await ws.files(`memory/${OTHER_AGENT}`)).toEqual({});
  });

  it('keeps no memory for a run whose write switch is off, though memory is set', async () => {
    const ws = workspace();
    await ws.session({ script: writesFact });
    const readOnly = await ws.session({
      script: (sandbox) => {
        sandbox.set('memory/MEMORY.md', 'overwritten');
        return DONE;
      },
      permissions: { ...REMEMBERING, writeFiles: false },
    });
    expect(readOnly.record?.status).toBe('completed');
    expect(readOnly.hydrated.has('memory/MEMORY.md')).toBe(false);
    expect(readOnly.memoryPaths).toEqual([]);
    expect(Object.values(await ws.files())).toEqual(['# Facts\n\n- the VPN gateway is vpn2\n']);
  });
});
