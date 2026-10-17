/**
 * The secret-name encoding `connections.ts` uses to recover a runtime connection's driver from
 * `secrets.name` without decrypting anything — see that file's header for why this exists — plus
 * the three round-2 repair regressions (W3-CP-06-B1, B2, B3).
 */
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createInMemoryRuntimeConnectionStoreProvider,
  createSecretsRuntimeConnectionStoreProvider,
  type RuntimeConnectionSecretsPort,
} from './connections';

/** A `RuntimeConnectionSecretsPort` fake, scoped by `WorkspaceScope.workspaceId` — no I/O. */
function fakeSecretsPort(): {
  port: RuntimeConnectionSecretsPort;
  seed: (workspaceId: string, name: string) => void;
} {
  const rows: { id: string; workspaceId: string; name: string; createdAt: Date }[] = [];
  let nextId = 0;
  return {
    port: {
      list: (scope) => Promise.resolve(rows.filter((row) => row.workspaceId === scope.workspaceId)),
      create: (scope, input) => {
        nextId += 1;
        const row = {
          id: String(nextId),
          workspaceId: scope.workspaceId,
          name: input.name,
          createdAt: new Date(),
        };
        rows.push(row);
        return Promise.resolve({ kind: 'created', secret: row });
      },
    },
    seed: (workspaceId: string, name: string): void => {
      nextId += 1;
      rows.push({ id: String(nextId), workspaceId, name, createdAt: new Date() });
    },
  };
}

const SCOPES = createInMemoryWorkspaceScopeResolver([{ id: 'workspace-a', slug: 'workspace-a' }]);

describe('runtime-connection secret-name encoding', () => {
  it('recovers the driver from the encoded secret name, for every §14.2 driver id', () => {
    const drivers = ['docker', 'kubernetes', 'cloud-run-sandbox', 'aca-sessions', 'external'];
    const { port } = fakeSecretsPort();
    const provider = createSecretsRuntimeConnectionStoreProvider({ secrets: port, scopes: SCOPES });
    const store = provider.forWorkspace('workspace-a');

    return Promise.all(
      drivers.map((driver) =>
        store.create({
          name: `${driver} connection`,
          driver,
          endpoint: 'https://x',
          credential: 'y',
        }),
      ),
    ).then(async () => {
      const listed = await store.list();
      expect(listed.map((c) => c.driver).sort()).toEqual([...drivers].sort());
    });
  });

  it('never lets an unrelated secret with no reserved prefix appear as a connection', async () => {
    const { port, seed } = fakeSecretsPort();
    seed('workspace-a', 'ANTHROPIC_API_KEY');
    const provider = createSecretsRuntimeConnectionStoreProvider({ secrets: port, scopes: SCOPES });
    const listed = await provider.forWorkspace('workspace-a').list();
    expect(listed).toEqual([]);
  });

  /**
   * W3-CP-06-B3, declared and carried, not fixed this round: the partition is a naming
   * CONVENTION, not a structural boundary, because `/api/secrets`'s own `parseSecretName`
   * (outside this task's `Owns` glob) admits the reserved prefix verbatim. This test drives the
   * name a real `/api/secrets` caller can actually produce — never `ANTHROPIC_API_KEY`, which
   * could not collide under any prefix scheme and proved nothing — and pins the CURRENT, honestly
   * documented behaviour so a future fix (in `apps/web/server/secrets/**`) has a failing test to
   * turn green, instead of a silently-regressed claim of safety.
   */
  it('W3-CP-06-B3 (carried): cannot tell a forged, same-shaped secret from a genuine connection', async () => {
    const { port, seed } = fakeSecretsPort();
    // The exact shape a caller with only /api/secrets access can produce today — a name
    // `parseSecretName`'s `^[A-Z][A-Z0-9_]{0,127}$` accepts, carrying no proof its value is
    // `{endpoint, credential}` JSON.
    seed('workspace-a', 'RUNTIME_CONNECTION__DOCKER__FORGED');
    const provider = createSecretsRuntimeConnectionStoreProvider({ secrets: port, scopes: SCOPES });
    const listed = await provider.forWorkspace('workspace-a').list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.driver).toBe('docker');
  });

  it("refuses a value the secret store cannot store, and reports it as this route's own conflict", async () => {
    const provider = createInMemoryRuntimeConnectionStoreProvider();
    const store = provider.forWorkspace('workspace-a');
    // A label containing only characters outside the encoding's alphabet — e.g. purely
    // punctuation-and-space, which collapses to something with no leading letter, refusing the
    // shape `secrets.name`'s own CHECK constraint requires.
    const outcome = await store.create({
      name: '123',
      driver: 'docker',
      endpoint: 'https://x',
      credential: 'y',
    });
    expect(outcome.kind).toBe('name-conflict');
  });
});

