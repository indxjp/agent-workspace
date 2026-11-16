import { A2A_ERROR_CODES } from '@indx-workspace/contracts/a2a';
import { describe, expect, it } from 'vitest';
import { serveA2aRpc } from './dispatch';
import { installTestRunApi } from '../application-context-fixtures';
import {
  AGENT,
  URL_BASE,
  installA2a,
  installedA2a,
  state,
  rpc,
  send,
  body,
  task,
  errorCodeOf,
} from './dispatch.fixture.test-support';
export function registerA2aAuthenticationTests() {
  describe('who may call the A2A endpoint', () => {
    it('answers 401 with a Bearer challenge when no credential identifies the caller', async () => {
      const response = await serveA2aRpc(
        rpc('tasks/get', { id: 'x' }, { identity: 'nobody' }),
        'support-bot',
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="agent-workspace"');
    });

    it.each(['session', 'browserToken', 'userToken'])(
      'refuses a %s credential with 403 a2a_credential_not_accepted',
      async (identity) => {
        const refused = await serveA2aRpc(rpc('message/send', {}, { identity }), 'support-bot');
        expect(refused.status).toBe(403);
        expect(await errorCodeOf(refused)).toBe('a2a_credential_not_accepted');
        expect(state.launched).toHaveLength(0);
      },
    );

    it('refuses a request that carries an Origin header, however well authenticated', async () => {
      const refused = await serveA2aRpc(
        rpc('tasks/get', { id: AGENT }, { headers: { Origin: 'https://evil.example' } }),
        'support-bot',
      );
      expect(refused.status).toBe(403);
      expect(await errorCodeOf(refused)).toBe('origin_not_allowed');
    });

    it('keeps tenants apart: another workspace, an unknown name and an unpublished agent look the same', async () => {
      const foreign = await serveA2aRpc(
        rpc('tasks/get', { id: AGENT }, { identity: 'otherTenant' }),
        'support-bot',
      );
      const unknown = await serveA2aRpc(rpc('tasks/get', { id: AGENT }), 'no-such-agent');
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(await foreign.text()).toBe(await unknown.text());
      expect(state.launched).toHaveLength(0);
    });

    it('keeps an agent whose run lookup fails out of reach with the same 404', async () => {
      installTestRunApi({
        authenticate: () => Promise.resolve(null),
        findAgent: () => Promise.resolve(null),
        openSession: () => Promise.resolve(null),
        ownsRun: () => Promise.resolve(true),
        store: state.store,
        launch: () => undefined,
      });
      const response = await serveA2aRpc(rpc('tasks/get', { id: AGENT }), 'support-bot');
      expect(response.status).toBe(404);
      expect(await errorCodeOf(response)).toBe('a2a_agent_not_found');
    });

    it('admits a key scoped to this agent and answers one scoped to another with the unknown-name 404', async () => {
      const scoped = await serveA2aRpc(
        rpc(
          'message/send',
          {
            message: {
              kind: 'message',
              messageId: 'm',
              role: 'user',
              parts: [{ kind: 'text', text: 'hi' }],
            },
            configuration: { blocking: false },
          },
          { identity: 'scoped' },
        ),
        'support-bot',
      );
      expect(scoped.status).toBe(200);
      expect((await task(scoped)).status.state).toBe('submitted');
      const elsewhere = await serveA2aRpc(
        rpc(
          'message/send',
          {
            message: {
              kind: 'message',
              messageId: 'm',
              role: 'user',
              parts: [{ kind: 'text', text: 'hi' }],
            },
          },
          { identity: 'scopedElsewhere' },
        ),
        'support-bot',
      );
      expect(elsewhere.status).toBe(404);
      expect(await errorCodeOf(elsewhere.clone())).toBe('a2a_agent_not_found');
      const unknown = await serveA2aRpc(rpc('tasks/get', { id: AGENT }), 'no-such-agent');
      expect(await elsewhere.text()).toBe(await unknown.text());
    });

    it('answers an mcp-project key with the unknown-name 404, launching nothing', async () => {
      const response = await serveA2aRpc(
        send('hi', {}, { blocking: false }, 'mcpKey'),
        'support-bot',
      );
      expect(response.status).toBe(404);
      expect(await errorCodeOf(response)).toBe('a2a_agent_not_found');
      expect(state.launched).toHaveLength(0);
    });

    it('refuses a viewer, who may not run the agent, with 403 before any run exists', async () => {
      const response = await serveA2aRpc(
        rpc(
          'message/send',
          {
            message: {
              kind: 'message',
              messageId: 'm',
              role: 'user',
              parts: [{ kind: 'text', text: 'hi' }],
            },
          },
          { identity: 'viewer' },
        ),
        'support-bot',
      );
      expect(response.status).toBe(403);
      expect(state.launched).toHaveLength(0);
    });

    it('lets a viewer run an agent the run-ownership port says they are granted', async () => {
      const environment = installedA2a();
      if (environment === null) throw new Error('the fixture installs the A2A environment');
      const asked: { principalId: string; agentId: string }[] = [];
      installA2a({
        ...environment,
        agentOwnership: (principal, agentId) => {
          asked.push({ principalId: principal.principalId, agentId });
          return Promise.resolve('permitted');
        },
      });
      const response = await serveA2aRpc(
        rpc(
          'message/send',
          {
            message: {
              kind: 'message',
              messageId: 'm',
              role: 'user',
              parts: [{ kind: 'text', text: 'hi' }],
            },
          },
          { identity: 'viewer' },
        ),
        'support-bot',
      );
      expect(response.status).not.toBe(403);
      expect(asked).toEqual([
        { principalId: '77777777-7777-4777-8777-777777777777', agentId: AGENT },
      ]);
    });

    it('refuses an unsupported A2A-Version header or query parameter with 400', async () => {
      for (const request of [
        rpc('tasks/get', { id: 'x' }, { headers: { 'A2A-Version': '1.0' } }),
        rpc('tasks/get', { id: 'x' }, { url: `${URL_BASE}/support-bot?A2A-Version=0.4` }),
      ]) {
        const response = await serveA2aRpc(request, 'support-bot');
        expect(response.status).toBe(400);
        expect(await errorCodeOf(response)).toBe('a2a_version_unsupported');
      }
    });

    it.each(['', '0.3', '0.3.0'])('serves A2A-Version %j as v0.3', async (version) => {
      const response = await serveA2aRpc(
        rpc('tasks/get', { id: 'not-a-uuid' }, { headers: { 'A2A-Version': version } }),
        'support-bot',
      );
      expect(response.status).toBe(200);
      expect((await body(response)).error?.code).toBe(A2A_ERROR_CODES.task_not_found);
    });

    it('serves a client that names no version at all', async () => {
      const response = await serveA2aRpc(rpc('tasks/get', { id: 'x' }), 'support-bot');
      expect((await body(response)).error?.code).toBe(A2A_ERROR_CODES.task_not_found);
    });
  });
}
