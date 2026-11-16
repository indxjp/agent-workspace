/**
 * The times and ids the Builder's shell and transport mint, pinned before they take a Clock and an
 * IdGenerator (refactoring plan part 07, step 8): a repeated call id's journal suffix, an external
 * call's run id, and the owner-warning trust window on the default clock. Only `Date` is faked.
 */
import crypto from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { counterIds } from '../ids';
import type { DirectoryRoot } from '../rbac/directory';
import { handleToolCall } from './shell';
import { callContextOf } from './testing/context';
import { makeMemoryPorts } from './testing/ports';
import { createAllowedOwnerWarning, OWNER_OK_TTL_MS } from './transport/allowed-owner-warning';
import { toExternalCallContext, type ExternalPrincipal } from './transport/external';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

afterEach(() => {
  vi.useRealTimers();
});

describe('ids the Builder mints', () => {
  it('journals a repeated call id again under the id plus a fresh uuid', async () => {
    const ports = makeMemoryPorts();
    const record = vi.spyOn(ports.audit, 'record');
    const ctx = callContextOf(crypto.randomUUID(), 'builder');
    const call = { name: 'catalog_list', arguments: { unknown: 'x' }, callId: 'call-1' };

    await handleToolCall(call, ctx, ports);
    await handleToolCall(call, ctx, ports);

    const ids = record.mock.calls.map(([, entry]) => entry.callId);
    expect(ids[0]).toBe('call-1');
    expect(ids).toHaveLength(3);
    const [prefix, suffix] = (ids[2] ?? '').split(/:(.*)/su);
    expect(prefix).toBe('call-1');
    expect(suffix).toMatch(UUID);
  });

  it("suffixes a repeated call id from the ports' id generator", async () => {
    const ports = makeMemoryPorts({ ids: counterIds() });
    const record = vi.spyOn(ports.audit, 'record');
    const ctx = callContextOf(crypto.randomUUID(), 'builder');
    const call = { name: 'catalog_list', arguments: { unknown: 'x' }, callId: 'call-1' };
    await handleToolCall(call, ctx, ports);
    await handleToolCall(call, ctx, ports);
    expect(record.mock.calls[2]?.[1].callId).toBe('call-1:00000000-0000-4000-8000-000000000001');
  });

  it('names an external call with no bounded session ext:<uuid>', () => {
    const principal = {
      via: 'oauth-token',
      oauth: null,
      scope: null,
      workspaceId: 'ws-1',
      principalId: 'principal-1',
    } as unknown as ExternalPrincipal;
    const ctx = toExternalCallContext(principal, new Headers());
    expect(ctx.runId.slice(0, 4)).toBe('ext:');
    expect(ctx.runId.slice(4)).toMatch(UUID);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/u);
  });
});

describe('the owner warning on the default clock', () => {
  it('trusts a fine owner for the TTL from the current time, then asks again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
    const findMembershipByPrincipal = vi.fn((principalId: string) =>
      Promise.resolve({ principalId, role: 'owner' }),
    );
    const directory = {
      forWorkspace: () => ({ findMembershipByPrincipal }),
    } as unknown as Pick<DirectoryRoot, 'forWorkspace'>;
    const warning = createAllowedOwnerWarning({ directory, warn: vi.fn() });
    const agent = { id: 'agent-1', ownerPrincipalId: 'principal-1' };

    await warning('ws-1', agent);
    vi.setSystemTime(Date.now() + OWNER_OK_TTL_MS - 1);
    await warning('ws-1', agent);
    expect(findMembershipByPrincipal).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    await warning('ws-1', agent);
    expect(findMembershipByPrincipal).toHaveBeenCalledTimes(2);
  });
});
