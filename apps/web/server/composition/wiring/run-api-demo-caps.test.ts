/**
 * The demo run caps' wiring (`run-api-demo-caps.ts`): the deployment's settings reach the gate, the
 * gate is the run API's `demoRunGate`, a client is keyed the way every per-client limit keys it,
 * and a workspace that is not a demo workspace is never gated.
 * The demo sweep's wiring is here too: an expired demo workspace's files go through the storage
 * service before its rows, the retention setting reaches the lead job, and the maintenance lease
 * is the root's.
 */
import type { DemoCapsRepository } from '@agent-workspace/core/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearClientIdentity, installClientIdentity } from '../../client-identity';
import type { DemoSettings } from '../../settings';
import { createInMemoryObjectStoreProvider } from '../../storage/testing';
import { wireDemoSweep, wireRunDemoCaps } from './run-api-demo-caps';

const WORKSPACE = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-000000000003';
const SECRET = 'a-session-secret-of-at-least-thirty-two-characters';

const SETTINGS: DemoSettings = {
  runsPerPersonPerDay: 20,
  runsPerClientPerDay: 60,
  maxTurnsPerRun: 8,
  maxCostPerRunUsd: 0.5,
  siteMaxCostPerDayUsd: 30,
  leadRetentionDays: null,
};

function gateOver(repository: Partial<DemoCapsRepository>, demo: DemoSettings = SETTINGS) {
  const caps = {
    demoExpiresAt: () => Promise.resolve(new Date('2099-01-01T00:00:00.000Z')),
    admit: () => Promise.resolve('admitted' as const),
    countAdmissionsSince: () => Promise.resolve(0),
    spentOn: () => Promise.resolve({ costUsd: '0', unpricedUsage: false }),
    ...repository,
  } satisfies DemoCapsRepository;
  return wireRunDemoCaps({ root: { demoCaps: caps }, demo } as never).demoRunGate;
}

const start = (headers: Headers | null = new Headers()) => ({
  workspaceId: WORKSPACE,
  userId: USER,
  clientHeaders: headers,
  newRun: true,
});

afterEach(() => clearClientIdentity());

describe('wireRunDemoCaps', () => {
  it('never gates a workspace that is not a demo workspace', async () => {
    const admit = vi.fn();
    const gate = gateOver({ demoExpiresAt: () => Promise.resolve(null), admit });
    expect(await gate.refusal(start())).toBeNull();
    expect(admit).not.toHaveBeenCalled();
  });

  it('refuses demo_caps_unconfigured while a cap the settings leave unset is unset', async () => {
    const gate = gateOver({}, { ...SETTINGS, siteMaxCostPerDayUsd: null });
    expect(await gate.refusal(start())).toEqual({ code: 'demo_caps_unconfigured' });
  });

  it('reads the settings: the person and client limits reach the repository', async () => {
    const admit = vi.fn(() => Promise.resolve('admitted' as const));
    const gate = gateOver(
      { admit },
      { ...SETTINGS, runsPerPersonPerDay: 7, runsPerClientPerDay: 9 },
    );
    await gate.refusal(start());
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, personLimit: 7, clientLimit: 90 }),
    );
  });

  it('keys the client by the proxy-authenticated address, never the address itself', async () => {
    installClientIdentity({ trustedProxyHops: 1, sessionSecret: SECRET });
    const admit = vi.fn(() => Promise.resolve('admitted' as const));
    const gate = gateOver({ admit });
    await gate.refusal(start(new Headers({ 'x-forwarded-for': '203.0.113.7' })));
    await gate.refusal(start(new Headers({ 'x-forwarded-for': '203.0.113.7' })));
    await gate.refusal(start(new Headers({ 'x-forwarded-for': '203.0.113.8' })));
    const calls = admit.mock.calls as unknown as [{ clientKey: string; clientLimit: number }][];
    expect(calls[0]?.[0].clientKey).toBe(calls[1]?.[0].clientKey);
    expect(calls[0]?.[0].clientKey).not.toBe(calls[2]?.[0].clientKey);
    expect(calls[0]?.[0].clientKey).not.toContain('203.0.113.7');
    expect(calls[0]?.[0].clientLimit).toBe(60);
  });

  it('counts a caller with no trusted proxy chain in one shared bucket, ten times as wide', async () => {
    const admit = vi.fn(() => Promise.resolve('admitted' as const));
    const gate = gateOver({ admit });
    await gate.refusal(start(null));
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ clientLimit: 600 }));
  });

  it('fails closed on an unreadable spend: the gate rejects, so the run API refuses the start', async () => {
    const gate = gateOver({ spentOn: () => Promise.reject(new Error('database down')) });
    await expect(gate.refusal(start())).rejects.toThrow('database down');
  });
});

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

