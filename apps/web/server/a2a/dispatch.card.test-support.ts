import { A2aAgentCardSchema } from '@indx-workspace/contracts/a2a';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serveA2aCard, serveA2aRpc } from './dispatch';
import { clearApplicationContext } from '../application-context';
import { installTestDomains, resetTestRunApi } from '../application-context-fixtures';
import { A2A_RATE_LIMITS } from './limits';
import {
  WORKSPACE,
  AGENT,
  PRODUCTION_VERSION,
  SECRET,
  installA2a,
  installedA2a,
  URL_BASE,
  rpc,
  errorCodeOf,
} from './dispatch.fixture.test-support';
export function registerA2aCardTests() {
  describe('the agent card', () => {
    const card = (
      identity = 'owner',
      agent = 'support-bot',
      headers: Record<string, string> = {},
    ) =>
      serveA2aCard(
        new Request(`${URL_BASE}/${agent}/.well-known/agent-card.json`, {
          headers: { 'x-test-identity': identity, Authorization: `Bearer ${SECRET}`, ...headers },
        }),
        agent,
      );

    it('answers a key scoped to another agent, or an mcp-project key, with the unknown-name 404', async () => {
      const unknown = await card('owner', 'no-such-agent');
      for (const identity of ['scopedElsewhere', 'mcpKey']) {
        const response = await card(identity);
        expect(response.status, identity).toBe(404);
        expect(await response.text(), identity).toBe(await unknown.clone().text());
      }
    });

    it('serves a valid v0.3 card whose url is built from AW_PUBLIC_URL and the production version', async () => {
      vi.stubEnv('AW_PUBLIC_URL', 'https://aw.example.com');
      const response = await card();
      expect(response.status).toBe(200);
      const parsed = A2aAgentCardSchema.parse(await response.json());
      expect(parsed.url).toBe('https://aw.example.com/api/a2a/agents/support-bot');
      expect(parsed.version).toBe('7');
      expect(parsed.capabilities).toEqual({ streaming: true, pushNotifications: false });
    });

    it('answers 503 a2a_public_url_not_configured where AW_PUBLIC_URL is unset or invalid', async () => {
      for (const value of ['', 'ftp://aw.example.com', 'https://aw.example.com/path']) {
        vi.stubEnv('AW_PUBLIC_URL', value);
        const response = await card();
        expect(response.status, value).toBe(503);
        expect(await errorCodeOf(response)).toBe('a2a_public_url_not_configured');
      }
    });

    it('is behind the same credential, tenant and role checks as the endpoint', async () => {
      vi.stubEnv('AW_PUBLIC_URL', 'https://aw.example.com');
      expect((await card('nobody')).status).toBe(401);
      expect((await card('session')).status).toBe(403);
      expect((await card('otherTenant')).status).toBe(404);
      expect((await card('owner', 'missing')).status).toBe(404);
      expect((await card('viewer')).status).toBe(403);
      expect((await card('scopedElsewhere')).status).toBe(404);
      const fromBrowser = await card('owner', 'support-bot', { Origin: 'https://evil.example' });
      expect(fromBrowser.status).toBe(403);
      expect(await errorCodeOf(fromBrowser)).toBe('origin_not_allowed');
    });

    describe('without any credential (public discovery metadata, issue #1076)', () => {
      const publicCard = (agent = 'support-bot', headers: Record<string, string> = {}) =>
        serveA2aCard(
          new Request(`${URL_BASE}/${agent}/.well-known/agent-card.json`, { headers }),
          agent,
        );

      beforeEach(() => {
        vi.stubEnv('AW_PUBLIC_URL', 'https://aw.example.com');
      });

      it('serves the card of a published agent with its fields and nothing secret-shaped', async () => {
        const response = await publicCard();
        expect(response.status).toBe(200);
        const text = await response.text();
        const parsed = A2aAgentCardSchema.parse(JSON.parse(text));
        expect(parsed.name).toBe('support-bot');
        expect(parsed.url).toBe('https://aw.example.com/api/a2a/agents/support-bot');
        expect(parsed.version).toBe('7');
        expect(parsed.skills.map((skill) => skill.id)).toEqual(['support-bot']);
        expect(Object.keys(parsed.securitySchemes ?? {})).toEqual(['awBearer']);
        for (const forbidden of [SECRET, AGENT, PRODUCTION_VERSION, WORKSPACE, 'ak_live', 'aw_']) {
          expect(text, forbidden).not.toContain(forbidden);
        }
      });

      it('answers every name the deployment lookup misses with one identical 404', async () => {
        const bodies = new Set<string>();
        for (const name of ['no-such-agent', 'billing-bot', 'unpublished']) {
          const response = await publicCard(name);
          expect(response.status, name).toBe(404);
          bodies.add(await response.text());
        }
        expect(bodies.size).toBe(1);
      });

      it('still answers 401 to the message and task endpoint', async () => {
        const response = await serveA2aRpc(
          new Request(`${URL_BASE}/support-bot`, { method: 'POST', body: '{}' }),
          'support-bot',
        );
        expect(response.status).toBe(401);
        expect(response.headers.get('WWW-Authenticate')).toMatch(
          /^Bearer realm="agent-workspace"/u,
        );
      });

      it('refuses a browser Origin', async () => {
        const response = await publicCard('support-bot', { Origin: 'https://evil.example' });
        expect(response.status).toBe(403);
        expect(await errorCodeOf(response)).toBe('origin_not_allowed');
      });

      it('answers 503 a2a_public_url_not_configured where AW_PUBLIC_URL is unset', async () => {
        vi.stubEnv('AW_PUBLIC_URL', '');
        const response = await publicCard();
        expect(response.status).toBe(503);
        expect(await errorCodeOf(response)).toBe('a2a_public_url_not_configured');
      });

      it('is rate limited per client address, and an over-limit call looks nothing up', async () => {
        const a2a = installedA2a();
        if (a2a === null) throw new Error('the A2A environment is not installed');
        const findDeploymentAgent = vi.fn((name: string) => a2a.findDeploymentAgent(name));
        installA2a({ ...a2a, findDeploymentAgent });
        // No AW_TRUSTED_PROXY_HOPS: callers share one bucket ten times the per-address limit.
        const limit = A2A_RATE_LIMITS.cardFetchesPerAddressPerMinute * 10;
        for (let i = 0; i < limit; i += 1) expect((await publicCard()).status).toBe(200);
        findDeploymentAgent.mockClear();
        const over = await publicCard();
        expect(over.status).toBe(429);
        expect(await errorCodeOf(over)).toBe('a2a_rate_limited');
        expect(over.headers.get('Retry-After')).toMatch(/^\d+$/u);
        expect(findDeploymentAgent).not.toHaveBeenCalled();
      });
    });

    it('answers 503 a2a_not_configured when the endpoint is not installed', async () => {
      clearApplicationContext();
      const response = await card();
      expect(response.status).toBe(503);
    });

    it('answers the same 503 while the endpoint is disabled, to a call and a card fetch', async () => {
      installTestDomains({ a2a: { kind: 'disabled' } });
      const rpcResponse = await serveA2aRpc(rpc('tasks/get', { id: 'x' }), 'support-bot');
      expect(rpcResponse.status).toBe(503);
      expect(await errorCodeOf(rpcResponse)).toBe('a2a_not_configured');
      const cardResponse = await card();
      expect(cardResponse.status).toBe(503);
      expect(await errorCodeOf(cardResponse)).toBe('a2a_not_configured');
    });

    it('answers 401, not 503, to an RPC with no credential at all, installed or not', async () => {
      clearApplicationContext();
      resetTestRunApi();
      const response = await serveA2aRpc(
        new Request(`${URL_BASE}/support-bot`, { method: 'POST' }),
        'x',
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="agent-workspace"');
    });

    it('answers 503 a2a_not_configured to a credential-less card fetch when nothing is installed', async () => {
      clearApplicationContext();
      const response = await serveA2aCard(
        new Request(`${URL_BASE}/support-bot/.well-known/agent-card.json`),
        'support-bot',
      );
      expect(response.status).toBe(503);
      expect(await errorCodeOf(response)).toBe('a2a_not_configured');
    });
  });
}
