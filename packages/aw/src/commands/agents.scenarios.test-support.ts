import { FIXTURES, IDS, json } from '../testing.js';

export const body = {
  name: 'Summariser',
  instructions: 'Summarise.',
  modelConnectionId: IDS.connection,
  model: 'claude-x',
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
};
export const AGENT_PATH = `/api/agents/${IDS.agent}`;
export const POLICY_PATH = `${AGENT_PATH}/policy`;
export function engineAwareRoute(request: {
  readonly url: URL;
  readonly method: string;
}): Response {
  if (request.url.pathname === '/api/engines') return json(200, { engines: [FIXTURES.engine] });
  if (request.url.pathname === '/api/agents') return json(201, FIXTURES.agent);
  if (request.url.pathname === POLICY_PATH) return json(200, { policy: FIXTURES.policy });
  if (request.url.pathname === AGENT_PATH) return json(200, FIXTURES.agent);
  return json(500, { error: { code: 'unexpected', message: request.url.pathname } });
}
export function trace(run: { readonly calls: readonly { url: URL; method: string }[] }): string[] {
  return run.calls.map((call) => `${call.method} ${call.url.pathname}`);
}
export const OPENAI_ENGINE = {
  ...FIXTURES.engine,
  id: 'openai-agents',
  displayName: 'OpenAI Agents SDK',
};
export function openAiRoute(
  policy: unknown,
  put?: () => Response,
): (request: { readonly url: URL; readonly method: string }) => Response {
  return (request) => {
    if (request.url.pathname === '/api/engines') {
      return json(200, { engines: [FIXTURES.engine, OPENAI_ENGINE] });
    }
    if (request.url.pathname === POLICY_PATH && request.method === 'GET') {
      return json(200, { policy });
    }
    if (request.url.pathname === POLICY_PATH && put !== undefined) return put();
    return engineAwareRoute(request);
  };
}
