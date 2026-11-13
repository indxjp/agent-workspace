import { MEMBERSHIP_ROLES } from '@indx-workspace/contracts/team';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';
import { POST as CREATE } from '../../app/api/model-connections/route';
import { installModelsApi } from '../composition/services';
import { createInMemoryModelsStoreProvider } from './store';
import type { ModelsAuditEvent } from './runtime';
import type { Role } from '../rbac/core/roles';
import { Principal } from '../rbac/principal';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';

export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

export const API_KEY = 'Provider-Key-Must-Never-Escape';

export const ROTATED_KEY = 'Provider-Key-Must-Never-Escape-Rotated';

export type RouteContext = { params: Promise<{ id: string }> };

export function request(url: string, method = 'GET', body?: unknown): Request {
  return new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

export async function text(response: Response): Promise<string> {
  return response.status === 204 ? '' : response.text();
}
export function createModelHttpFixture() {
  const audits: ModelsAuditEvent[] = [];
  const logs: string[] = [];
  beforeEach(() => {
    audits.length = 0;
    logs.length = 0;
    installTestDomains({
      models: {
        kind: 'serving',
        runtime: {
          resolveActor: () =>
            Promise.resolve({
              kind: 'workspace',
              workspaceId: WORKSPACE_ID,
              principalId: '99999999-9999-4999-8999-999999999999',
              userId: '22222222-2222-4222-8222-222222222222',
              userLabel: 'Operator',
              role: 'owner',
              scope: null,
            }),
          models: createInMemoryModelsStoreProvider([WORKSPACE_ID]),
          probe: (resolved) => {
            expect([API_KEY, ROTATED_KEY]).toContain(resolved.credential);
            return Promise.resolve({
              ok: true,
              status: 200,
              latencyMs: 1,
              message: 'Connection succeeded.',
            });
          },
          // This suite is about the connection CRUD surface, not discovery — `discovery.test.ts` owns
          // that. A fixed, empty answer keeps `GET /api/models` from making a real network call.
          discover: (resolved) => {
            expect([API_KEY, ROTATED_KEY]).toContain(resolved.credential);
            return Promise.resolve({ ok: true, models: [], stale: false });
          },
          audit: (event) => {
            audits.push(event);
            return Promise.resolve();
          },
          log: (message) => logs.push(message),
          vertexDefaults: { projectId: 'install-project-1', location: 'eu' },
        },
      },
    });
  });
  afterEach(clearApplicationContext);
  return {
    get audits() {
      return audits;
    },
    get logs() {
      return logs;
    },
  };
}
export type ModelHttpFixture = ReturnType<typeof createModelHttpFixture>;

export function createModelAuthorizationFixture() {
  const ROLE_HEADER = 'x-test-role';
  const WORKSPACE_HEADER = 'x-test-workspace';
  const WORKSPACE_A = WORKSPACE_ID;
  const WORKSPACE_B = '33333333-3333-4333-8333-333333333333';
  const ROLES = MEMBERSHIP_ROLES;
  const ALLOWED: ReadonlySet<Role> = new Set(['owner', 'admin']);
  function roleRequest(
    url: string,
    method: string,
    role: Role,
    options: { body?: unknown; workspace?: string } = {},
  ): Request {
    const headers = new Headers({
      [ROLE_HEADER]: role,
      [WORKSPACE_HEADER]: options.workspace ?? WORKSPACE_A,
    });
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    return new Request(url, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }
  let connectionId = '';
  beforeEach(async () => {
    installTestDomains({
      models: {
        kind: 'serving',
        runtime: {
          // Deliberately not a `resolveWorkspace` + `identifyActor` pair, unlike the composition
          // root's real one: this suite is about what `withModelsRuntime` does with the role once it
          // has one, not about how a role is discovered, and `agents/routes.test.ts`'s own fixture
          // makes the same simplification for the same reason.
          resolveActor: (request) => {
            const role = request.headers.get(ROLE_HEADER);
            if (role === null) {
              return Promise.resolve({ kind: 'unauthenticated', reason: 'no test role header' });
            }
            return Promise.resolve({
              kind: 'workspace',
              workspaceId: request.headers.get(WORKSPACE_HEADER) ?? WORKSPACE_A,
              principalId: '99999999-9999-4999-8999-999999999999',
              userId: '44444444-4444-4444-8444-444444444444',
              userLabel: 'Matrix operator',
              role: role as Role,
              scope: null,
            });
          },
          models: createInMemoryModelsStoreProvider([WORKSPACE_A, WORKSPACE_B]),
          probe: () =>
            Promise.resolve({
              ok: true,
              status: 200,
              latencyMs: 1,
              message: 'Connection succeeded.',
            }),
          discover: () => Promise.resolve({ ok: true, models: [], stale: false }),
          audit: () => Promise.resolve(),
          log: () => undefined,
        },
      },
    });
    const created = await CREATE(
      roleRequest('http://web/api/model-connections', 'POST', 'owner', {
        body: { name: 'Matrix fixture', provider: 'anthropic', apiKey: API_KEY, config: {} },
      }),
    );
    connectionId = ((await created.json()) as { id: string }).id;
  });
  afterEach(clearApplicationContext);
  return {
    get ROLE_HEADER() {
      return ROLE_HEADER;
    },
    get WORKSPACE_HEADER() {
      return WORKSPACE_HEADER;
    },
    get WORKSPACE_A() {
      return WORKSPACE_A;
    },
    get WORKSPACE_B() {
      return WORKSPACE_B;
    },
    get ROLES() {
      return ROLES;
    },
    get ALLOWED() {
      return ALLOWED;
    },
    get roleRequest() {
      return roleRequest;
    },
    get connectionId() {
      return connectionId;
    },
  };
}
export type ModelAuthorizationFixture = ReturnType<typeof createModelAuthorizationFixture>;

export function createModelCompositionFixture() {
  afterEach(clearApplicationContext);
  return {};
}
export type ModelCompositionFixture = ReturnType<typeof createModelCompositionFixture>;

export function createVertexCompositionFixture() {
  afterEach(() => {
    clearApplicationContext();
    vi.unstubAllEnvs();
  });
  async function build() {
    const principal = Principal.fromApiKey({
      principalId: '99999999-9999-4999-8999-999999999999',
      apiKeyId: '77777777-7777-4777-8777-777777777777',
      label: 'Composition-root probe',
      workspaceId: '88888888-8888-4888-8888-888888888888',
      role: 'owner',
    });
    const { models } = await installModelsApi(
      () => Promise.resolve({ kind: 'workspace', workspaceId: principal.workspaceId }),
      () => Promise.resolve(principal),
      {} as unknown as DatabaseRoot,
      {} as unknown as SecretsService,
    );
    installTestDomains({ models });
    return models;
  }
  return {
    get build() {
      return build;
    },
  };
}
export type VertexCompositionFixture = ReturnType<typeof createVertexCompositionFixture>;
