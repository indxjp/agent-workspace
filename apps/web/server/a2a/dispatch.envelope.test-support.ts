import { A2A_ERROR_CODES } from '@indx-workspace/contracts/a2a';
import { describe, expect, it } from 'vitest';
import { A2A_MAX_BODY_BYTES, serveA2aRpc } from './dispatch';
import {
  AGENT,
  SECRET,
  URL_BASE,
  state,
  rpc,
  body,
  errorCodeOf,
} from './dispatch.fixture.test-support';
export function registerA2aEnvelopeTests() {
  describe('the JSON-RPC envelope', () => {
    const raw = (text: string) =>
      new Request(`${URL_BASE}/support-bot`, {
        method: 'POST',
        headers: { 'x-test-identity': 'owner', Authorization: `Bearer ${SECRET}` },
        body: text,
      });

    it('answers a body past the cap 413 a2a_body_too_large without parsing it', async () => {
      const response = await serveA2aRpc(raw('a'.repeat(A2A_MAX_BODY_BYTES + 1)), 'support-bot');
      expect(response.status).toBe(413);
      expect(await errorCodeOf(response)).toBe('a2a_body_too_large');
    });

    it('maps malformed input to the JSON-RPC codes, all with HTTP 200', async () => {
      const cases: Array<[string, number]> = [
        ['{not json', A2A_ERROR_CODES.parse_error],
        ['[{"jsonrpc":"2.0","id":1,"method":"tasks/get"}]', A2A_ERROR_CODES.invalid_request],
        ['{"jsonrpc":"1.0","id":1,"method":"tasks/get"}', A2A_ERROR_CODES.invalid_request],
        ['{"jsonrpc":"2.0","id":1,"method":"nope/nothing"}', A2A_ERROR_CODES.method_not_found],
        [
          '{"jsonrpc":"2.0","id":1,"method":"tasks/get","params":{}}',
          A2A_ERROR_CODES.invalid_params,
        ],
        [
          '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{}}}',
          A2A_ERROR_CODES.invalid_params,
        ],
      ];
      for (const [text, code] of cases) {
        const response = await serveA2aRpc(raw(text), 'support-bot');
        expect(response.status, text).toBe(200);
        expect((await body(response)).error?.code, text).toBe(code);
      }
    });

    it('answers the methods it does not offer with the codes the protocol assigns', async () => {
      const resubscribe = await serveA2aRpc(rpc('tasks/resubscribe', { id: AGENT }), 'support-bot');
      expect((await body(resubscribe)).error?.code).toBe(A2A_ERROR_CODES.unsupported_operation);
      const push = await serveA2aRpc(rpc('tasks/pushNotificationConfig/set', {}), 'support-bot');
      expect((await body(push)).error?.code).toBe(A2A_ERROR_CODES.push_notification_not_supported);
      const extended = await serveA2aRpc(
        rpc('agent/getAuthenticatedExtendedCard', {}),
        'support-bot',
      );
      expect((await body(extended)).error?.code).toBe(A2A_ERROR_CODES.unsupported_operation);
    });

    it('refuses what the agent cannot take: a task to continue, push, files, agent roles, other output', async () => {
      const message = (extra: Record<string, unknown>) => ({
        kind: 'message',
        messageId: 'm',
        role: 'user',
        parts: [{ kind: 'text', text: 'hi' }],
        ...extra,
      });
      const refusals: Array<[unknown, number]> = [
        [{ message: message({ taskId: AGENT }) }, A2A_ERROR_CODES.unsupported_operation],
        [
          {
            message: message({}),
            configuration: { pushNotificationConfig: { url: 'https://x.example' } },
          },
          A2A_ERROR_CODES.push_notification_not_supported,
        ],
        [
          { message: message({ parts: [{ kind: 'file', file: { uri: 'https://x.example/a' } }] }) },
          A2A_ERROR_CODES.content_type_not_supported,
        ],
        [{ message: message({ role: 'agent' }) }, A2A_ERROR_CODES.invalid_params],
        [
          { message: message({}), configuration: { acceptedOutputModes: ['image/png'] } },
          A2A_ERROR_CODES.content_type_not_supported,
        ],
      ];
      for (const [params, code] of refusals) {
        const response = await serveA2aRpc(rpc('message/send', params), 'support-bot');
        expect((await body(response)).error?.code, JSON.stringify(params)).toBe(code);
      }
      expect(state.launched).toHaveLength(0);
    });
  });
}
