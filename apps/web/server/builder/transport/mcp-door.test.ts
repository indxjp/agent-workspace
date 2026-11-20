import { describe, expect, it, vi } from 'vitest';

import { BUILDER_DOOR_RATE_LIMITS } from './limits';
import { createBuilderCallerVerifier, serveBuilderMcp, type BuilderCallerVerifier } from './mcp';
import {
  CALLER,
  allow,
  call,
  door,
  readOnly,
  refuse,
  resetDoorAfterEach,
  rpc,
  spyPorts,
  unreadableVerifier,
} from './mcp.test-support';

resetDoorAfterEach();

describe('rate limit per run (SEC-14)', () => {
  const { callsPerMinutePerRun } = BUILDER_DOOR_RATE_LIMITS;
  const listing = (verifyCaller: BuilderCallerVerifier) =>
    serveBuilderMcp(rpc(call('tools/list')), door(verifyCaller));
  const otherRun: BuilderCallerVerifier = () =>
    Promise.resolve({ ...CALLER, caller: { ...CALLER.caller, runId: 'run-other' } });

  it('pins the limit at 120 requests a minute', () => {
    expect(BUILDER_DOOR_RATE_LIMITS).toEqual({ callsPerMinutePerRun: 120 });
  });

  it('answers 429 builder_rate_limited with Retry-After once a run passes the limit, whoever its caller is', async () => {
    for (let sent = 0; sent < callsPerMinutePerRun; sent += 1) {
      expect((await listing(allow)).status).toBe(200);
    }
    const limited = await listing(allow);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(await limited.json()).toMatchObject({ error: { code: 'builder_rate_limited' } });
    // A reads-only run is counted under the same run id as the person's.
    expect((await listing(readOnly)).status).toBe(429);
  });

  it('admits a run again once a minute has passed on the clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
      for (let sent = 0; sent <= callsPerMinutePerRun; sent += 1) await listing(allow);
      expect((await listing(allow)).status).toBe(429);
      vi.setSystemTime(Date.now() + 61_000);
      expect((await listing(allow)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts per run: another run is still admitted', async () => {
    for (let sent = 0; sent <= callsPerMinutePerRun; sent += 1) await listing(allow);
    expect((await listing(allow)).status).toBe(429);
    expect((await listing(otherRun)).status).toBe(200);
  });

  it('counts nothing for a token that does not verify, and refuses it first', async () => {
    for (let sent = 0; sent <= callsPerMinutePerRun; sent += 1) {
      expect((await listing(refuse)).status).toBe(403);
    }
    expect((await listing(allow)).status).toBe(200);
  });
});

describe('the real verifier behind the door', () => {
  const verifyCaller = unreadableVerifier();

  for (const [label, headers] of [
    ['a request with only a session cookie', { authorization: '', cookie: 'aw_session=abc' }],
    ['an API key', { authorization: 'Bearer ak_live_0123456789' }],
    ['an unsigned bearer', { authorization: 'Bearer not-a-run-token' }],
  ] as const) {
    it(`refuses ${label} with 403 not_permitted`, async () => {
      const request = rpc(call('tools/list'), headers);
      if (headers.authorization === '') request.headers.delete('authorization');
      const response = await serveBuilderMcp(request, door(verifyCaller));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'not_permitted' } });
    });
  }

  it.each([
    ['no credential', { authorization: '' }],
    ['a session cookie', { authorization: '', cookie: 'aw_session=abc' }],
    ['an API key', { authorization: 'Bearer ak_live_0123456789' }],
    ['an unsigned bearer', { authorization: 'Bearer not-a-run-token' }],
  ])(
    'refuses a draft_save with %s before any port, and writes nothing',
    async (_label, headers) => {
      const { ports, reached, journalled } = spyPorts();
      const request = rpc(
        call('tools/call', {
          name: 'draft_save',
          arguments: { body: {} },
          _meta: { 'claudecode/toolUseId': 'toolu_01' },
        }),
        headers,
      );
      if (headers.authorization === '') request.headers.delete('authorization');

      const response = await serveBuilderMcp(request, door(verifyCaller, { ports }));

      expect(response.status).toBe(403);
      expect(reached).not.toHaveBeenCalled();
      expect(await journalled()).toBe(0);
    },
  );

  it('refuses every call when no token secret is configured', async () => {
    const response = await serveBuilderMcp(
      rpc(call('tools/list')),
      door(createBuilderCallerVerifier(null)),
    );
    expect(response.status).toBe(403);
  });
});