function sweepWiredOver(options: { storage?: boolean; events: string[]; demo?: DemoSettings }) {
  const { events } = options;
  const lease = { release: () => Promise.resolve() };
  return {
    root: {
      demoSweep: {
        expiredWorkspaceIds: () => Promise.resolve(['expired-workspace']),
        deleteExpiredWorkspace: () => Promise.resolve(void events.push('rows')).then(() => true),
        deleteLoginTokensBefore: () => Promise.resolve(0),
        deleteAdmissionsBefore: () => Promise.resolve(0),
        deleteIdleGuestUsersBefore: () => Promise.resolve(0),
      },
      storeLeads: {
        recordContact: () => Promise.resolve(),
        deleteLastContactBefore: (cutoff: Date) => {
          events.push(`leads before ${cutoff.toISOString()}`);
          return Promise.resolve(3);
        },
      },
      tryAcquireMaintenanceLease: (name: string) => {
        events.push(`lease ${name}`);
        return Promise.resolve(lease);
      },
    },
    demo: options.demo ?? { ...SETTINGS, leadRetentionDays: 30 },
    filesRuntime:
      options.storage === false
        ? null
        : {
            storage: {
              list: (_ctx: unknown, area: string) =>
                Promise.resolve({
                  rows: area === 'files' ? [{ path: 'seed/orders.csv' }] : [],
                  cursor: null,
                }),
              remove: (_ctx: unknown, _area: string, path: string) => {
                events.push(`file ${path}`);
                return Promise.resolve({ ok: true as const });
              },
            },
          },
  } as unknown as Parameters<typeof wireDemoSweep>[0];
}

describe('wireDemoSweep: what the catalog does not list', () => {
  it('leaves no object behind for an expired workspace with a session-state blob and a pending upload', async () => {
    const objects = createInMemoryObjectStoreProvider();
    const store = objects.forWorkspace('expired-workspace');
    const bytes = new Uint8Array([1]);
    const options = { contentType: 'application/octet-stream' };
    await store.write('files/ready-file', bytes, options);
    await store.write('files/pending-upload', bytes, options);
    await store.write('session-state/blob', bytes, options);
    const events: string[] = [];
    const wired = sweepWiredOver({ events });
    const bystander = objects.forWorkspace('live-workspace');
    await bystander.write('files/keep', bytes, options);

    const result = await wireDemoSweep(
      {
        ...wired,
        // The catalog lists only the ready file, as the storage service does.
        filesRuntime: { ...(wired.filesRuntime as object), store: objects },
      },
      log,
    )();

    expect(result.workspacesDeleted).toBe(1);
    expect((await store.listPage('', { recursive: true })).entries).toEqual([]);
    expect((await bystander.listPage('', { recursive: true })).entries).toHaveLength(1);
  });
});

describe('wireDemoSweep', () => {
  it('removes the files through the storage service, then the rows, under the maintenance lease', async () => {
    const events: string[] = [];
    const result = await wireDemoSweep(sweepWiredOver({ events }), log)();
    expect(events.slice(0, 3)).toEqual(['lease demo-sweep', 'file seed/orders.csv', 'rows']);
    expect(result.workspacesDeleted).toBe(1);
  });

  it('deletes the rows of a deployment with no file storage', async () => {
    const events: string[] = [];
    const result = await wireDemoSweep(sweepWiredOver({ events, storage: false }), log)();
    expect(result.workspacesDeleted).toBe(1);
    expect(events).toContain('rows');
  });

  it('runs the lead job with the configured retention, and not while it is unset', async () => {
    const set: string[] = [];
    const swept = await wireDemoSweep(sweepWiredOver({ events: set }), log)();
    expect(swept.leadsDeleted).toBe(3);
    expect(set.find((event) => event.startsWith('leads before'))).toBeDefined();

    const unset: string[] = [];
    const skipped = await wireDemoSweep(
      sweepWiredOver({ events: unset, demo: { ...SETTINGS, leadRetentionDays: null } }),
      log,
    )();
    expect(skipped.leadsDeleted).toBeNull();
    expect(unset.some((event) => event.startsWith('leads before'))).toBe(false);
  });
});
