import type { MembershipRoleName } from '@indx-workspace/contracts/team';
import { afterEach, expect } from 'vitest';
import { POST as createRoute } from '../../app/api/connectors/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import type { ConnectorResource } from './contract';
import { createInMemoryConnectorsStoreProvider } from './memory-store';
import type { WorkspaceResolution } from './runtime';

export const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';

export const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

const WORKSPACE_HEADER = 'x-test-workspace';

const ROLE_HEADER = 'x-test-role';

const PRINCIPAL_HEADER = 'x-test-principal';

const CREATOR_PRINCIPAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const ADMIN_PRINCIPAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const connectorAudits: Array<{ subjectId: string; subjectLabel: string }> = [];

let memoryConnectors = createInMemoryConnectorsStoreProvider();

afterEach(() => {
  clearApplicationContext();
});

export function useMemoryRuntime(
  identifyActor: () => Promise<{
    readonly principalId: string;
    readonly userId: string | null;
  }> = () =>
    Promise.resolve({
      principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
): void {
  connectorAudits.length = 0;
  memoryConnectors = createInMemoryConnectorsStoreProvider();
  installTestDomains({
    connectors: {
      kind: 'serving',
      runtime: {
        connectors: memoryConnectors,
        recordAudit: (_request, event) => {
          connectorAudits.push(event);
          return Promise.resolve();
        },
        // issue #117: every test request is "authenticated" enough to create a connector.
        identifyActor,
        resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
          const workspaceId = request.headers.get(WORKSPACE_HEADER);
          if (workspaceId === null) {
            return Promise.resolve({ kind: 'unauthenticated', reason: 'no test workspace header' });
          }
          return Promise.resolve({ kind: 'workspace', workspaceId });
        },
      },
    },
  });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory(),
      identify: (request) => {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        return Promise.resolve(
          workspaceId === null
            ? null
            : Principal.fromApiKey({
                principalId: request.headers.get(PRINCIPAL_HEADER) ?? CREATOR_PRINCIPAL,
                apiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                workspaceId,
                role: parseTestRole(request.headers.get(ROLE_HEADER)),
                label: 'Connector route test',
              }),
        );
      },
    },
  });
}

function parseTestRole(raw: string | null): MembershipRoleName {
  return raw === 'admin' || raw === 'builder' || raw === 'viewer' ? raw : 'owner';
}

export function request(
  method: string,
  url: string,
  options: {
    workspace?: string;
    body?: string;
    contentType?: string | null;
    role?: 'admin' | 'builder' | 'viewer';
    principal?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.workspace !== undefined) headers.set(WORKSPACE_HEADER, options.workspace);
  if (options.role !== undefined) headers.set(ROLE_HEADER, options.role);
  if (options.principal !== undefined) headers.set(PRINCIPAL_HEADER, options.principal);
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (contentType !== null && options.body !== undefined) headers.set('content-type', contentType);
  return new Request(`https://example.invalid${url}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

export function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

export async function bodyOf(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

export function stdioBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'Filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
    ...overrides,
  });
}

export const PLAINTEXT = 'sk-ant-super-secret-do-not-leak-this-value';

export function httpBodyWithCredential(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'GitHub',
    transport: 'http',
    url: 'https://api.example.test/mcp',
    authType: 'bearer',
    credential: PLAINTEXT,
    ...overrides,
  });
}

export async function createIn(
  workspace: string,
  body: string = stdioBody(),
): Promise<ConnectorResource> {
  const response = await createRoute(request('POST', '/api/connectors', { workspace, body }));
  expect(response.status, await response.clone().text()).toBe(201);
  return (await bodyOf(response)) as ConnectorResource;
}
export const fixture = {
  get memoryConnectors() {
    return memoryConnectors;
  },
  set memoryConnectors(value: typeof memoryConnectors) {
    memoryConnectors = value;
  },
};
