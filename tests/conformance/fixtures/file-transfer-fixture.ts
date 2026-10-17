/**
 * `tests/conformance/fixtures/file-transfer-fixture.ts` — a fixture driver with
 * `persistentFilesystem: false` that implements `putFiles`/`getFiles` instead, proving scenario 3
 * (`hydrate-and-collect-files`) and scenario 9's `putFiles`/`getFiles` branch for real.
 *
 * §15.3: *"Drivers that can mount a volume do so. Drivers that cannot ... implement
 * `putFiles`/`getFiles` over the runtime HTTP contract instead."* `local`
 * (`fixtures/local-fixture.ts`) and the container fixture (`fixtures/container-fixture.ts`) both
 * exercise the mount path; this fixture is the other half, standing in for a driver shaped like
 * `aca-sessions` or `aws-agentcore` — one with no host-visible workspace path at all, where
 * hydrating and collecting files is the *only* way content moves in or out. Its `putFiles`/
 * `getFiles` never touch `RuntimeHandle.workspacePath` — content lives in an in-memory map keyed
 * by handle id — which is itself part of the proof: a driver like this achieves scenario 9's
 * "concurrent sessions do not see each other's files" simply because there is no shared
 * filesystem location for a second session to reach into.
 */
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { decodeArchive, encodeArchive } from './archive.js';
import { createFixtureStarter, fixtureAgentProbe, ENFORCED_NETWORK } from './common.js';
import type {
  FixtureEvent,
  FixtureFileAccess,
  FixtureFileWrite,
  FixtureRequest,
} from './common.js';
import type {
  A12FileTransferProbe,
  A12Probe,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeDriver,
  RuntimeHandle,
} from '../types.js';

// Small and, like `container-fixture.ts`'s, actually enforced by the starter below via this same
// constant — not a narrative value, and not read back off the capabilities object (that produced
// a `number | undefined` under `exactOptionalPropertyTypes`; a shared constant sidesteps it and
// also makes the two places structurally unable to drift apart). Deliberately different from the
// container fixture's to prove `enforce-resource-limits` reads this field per driver rather than a
// scenario-side constant.
const MAX_SESSION_SECONDS = 2;

export const FILE_TRANSFER_FIXTURE_CAPABILITIES: RuntimeCapabilities = {
  isolation: 'microvm',
  customImage: true,
  persistentFilesystem: false,
  sessionAffinity: false,
  maxSessionSeconds: MAX_SESSION_SECONDS,
  networkPolicies: ['none', 'allowlist', 'open'],
  execCommands: true,
  gpu: false,
  managedByProvider: true,
  typicalStartMs: 1500,
};

export function createFileTransferFixtureDriver(): RuntimeDriver<FixtureRequest, FixtureEvent> {
  const live = new Map<string, RuntimeHandle>();
  /** handle id -> (archive path -> content). Never the same storage as `workspacePath`. */
  const stores = new Map<string, Map<string, string>>();

  // This fixture has no host-visible workspace to translate a `'workspace'`-locus target onto —
  // `resolveMountedTargetPath` (common.ts) is the OTHER kind of fixture's answer, the one with a
  // real mount. Here, a `read-path`/`write-path` action must resolve against the exact same `stores`
  // map `putFiles`/`getFiles` read and write, or a `read-path` probe driven through `startAgent`
  // could never observe what `putFiles` just hydrated (ADR-0046's question, asked of this branch:
  // "does a driver whose sandbox is never actually asked still pass?" — it must not). Isolation
  // falls out of the SAME per-handle keying `putFiles`/`getFiles` already use — a `target.handle`
  // other than the one this sandbox is running as has no store to read here at all, which is this
  // fixture's own honest account of why it passes scenario 9: "there is no shared filesystem
  // location for a second session to reach into" (this file's header). A `'host'`-locus target is
  // refused outright: this driver exposes no host filesystem access whatsoever.
  const fileAccess: FixtureFileAccess = (runtime, target) => {
    if (target.locus === 'host' || target.handle.id !== runtime.id) {
      return Promise.resolve({ succeeded: false });
    }
    const store = stores.get(runtime.id);
    const content = store?.get(target.relativePath);
    return Promise.resolve(
      content === undefined ? { succeeded: false } : { succeeded: true, content },
    );
  };
  const fileWrite: FixtureFileWrite = (runtime, target, content) => {
    if (target.locus === 'host' || target.handle.id !== runtime.id) {
      return Promise.resolve({ succeeded: false });
    }
    const store = stores.get(runtime.id) ?? new Map<string, string>();
    store.set(target.relativePath, content);
    stores.set(runtime.id, store);
    return Promise.resolve({ succeeded: true });
  };
  const startAgent = createFixtureStarter({
    network: ENFORCED_NETWORK,
    fileAccess,
    fileWrite,
    maxSessionSeconds: MAX_SESSION_SECONDS,
  });

  function assertLive(runtime: RuntimeHandle, operation: string): RuntimeHandle {
    const known = live.get(runtime.id);
    if (known === undefined) {
      throw new Error(
        `file-transfer-fixture: cannot ${operation} — handle ${JSON.stringify(runtime.id)} is not live.`,
      );
    }
    return known;
  }

  return {
    id: 'aws-agentcore',
    capabilities: FILE_TRANSFER_FIXTURE_CAPABILITIES,

    async create(config: RuntimeConfig): Promise<RuntimeHandle> {
      // A directory is still made, matching a real managed driver's local scratch space, but
      // scenario 3/9 never write application content into it — only `putFiles`/`getFiles` do,
      // into `stores`, which is the point of this fixture.
      await mkdir(config.workspacePath, { recursive: true });
      const handle: RuntimeHandle = {
        id: randomUUID(),
        driver: 'aws-agentcore',
        externalId: `file-transfer-fixture:${randomUUID()}`,
        workspacePath: config.workspacePath,
        createdAt: new Date(),
      };
      live.set(handle.id, handle);
      stores.set(handle.id, new Map());
      return handle;
    },

    async startAgent(runtime, request) {
      const known = assertLive(runtime, 'start an agent');
      return await startAgent(known, request);
    },

    async destroy(runtime) {
      assertLive(runtime, 'destroy');
      live.delete(runtime.id);
      stores.delete(runtime.id);
      return await Promise.resolve();
    },

    async putFiles(runtime, archive) {
      const known = assertLive(runtime, 'putFiles');
      const entries = await decodeArchive(archive);
      const store = stores.get(known.id) ?? new Map<string, string>();
      for (const entry of entries) {
        store.set(entry.path, entry.content);
      }
      stores.set(known.id, store);
    },

    async getFiles(runtime, paths) {
      const known = assertLive(runtime, 'getFiles');
      const store = stores.get(known.id) ?? new Map<string, string>();
      const archive = encodeArchive(
        paths.map((entryPath) => ({ path: entryPath, content: store.get(entryPath) ?? '' })),
      );
      return await Promise.resolve(archive);
    },
  };
}

export const fileTransferProbe: A12FileTransferProbe = {
  buildArchive: (entryPath, content) => encodeArchive([{ path: entryPath, content }]),
  readArchive: async (archive) => {
    const entries = await decodeArchive(archive);
    return new Map(entries.map((entry) => [entry.path, entry.content] as const));
  },
};

export const fileTransferFixtureProbe: A12Probe<FixtureRequest, FixtureEvent> = {
  agent: fixtureAgentProbe,
  fileTransfer: fileTransferProbe,
};
