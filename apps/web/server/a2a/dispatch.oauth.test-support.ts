import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serveA2aCard, serveA2aRpc } from './dispatch';
import {
  SECRET,
  URL_BASE,
  state,
  rpc,
  send,
  task,
  errorCodeOf,
} from './dispatch.fixture.test-support';
export function registerA2aOAuthTests() {
  describe('OAuth access tokens on the A2A endpoint (ADR-0134 part 3)', () => {
    beforeEach(() => {
      vi.stubEnv('AW_PUBLIC_URL', 'https://aw.example');
    });

    it('serves a token issued for this agent', async () => {
      const response = await serveA2aRpc(
        send('hi', {}, { blocking: false }, 'oauth'),
        'support-bot',
      );
      expect(response.status).toBe(200);
      expect((await task(response)).status.state).toBe('submitted');
    });

    it.each(['oauthOtherAgent', 'oauthMcp', 'oauthBuilder'])(
      'refuses a token issued for another URL (%s) with 401 invalid_token and a challenge, starting no run',
      async (identity) => {
        const response = await serveA2aRpc(
          send('hi', {}, { blocking: false }, identity),
          'support-bot',
        );
        expect(response.status).toBe(401);
        expect(await errorCodeOf(response)).toBe('invalid_token');
        const challenge = response.headers.get('WWW-Authenticate') ?? '';
        expect(challenge).toContain('error="invalid_token"');
        expect(challenge).toContain(
          'resource_metadata="https://aw.example/.well-known/oauth-protected-resource/api/a2a/agents/support-bot"',
        );
        expect(state.launched).toHaveLength(0);
      },
    );

    it('refuses the same token on the agent card', async () => {
      const response = await serveA2aCard(
        new Request(`${URL_BASE}/support-bot/.well-known/agent-card.json`, {
          headers: { 'x-test-identity': 'oauthMcp', Authorization: `Bearer ${SECRET}` },
        }),
        'support-bot',
      );
      expect(response.status).toBe(401);
    });

    it('points an unauthenticated caller at the protected-resource metadata', async () => {
      const response = await serveA2aRpc(
        rpc('tasks/get', { id: 'x' }, { identity: 'nobody' }),
        'support-bot',
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toBe(
        'Bearer realm="agent-workspace", resource_metadata="https://aw.example/.well-known/oauth-protected-resource/api/a2a/agents/support-bot"',
      );
    });
  });
}
