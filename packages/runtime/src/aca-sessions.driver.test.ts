import { describe, expect, it } from 'vitest';

import { createAcaSessionsCapabilities } from './aca-sessions.js';
import type { AcaSessionsClient } from './aca-sessions.js';
import { CONFIG, echoConnection, fakeClient, poolDriver } from './aca-sessions.test-support.js';

describe('aca-sessions runtime driver', () => {
  it('advertises only the network policy the registered pool can enforce', () => {
    expect(createAcaSessionsCapabilities('EgressDisabled')).toMatchObject({
      isolation: 'microvm',
      persistentFilesystem: false,
      networkPolicies: ['none'],
      gpu: false,
      managedByProvider: true,
    });
    expect(createAcaSessionsCapabilities('EgressEnabled').networkPolicies).toEqual(['open']);
  });

  it('allocates a ready session and binds startAgent to authenticated session access', async () => {
    const { client, allocated } = fakeClient();
    const driver = poolDriver(client, {
      startAgent: (runtime, request, access) =>
        echoConnection(`${access.requestUrl('/run')}:${runtime.externalId}:${request}`),
    });

    const handle = await driver.create(CONFIG);
    expect(allocated).toEqual([handle.externalId]);
    expect(handle).toMatchObject({
      driver: 'aca-sessions',
      workspacePath: CONFIG.workspacePath,
      createdAt: new Date('2026-09-11T00:00:00.000Z'),
      expiresAt: new Date('2026-09-11T00:10:00.000Z'),
    });
    expect(await driver.isLive(handle)).toBe(true);

    const connection = await driver.startAgent(handle, 'request');
    const events: string[] = [];
    for await (const event of connection.events) events.push(event);
    expect(events).toEqual([
      `https://pool.example/run?identifier=${handle.externalId}:${handle.externalId}:request`,
    ]);
  });

  it('accepts a prederived identifier and keeps destroy idempotent', async () => {
    const { client, stopped } = fakeClient();
    const driver = poolDriver(client, {
      identifierForConfig: () => 'manager-derived-id',
    });
    const handle = await driver.create(CONFIG);
    expect(handle.externalId).toBe('manager-derived-id');

    await driver.destroy(handle);
    await driver.destroy(handle);
    expect(stopped).toEqual(['manager-derived-id', 'manager-derived-id']);
    expect(await driver.isLive(handle)).toBe(false);
  });

  it('surfaces a failed rollback instead of leaking a billed session silently', async () => {
    const { client } = fakeClient();
    client.getSession = () => Promise.reject(new Error('metadata unavailable'));
    client.stopSession = () => Promise.reject(new Error('stop denied'));
    const driver = poolDriver(client);
    await expect(driver.create(CONFIG)).rejects.toThrow(
      /metadata unavailable.*also failed \(stop denied\)/u,
    );
  });

  it('stops an allocated session if post-readiness metadata cannot be retrieved', async () => {
    const { client, stopped } = fakeClient();
    client.getSession = () => Promise.reject(new Error('metadata unavailable'));
    const driver = poolDriver(client);

    await expect(driver.create(CONFIG)).rejects.toThrow(/metadata unavailable/u);
    expect(stopped).toHaveLength(1);
  });
});

describe('aca-sessions runtime: one engine per pool (ENG-07, ADR-0073 D6)', () => {
  function poolFor(engine: string, client: AcaSessionsClient) {
    return poolDriver(client, {
      engine,
      startAgent: (runtime, request) => echoConnection(`${runtime.externalId}:${request}`),
    });
  }

  it("serves a run for the pool's own engine, for either of two engines", async () => {
    for (const engine of ['claude-agent-sdk', 'pi']) {
      const { client, allocated } = fakeClient();
      await poolFor(engine, client).create({ ...CONFIG, engine });
      expect(allocated).toHaveLength(1);
    }
  });

  it("refuses another engine's run before an allocation is made", async () => {
    const { client, allocated } = fakeClient();
    await expect(poolFor('pi', client).create(CONFIG)).rejects.toThrow(
      /carries engine "pi".*"claude-agent-sdk"/u,
    );
    expect(allocated).toHaveLength(0);
  });
});
