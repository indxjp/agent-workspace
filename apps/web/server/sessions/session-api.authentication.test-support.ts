import { describe, expect, it } from 'vitest';
import {
  appendTranscript,
  deleteTranscript,
  listSessions,
  listTranscriptSubkeys,
  loadTranscript,
} from './api';
import {
  del,
  errorCode,
  get,
  install,
  post,
  SESSION,
  TRANSCRIPT,
} from './session-api.test-support';

export function registerAuthenticationTests() {
  describe('nothing installed', () => {
    it.each([
      ['GET /api/sessions', (): Promise<Response> => listSessions(get('/api/sessions'))],
      ['GET transcript', (): Promise<Response> => loadTranscript(get(TRANSCRIPT), SESSION)],
      ['POST transcript', (): Promise<Response> => appendTranscript(post(TRANSCRIPT, {}), SESSION)],
      ['DELETE transcript', (): Promise<Response> => deleteTranscript(del(TRANSCRIPT), SESSION)],
      [
        'GET subkeys',
        (): Promise<Response> =>
          listTranscriptSubkeys(get(`/api/sessions/${SESSION}/subkeys`), SESSION),
      ],
    ])('%s answers 503 and names what is missing', async (_name, call) => {
      const response = await call();
      expect(response.status).toBe(503);
      // Not 401, which would promise credentials could fix it; not 200 with an empty transcript,
      // which would present an unconfigured deployment as an empty conversation.
      expect(await errorCode(response)).toBe('session_api_not_configured');
    });
  });

  describe('unauthenticated', () => {
    it('answers 401 before it looks at the body', async () => {
      install({ authenticated: false });
      const response = await appendTranscript(
        post(TRANSCRIPT, { this: 'body', is: 'nonsense' }),
        SESSION,
      );
      expect(response.status).toBe(401);
    });
  });
}
