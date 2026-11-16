/**
 * The storage service reads the time from its `clock` and takes an id from its `ids` when a request
 * names no occurrence for its audit key (refactoring plan part 10, step 4). Production passes
 * neither and gets the system clock and random ids.
 */
import { createInMemoryCatalog } from '@agent-workspace/core/db/unscoped';
import { createInMemoryObjectStore, type ObjectStore } from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';
import { describe, expect, it } from 'vitest';

import { fixedClock, type Clock } from '../clock';
import { counterIds, type IdGenerator } from '../ids';
import { createStorageService, type StorageAuditEvent, type StorageContext } from './service';
import { auditKey } from './service-policy';

const noLog: Logger = { info() {}, warn() {}, error() {}, child: () => noLog };

function harness(time: { readonly clock?: Clock; readonly ids?: IdGenerator } = {}) {
  const catalogs = createInMemoryCatalog();
  const inner = createInMemoryObjectStore();
  const objects: ObjectStore = {
    ...inner,
    capabilities: { ...inner.capabilities, sign: true, boundLengthSign: true },
    createSignedUrl: (key) => Promise.resolve({ url: `https://store.invalid/${key}`, headers: {} }),
  };
  const events: StorageAuditEvent[] = [];
  const storage = createStorageService({
    catalog: (workspaceId) => Promise.resolve(catalogs.forWorkspace(workspaceId)),
    objects,
    log: noLog,
    audit: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    ...time,
  });
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const ctx: StorageContext = {
    workspaceId,
    principalId,
    userId: null,
    actor: { principalId, userId: null, label: 'Ito' },
  };
  const mint = (path: string) =>
    storage.reserveUpload(ctx, { path, sizeBytes: 3, mayReplace: () => Promise.resolve(true) });
  return { storage, events, ctx, mint, catalog: catalogs.forWorkspace(workspaceId) };
}

describe('the storage service takes the time and ids it is given', () => {
  it('signs an upload link from the clock’s time', async () => {
    const clock = fixedClock('2026-11-12T00:00:00.000Z');
    const h = harness({ clock });

    const first = await h.mint('a.txt');
    clock.advance(60 * 60 * 1000);
    const second = await h.mint('b.txt');

    if (!first.ok || !second.ok) throw new Error('a mint was refused');
    const lifetime = first.expiresAt.getTime() - Date.parse('2026-11-12T00:00:00.000Z');
    expect(lifetime).toBeGreaterThan(0);
    expect(second.expiresAt.getTime() - first.expiresAt.getTime()).toBe(60 * 60 * 1000);
  });

  it('keys an audit row with no occurrence by the next id', async () => {
    const h = harness({ ids: counterIds() });

    const minted = await h.mint('a.txt');

    if (!minted.ok) throw new Error('the mint was refused');
    const pending = await h.catalog.pending('a.txt');
    if (pending === null) throw new Error('no pending row');
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.id).toBe(
      auditKey([h.ctx.workspaceId, 'file-link-created', pending.id, counterIds().newId()]),
    );
  });

  it('uses the system clock and random ids when given neither', async () => {
    const h = harness();
    const before = Date.now();

    const first = await h.mint('a.txt');
    const second = await h.mint('b.txt');

    if (!first.ok || !second.ok) throw new Error('a mint was refused');
    expect(first.expiresAt.getTime()).toBeGreaterThan(before);
    expect(h.events.map((event) => event.id)).toHaveLength(2);
    expect(new Set(h.events.map((event) => event.id)).size).toBe(2);
  });
});
