import { createAcaSessionsDriver, createAcaSessionsRestClient } from './aca-sessions.js';
import type {
  AcaSession,
  AcaSessionsClient,
  AcaSessionsDriver,
  AcaSessionsDriverOptions,
} from './aca-sessions.js';
import type { RuntimeConfig } from './driver.js';

export const CONFIG: RuntimeConfig = {
  sessionId: 'conversation-1',
  engine: 'claude-agent-sdk',
  workspacePath: '/workspace/conversation-1',
  runtimeProfileId: 'profile-1',
};

export function echoConnection(value: string) {
  return {
    events: (async function* () {
      await Promise.resolve();
      yield value;
    })(),
    sessionId: Promise.resolve('claude-session'),
    interrupt: () => Promise.resolve(),
  };
}

export function fakeClient(): {
  client: AcaSessionsClient;
  allocated: string[];
  stopped: string[];
  requests: Array<{ identifier: string; path: string; init?: RequestInit }>;
} {
  const allocated: string[] = [];
  const stopped: string[] = [];
  const requests: Array<{ identifier: string; path: string; init?: RequestInit }> = [];
  const sessions = new Map<string, AcaSession>();
  const client: AcaSessionsClient = {
    requestUrl: (identifier, path) =>
      `https://pool.example${path}${path.includes('?') ? '&' : '?'}identifier=${identifier}`,
    request: (identifier, path, init) => {
      requests.push({ identifier, path, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(new Response('ok'));
    },
    allocate: (identifier) => {
      allocated.push(identifier);
      sessions.set(identifier, {
        identifier,
        createdAt: new Date('2026-09-11T00:00:00.000Z'),
        expiresAt: new Date('2026-09-11T00:10:00.000Z'),
      });
      return Promise.resolve();
    },
    getSession: (identifier) => Promise.resolve(sessions.get(identifier) ?? null),
    stopSession: (identifier) => {
      stopped.push(identifier);
      sessions.delete(identifier);
      return Promise.resolve();
    },
  };
  return { client, allocated, stopped, requests };
}

const POOL_SECRET = 's'.repeat(32);

/** A driver over `client` for the standard disabled-egress test pool; `overrides` adjust one aspect. */
export function poolDriver(
  client: AcaSessionsClient,
  overrides: Partial<AcaSessionsDriverOptions<string, string>> = {},
): AcaSessionsDriver<string, string> {
  return createAcaSessionsDriver<string, string>({
    engine: 'claude-agent-sdk',
    poolManagementEndpoint: 'https://pool.example',
    networkStatus: 'EgressDisabled',
    ...(overrides.identifierForConfig === undefined ? { identifierSecret: POOL_SECRET } : {}),
    client,
    startAgent: () => echoConnection('unused'),
    ...overrides,
  });
}

/** A REST client over a stub `fetch`, with a fixed token. */
export function restClientWith(
  fetch: typeof globalThis.fetch,
  poolManagementEndpoint = 'https://pool.example',
): AcaSessionsClient {
  return createAcaSessionsRestClient({
    poolManagementEndpoint,
    getAccessToken: () => Promise.resolve('token'),
    fetch,
  });
}
