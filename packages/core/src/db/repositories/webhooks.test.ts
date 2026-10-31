/**
 * The webhook repository against a real PostgreSQL (N-3, issue #250, ADR-SDK-18-N3-250 D1):
 * workspace scoping, the per-workspace cap under concurrency, the stable list order, and the
 * storage checks behind the contract.
 */
import crypto from 'node:crypto';

import { WEBHOOK_MAX_PER_WORKSPACE } from '@indx-workspace/contracts/webhooks';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { workspaces } from '../schema/workspaces.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations } from './violations.js';
import { createDatabaseWebhookRepositoryProvider, type WebhookRepository } from './webhooks.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[repositories/webhooks.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

const ALL = ['run.completed', 'run.failed', 'run.cancelled'] as const;

async function violationOf(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    return [...postgresViolations(error)].map((violation) => violation.constraint);
  }
  throw new Error('expected the statement to be refused');
}

describe.skipIf(!hasDatabase)('WebhookRepository (ADR-SDK-18-N3-250 D1)', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const capWorkspaceId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_webhooks');
    await isolated.db.insert(workspaces).values(
      [workspaceId, otherWorkspaceId, capWorkspaceId].map((id) => ({
        id,
        slug: id,
        name: 'Webhooks',
      })),
    );
  }, 180_000);

  afterAll(async () => isolated.close());

  async function webhooksFor(workspace: string): Promise<WebhookRepository> {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(workspace);
    if (scope === null) throw new Error('workspace did not resolve');
    return createDatabaseWebhookRepositoryProvider(isolated.db).forScope(scope);
  }

  it('creates, reads, lists and removes a webhook in its own workspace only', async () => {
    const mine = await webhooksFor(workspaceId);
    const theirs = await webhooksFor(otherWorkspaceId);

    const created = await mine.create({ url: 'https://hooks.example.com/a', events: ALL });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const { webhook } = created;
    expect(webhook).toMatchObject({
      workspaceId,
      url: 'https://hooks.example.com/a',
      events: [...ALL],
    });
    expect(webhook.createdAt).toBeInstanceOf(Date);

    await expect(mine.get(webhook.id)).resolves.toEqual(webhook);
    await expect(mine.list()).resolves.toEqual([webhook]);
    // Another workspace sees nothing of it and cannot remove it.
    await expect(theirs.get(webhook.id)).resolves.toBeNull();
    await expect(theirs.list()).resolves.toEqual([]);
    await expect(theirs.remove(webhook.id)).resolves.toBe(false);
    await expect(mine.get(webhook.id)).resolves.toEqual(webhook);

    await expect(mine.remove(webhook.id)).resolves.toBe(true);
    await expect(mine.get(webhook.id)).resolves.toBeNull();
    await expect(mine.remove(webhook.id)).resolves.toBe(false);
    await expect(mine.list()).resolves.toEqual([]);
  });

  it('answers a string that is not a UUID as absent, without a query error', async () => {
    const mine = await webhooksFor(workspaceId);
    await expect(mine.get('not-a-uuid')).resolves.toBeNull();
    await expect(mine.remove("'; drop table webhooks; --")).resolves.toBe(false);
  });

  it('lists oldest first, in an order that does not change between reads', async () => {
    const mine = await webhooksFor(workspaceId);
    const ids: string[] = [];
    for (const path of ['one', 'two', 'three']) {
      const created = await mine.create({
        url: `https://hooks.example.com/${path}`,
        events: ['run.failed'],
      });
      if (created.kind !== 'created') throw new Error('create failed');
      ids.push(created.webhook.id);
    }
    const first = (await mine.list()).map(({ id }) => id);
    expect(first).toEqual(ids);
    expect((await mine.list()).map(({ id }) => id)).toEqual(first);
  });

  it('refuses the eleventh webhook, also when the creates race', async () => {
    const capped = await webhooksFor(capWorkspaceId);
    const outcomes = await Promise.all(
      Array.from({ length: WEBHOOK_MAX_PER_WORKSPACE + 3 }, (_, index) =>
        capped.create({ url: `https://hooks.example.com/${String(index)}`, events: ALL }),
      ),
    );
    const kinds = outcomes.map(({ kind }) => kind);
    expect(kinds.filter((kind) => kind === 'created')).toHaveLength(WEBHOOK_MAX_PER_WORKSPACE);
    expect(kinds.filter((kind) => kind === 'limit-reached')).toHaveLength(3);
    expect(await capped.list()).toHaveLength(WEBHOOK_MAX_PER_WORKSPACE);

    // A remove frees a slot.
    const [oldest] = await capped.list();
    if (oldest === undefined) throw new Error('no webhook listed');
    await capped.remove(oldest.id);
    expect(
      (await capped.create({ url: 'https://hooks.example.com/again', events: ALL })).kind,
    ).toBe('created');
    // The cap is per workspace: another workspace is unaffected.
    const other = await webhooksFor(otherWorkspaceId);
    expect((await other.create({ url: 'https://hooks.example.com/b', events: ALL })).kind).toBe(
      'created',
    );
  });

  it('refuses an empty, unknown or oversized events set and an over-long URL in storage', async () => {
    const insert = (values: { url?: string; events?: string[] }) =>
      isolated.db.execute(
        sql`insert into webhooks (workspace_id, url, events) values (${workspaceId}::uuid, ${
          values.url ?? 'https://hooks.example.com/'
        }, ${`{${(values.events ?? ['run.completed']).join(',')}}`}::text[])`,
      );
    expect(await violationOf(insert({ events: [] }))).toContain('webhooks_events_valid');
    expect(await violationOf(insert({ events: ['run.started'] }))).toContain(
      'webhooks_events_valid',
    );
    expect(
      await violationOf(
        insert({ events: ['run.completed', 'run.failed', 'run.cancelled', 'run.failed'] }),
      ),
    ).toContain('webhooks_events_valid');
    expect(await violationOf(insert({ url: `https://h.example/${'a'.repeat(2048)}` }))).toContain(
      'webhooks_url_length',
    );
  });
});