/**
 * W3-CP-06-B1: the exact integrator call `runtime.ts` and
 * `docs/adr/W3-CP-06-agents-runtime-profile-id-and-the-integrator-call.md` name, built with a
 * real, encrypting `SecretsService` (`createInMemorySecretsService` — real AES-256-GCM, no
 * PostgreSQL required) and a real `WorkspaceScopeResolver`. Round 1's equivalent did not
 * type-check at all (`SecretsService` is not assignable to a dependencies shape that took
 * `{ secrets, scopeFor }`) and its only writable variant threw `ForgedWorkspaceScopeError` at the
 * first request. This test is that seam, wired the way the integrator is told to wire it, driven
 * through an HTTP-shaped create-then-list — if this file does not compile, the whole suite does
 * not compile, which is the strongest form "the exact call compiles" can take in a test.
 */
describe('W3-CP-06-B1: the integrator call, wired for real and driven end to end', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * W3-CP-06-B2 (round-3 repair). Round 2's version of this test compared `list()`'s
   * `createdAt` only to `create()`'s own return value — both minted by `connections.ts` itself,
   * never to the secret's OWN metadata (ADR-0046 rule 1: the value must cross the boundary the
   * gate polices). Reverting `list()` to fabricate `createdAt: new Date()` passed that comparison
   * 3 of 5 runs, because both sides were "now" and a fast run had not let the clock tick between
   * `create()` and `list()` — a probe whose verdict depends on real wall-clock timing (ADR-0047).
   *
   * This version fixes both defects at once with `vi.useFakeTimers()`: `create()` runs at a fixed
   * instant this test controls, the clock is then moved forward by a year before anything reads
   * the connection back, and the assertion is against `secretsService.list(scope)`'s OWN
   * `SecretMetadata.createdAt` — read directly, bypassing `connections.ts`'s `list()` entirely —
   * not against `create()`'s return value. An implementation that fabricates `createdAt` at read
   * time (any `new Date()` call inside `list()`) now reports the moved-forward instant, which can
   * never equal the fixed instant `create()` actually stored, on any machine, every run.
   */
  it('POST then GET round-trips through createSecretsRuntimeConnectionStoreProvider({ secrets: secretsService, scopes }), and createdAt is the secret’s own stored timestamp, not one minted at read time', async () => {
    const secretsService = createInMemorySecretsService();
    const provider = createSecretsRuntimeConnectionStoreProvider({
      secrets: secretsService, // a real SecretsService, not an adapter written for this test
      scopes: SCOPES,
    });
    const store = provider.forWorkspace('workspace-a');

    const scope = await SCOPES.forWorkspaceId('workspace-a');
    if (scope === null) throw new Error('test setup: workspace-a must resolve to a scope');

    const creationInstant = new Date('2020-01-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(creationInstant);

    const created = await store.create({
      name: 'Primary Docker host',
      driver: 'docker',
      endpoint: 'tcp://docker.internal:2376',
      credential: 'super-secret-client-cert',
    });
    expect(created.kind).toBe('created');

    // Move the clock forward before reading anything back — see this test's header comment.
    vi.setSystemTime(new Date('2021-06-15T00:00:00.000Z'));

    // The ground truth, read directly off the secrets service — never through connections.ts.
    const trueSecrets = await secretsService.list(scope);
    expect(trueSecrets).toHaveLength(1);

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    const connection = listed[0];
    expect(connection?.driver).toBe('docker');
    // W3-CP-06-B2: create() and list() agree on `name`.
    if (created.kind === 'created') {
      expect(connection?.name).toBe(created.connection.name);
    }
    // The value under test must equal the instant actually stored, never the instant `list()`
    // happened to run at (2021, not 2020) and never a value that merely isn't zero.
    expect(connection?.createdAt).toEqual(creationInstant);
    expect(connection?.createdAt).toEqual(trueSecrets[0]?.createdAt);
  });

  it('an unknown workspace id rejects with UnknownWorkspaceError, not a forged-scope throw', async () => {
    const secretsService = createInMemorySecretsService();
    const provider = createSecretsRuntimeConnectionStoreProvider({
      secrets: secretsService,
      scopes: SCOPES,
    });
    await expect(provider.forWorkspace('no-such-workspace').list()).rejects.toThrow(
      /no workspace has id no-such-workspace/u,
    );
  });
});

