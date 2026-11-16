/**
 * The times compose reads, pinned before it takes a Clock (refactoring plan part 07, step 7): the
 * expiry of a connector identity assertion, and the not-ready retry window of the runner manager
 * client. Only `Date` is faked; the retry's sleeps stay real and short.
 */
import {
  IDENTITY_ASSERTION_HEADER,
  IDENTITY_ASSERTION_TTL_SECONDS,
} from '@indx-workspace/contracts/identity-assertion';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Clock } from '../clock';
import { withIdentityHeaders } from './run-request-tool-connectors';
import { createRuntimeManagerClient } from './runtime-manager-client';

const T0 = new Date('2026-03-01T09:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

it('signs a connector identity that expires a TTL after the current time', async () => {
  const servers = await withIdentityHeaders(
    { crm: { type: 'http', url: 'https://crm.example.test/mcp' } },
    { crm: { connectorId: 'connector-crm', key: 'identity-key' } },
    { sub: 'principal-1', principalKind: 'membership' },
    'workspace-1',
    'run-1',
  );
  const server = servers['crm'];
  const header =
    server !== undefined && 'headers' in server ? server.headers?.[IDENTITY_ASSERTION_HEADER] : '';
  const payload = JSON.parse(
    Buffer.from(String(header).split('.')[0] ?? '', 'base64url').toString('utf8'),
  ) as { exp: number };
  expect(payload.exp).toBe(Math.floor(T0.getTime() / 1000) + IDENTITY_ASSERTION_TTL_SECONDS);
});

it('gives up on a manager that stays not ready once the next wait would pass the window', async () => {
  const starting = () => new Response('The runner manager is starting', { status: 503 });
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(starting()));
  const client = createRuntimeManagerClient(
    'http://manager',
    'runtime-manager-token-0123456789abcdef',
    fetch,
    {
      notReadyRetry: { windowMs: 30, initialDelayMs: 4 },
    },
  );
  // The time stands still, so only the doubling waits (4, 8, 16, 32 ms) reach the 30 ms window.
  await expect(
    client.verify(
      { sessionId: 's', workspacePath: '/workspace', engine: 'claude-agent-sdk' },
      'external',
      'key',
    ),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('reads the retry window from a Clock passed in', async () => {
  const starting = () => new Response('The runner manager is starting', { status: 503 });
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(starting()));
  // Each reading is a minute later than the last, so the window has passed after the first try.
  let time = T0.getTime();
  const clock: Clock = { now: () => new Date((time += 60_000)) };
  const client = createRuntimeManagerClient(
    'http://manager',
    'runtime-manager-token-0123456789abcdef',
    fetch,
    { notReadyRetry: { windowMs: 30, initialDelayMs: 4 }, clock },
  );
  await expect(
    client.verify(
      { sessionId: 's', workspacePath: '/workspace', engine: 'claude-agent-sdk' },
      'external',
      'key',
    ),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
