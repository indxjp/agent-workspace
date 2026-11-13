import { describe, expect, it, vi } from 'vitest';
import { serveA2aCard, serveA2aRpc } from './dispatch';
import { A2A_RATE_LIMITS, resetA2aLimits } from './limits';
import {
  installA2a,
  installedA2a,
  state,
  rpc,
  send,
  body,
  errorCodeOf,
} from './dispatch.fixture.test-support';
export function registerA2aRateLimitsTests() {
  describe('the rate limits on the public A2A route', () => {
    it('answers 429 a2a_rate_limited with Retry-After once a credential spends its calls', async () => {
      for (let call = 0; call < A2A_RATE_LIMITS.callsPerMinute; call += 1) {
        const response = await serveA2aRpc(rpc('tasks/get', { id: 'x' }), 'support-bot');
        expect(response.status).toBe(200);
      }
      const limited = await serveA2aRpc(rpc('tasks/get', { id: 'x' }), 'support-bot');
      expect(limited.status).toBe(429);
      expect(await errorCodeOf(limited)).toBe('a2a_rate_limited');
      expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
      const other = await serveA2aRpc(
        rpc('tasks/get', { id: 'x' }, { identity: 'second' }),
        'support-bot',
      );
      expect(other.status).toBe(200);
    });

    it('limits the calls that start a run more tightly, and leaves reads unlimited by it', async () => {
      for (let call = 0; call < A2A_RATE_LIMITS.messagesPerMinute; call += 1) {
        const response = await serveA2aRpc(send('hi', {}, { blocking: false }), 'support-bot');
        expect((await body(response)).error).toBeUndefined();
      }
      const limited = await serveA2aRpc(send('hi', {}, { blocking: false }), 'support-bot');
      expect(limited.status).toBe(429);
      expect(limited.headers.get('Retry-After')).not.toBeNull();
      expect(state.launched).toHaveLength(A2A_RATE_LIMITS.messagesPerMinute);
      const read = await serveA2aRpc(rpc('tasks/get', { id: 'x' }), 'support-bot');
      expect(read.status).toBe(200);
    });

    it('counts the 404 answers against the limit, so agent names cannot be probed for free', async () => {
      for (const [identity, agent, status] of [
        ['owner', 'no-such-agent', 404],
        ['scopedElsewhere', 'support-bot', 404],
      ] as const) {
        resetA2aLimits();
        for (let call = 0; call < A2A_RATE_LIMITS.callsPerMinute; call += 1) {
          const refused = await serveA2aRpc(
            rpc('tasks/get', { id: 'x' }, { identity, agent }),
            agent,
          );
          expect(refused.status).toBe(status);
        }
        const limited = await serveA2aRpc(
          rpc('tasks/get', { id: 'x' }, { identity, agent }),
          agent,
        );
        expect(limited.status).toBe(429);
        expect(await errorCodeOf(limited)).toBe('a2a_rate_limited');
      }
    });

    it('refuses an over-limit call before looking the agent up', async () => {
      const a2a = installedA2a();
      if (a2a === null) throw new Error('A2A not installed');
      const findPublishedAgent = vi.fn((workspaceId: string, name: string) =>
        a2a.findPublishedAgent(workspaceId, name),
      );
      installA2a({ ...a2a, findPublishedAgent });
      for (let call = 0; call < A2A_RATE_LIMITS.callsPerMinute; call += 1) {
        await serveA2aRpc(rpc('tasks/get', { id: 'x' }), 'support-bot');
      }
      expect(findPublishedAgent).toHaveBeenCalledTimes(A2A_RATE_LIMITS.callsPerMinute);
      findPublishedAgent.mockClear();
      const limited = await serveA2aRpc(rpc('tasks/get', { id: 'x' }), 'support-bot');
      expect(limited.status).toBe(429);
      expect(findPublishedAgent).not.toHaveBeenCalled();
    });

    it('limits the agent card the same way', async () => {
      for (let call = 0; call < A2A_RATE_LIMITS.callsPerMinute; call += 1) {
        await serveA2aCard(rpc('x', {}), 'support-bot');
      }
      const limited = await serveA2aCard(rpc('x', {}), 'support-bot');
      expect(limited.status).toBe(429);
    });
  });
}