/**
 * W3-CP-06-B2: the in-memory store (what `routes.test.ts` drives) and the secrets-backed store
 * (what a real deployment drives) must agree on what `name` and `createdAt` mean, or a route's own
 * tests can be green while the real backend answers something else — exactly what round 1 shipped.
 */
describe('W3-CP-06-B2: the in-memory store agrees with the secrets-backed store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Round-3 repair: round 2's `createdAt` assertions here were `expect(...getTime()).not.toBe(0)`
   * — a check that only excludes the one specific wrong constant round 1 shipped, which ADR-0015
   * names as a gate deciding on the absence of a negative rather than a positive assertion (an
   * implementation returning `new Date(1)` passed it). Fixed the same way as the B1 test above:
   * fake timers force a real gap between `create()`'s instant and `list()`'s, so a value fabricated
   * at read time is deterministically wrong, not merely nonzero.
   */
  it('both stores return the stored, encoded name AND the stored creation instant from create() and from a later list(), never one minted at read time', async () => {
    const input = {
      name: 'Primary Docker host',
      driver: 'docker',
      endpoint: 'tcp://docker.internal:2376',
      credential: 'super-secret-client-cert',
    } as const;

    const secretsService = createInMemorySecretsService();
    const scope = await SCOPES.forWorkspaceId('workspace-a');
    if (scope === null) throw new Error('test setup: workspace-a must resolve to a scope');

    const creationInstant = new Date('2020-02-02T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(creationInstant);

    const memoryStore = createInMemoryRuntimeConnectionStoreProvider().forWorkspace('workspace-a');
    const memoryCreated = await memoryStore.create(input);

    const secretsStore = createSecretsRuntimeConnectionStoreProvider({
      secrets: secretsService,
      scopes: SCOPES,
    }).forWorkspace('workspace-a');
    const secretsCreated = await secretsStore.create(input);

    // Move the clock forward before reading anything back — see the B1 test's header comment.
    vi.setSystemTime(new Date('2022-09-09T00:00:00.000Z'));

    const memoryListed = await memoryStore.list();
    const secretsListed = await secretsStore.list();
    // The ground truth for the secrets-backed side, read directly off the secrets service.
    const trueSecrets = await secretsService.list(scope);

    expect(memoryCreated.kind).toBe('created');
    expect(secretsCreated.kind).toBe('created');
    if (memoryCreated.kind !== 'created' || secretsCreated.kind !== 'created') return;

    // create() is a separate boundary from list(): the production secrets-backed provider must
    // return the instant the secret service stored, not a timestamp fabricated for the POST
    // response. Keep this assertion alongside the list assertions so repairing one boundary
    // cannot silently delete coverage of its sibling (ADR-0048).
    expect(memoryCreated.connection.createdAt).toEqual(creationInstant);
    expect(secretsCreated.connection.createdAt).toEqual(creationInstant);
    expect(secretsCreated.connection.createdAt).toEqual(trueSecrets[0]?.createdAt);

    // Same input, same encoding, same stored name — from create() and from list() — in both
    // implementations. Neither returns the caller's raw display string.
    expect(memoryCreated.connection.name).toBe('RUNTIME_CONNECTION__DOCKER__PRIMARY_DOCKER_HOST');
    expect(secretsCreated.connection.name).toBe(memoryCreated.connection.name);
    expect(memoryListed[0]?.name).toBe(memoryCreated.connection.name);
    expect(secretsListed[0]?.name).toBe(secretsCreated.connection.name);

    // Neither implementation fabricates a timestamp at read time: both must report the ONE fixed
    // instant create() actually ran at, never the moved-forward instant list() ran at.
    expect(memoryListed[0]?.createdAt).toEqual(creationInstant);
    expect(secretsListed[0]?.createdAt).toEqual(creationInstant);
    expect(secretsListed[0]?.createdAt).toEqual(trueSecrets[0]?.createdAt);
  });
});
