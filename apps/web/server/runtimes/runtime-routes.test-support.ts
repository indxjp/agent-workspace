import type { MembershipRoleName } from '@indx-workspace/contracts/team';
import { afterEach } from 'vitest';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { installWorkspaceHeaderRbac, TEST_ROLE_HEADER } from '../rbac/testing';
import { createInMemoryRuntimeConnectionStoreProvider } from './connections';
import { createInMemoryRuntimeProfileStoreProvider } from './memory-store';
import {
  clearWebRuntimeRegistry,
  configureWebRuntimeRegistry,
  createWebRuntimeRegistry,
} from './registry';
import type { WorkspaceResolution } from './runtime';

export const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';

export const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

export const WORKSPACE_HEADER = 'x-test-workspace';

afterEach(() => {
  clearApplicationContext();
  clearWebRuntimeRegistry();
});

export type TestRole = MembershipRoleName;

export function useMemoryRuntime(): void {
  // Every route here is gated by the shared decision table (issue #388): §21 grants runtimes to
  // Owner and Admin, and a Builder reads profiles only (ADR-0088). The identity reads the same
  // header the workspace resolver does.
  installWorkspaceHeaderRbac(WORKSPACE_HEADER);
  installTestDomains({
    runtimes: {
      kind: 'serving',
      runtime: {
        profiles: createInMemoryRuntimeProfileStoreProvider(),
        connections: createInMemoryRuntimeConnectionStoreProvider(),
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
}

export function useAzurePoolRegistry(): void {
  configureWebRuntimeRegistry(
    createWebRuntimeRegistry({
      registry: {
        wasVerified: () => true,
        test: () => Promise.reject(new Error('this suite never runs Test Runtime')),
      },
      entries: [
        {
          id: 'aca-sessions',
          label: 'Azure Container Apps dynamic sessions',
          connectionExists: true,
          imageReachable: true,
          networkPolicies: ['open'],
        },
        { id: 'docker', label: 'Docker', connectionExists: true, imageReachable: true },
      ],
      configFor: () => ({ sessionId: 'unused', workspacePath: 'unused', engine: 'unused' }),
      requestForEcho: String,
      renderEvent: String,
    }),
  );
}

export function request(
  method: string,
  url: string,
  options: {
    workspace?: string;
    body?: string;
    contentType?: string | null;
    role?: TestRole;
  } = {},
): Request {
  const headers = new Headers();
  if (options.workspace !== undefined) headers.set(WORKSPACE_HEADER, options.workspace);
  if (options.role !== undefined) headers.set(TEST_ROLE_HEADER, options.role);
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

export const CREATE_BODY = JSON.stringify({
  name: 'Standard',
  driver: 'docker',
  networkPolicy: 'restricted',
  allowedDomains: ['api.anthropic.com'],
  filesystem: 'read-write',
  cpu: 1,
  memoryMb: 1024,
});
