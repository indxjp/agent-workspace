/**
 * What `run-files.load.test.ts` and its negative control `run-files-buffering-control.test.ts`
 * share: the run size, the memory bound, a member on either catalog, and a run granted a folder of
 * files written before any baseline is taken. Vitest-free, so each file owns its own database.
 */
import { openRootObjectStore } from '@agent-workspace/core/storage';
import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';

import { createAgentRunResourceLoader } from '../compose/resource-loader';
import { createRuntimeWorkspaceLifecycle } from '../compose/workspace-lifecycle';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';
import { createStorageService, type StorageContext } from '../storage/service';
import type { LaunchContext } from './environment';

const MiB = 1024 * 1024;

/** The done-when bound (the storage design, §06 Phase 4): server memory grows by less than this. */
export const RSS_BOUND = 64 * MiB;

/**
 * The run's files: the run limit, 128 MiB, at every size setting. A buffered archive of 112 MiB read
 * as little as 76 MiB on Windows (the working set gives pages back while it is built), too close to
 * {@link RSS_BOUND}; at the limit the negative control clears it by a wide margin. Each catalog's
 * case still takes about 2 s, so `AW_LOAD_TESTS=1` changes nothing here.
 */
export const TOTAL_BYTES = RUN_FILES_MAX_BYTES;

const FILES = 8;

export const RUN_ID = '11111111-1111-4111-8111-111111111111';
export const SESSION_ID = '44444444-4444-4444-8444-444444444444';
export const AGENT_ID = '33333333-3333-4333-8333-333333333333';

export interface Member {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string | null;
}

export interface World {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly member: Member;
}

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

/** A member with fresh ids; each test file seeds it into its catalog (a user only on PostgreSQL). */
export function newMember(userId: string | null = null): Member {
  return { workspaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), userId };
}

/**
 * `bytes` of one reused 1 MiB chunk, so writing the files leaves no garbage behind that a buffering
 * consumer could later reuse without growing the process (which would hide it from the control).
 */
function repeatedBody(bytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(MiB).fill(7);
  let left = bytes;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left === 0) {
        controller.close();
        return;
      }
      const size = Math.min(left, chunk.byteLength);
      controller.enqueue(chunk.subarray(0, size));
      left -= size;
    },
  });
}

/** `FILES` ready rows under a granted folder `big`, written before any baseline is taken. */
export async function grantedRun(world: World, root: string) {
  const objects = await openRootObjectStore({ kind: 'file', root });
  const storage = createStorageService({
    catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
    objects,
    log: noLog,
  });
  const ctx: StorageContext = {
    workspaceId: world.member.workspaceId,
    principalId: world.member.principalId,
    userId: world.member.userId,
  };
  const folder = await storage.createFolder(ctx, 'big');
  if (!folder.ok) throw new Error(`folder refused: ${folder.code}`);
  for (let index = 0; index < FILES; index += 1) {
    const saved = await storage.save(ctx, {
      area: 'files',
      path: `big/part-${String(index)}.bin`,
      body: repeatedBody(TOTAL_BYTES / FILES),
      maxBytes: RUN_FILES_MAX_BYTES,
      replace: true,
    });
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
  }
  const loader = createAgentRunResourceLoader({ catalog: world.catalogs, storage });
  const assignments = {
    files: [{ fileId: folder.row.id, access: 'read' as const }],
    skillIds: [],
    connectorIds: [],
  };
  const lifecycle = createRuntimeWorkspaceLifecycle({
    resources: loader,
    granted: () => loader.load(world.member.workspaceId, assignments),
    storage,
  });
  const context = {
    run: { id: RUN_ID },
    agent: { id: AGENT_ID, workspaceId: world.member.workspaceId },
    session: { id: SESSION_ID, agentId: AGENT_ID },
    principal: {
      principalId: world.member.principalId,
      ownerPrincipalId: world.member.principalId,
      userId: world.member.userId,
      workspaceId: world.member.workspaceId,
      scope: null,
    },
    prompt: 'summarise',
  } as unknown as LaunchContext;
  return { loader, lifecycle, context, assignments };
}
