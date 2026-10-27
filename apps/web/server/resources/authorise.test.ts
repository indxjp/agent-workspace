import { afterEach, describe, expect, it } from 'vitest';

import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import type { Role } from '../rbac/roles';
import { requireResourceAccess } from './authorise';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

afterEach(clearApplicationContext);

function useRole(role: Role): void {
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory(),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workspaceId: WORKSPACE_ID,
            role,
            label: `${role} key`,
          }),
        ),
    },
  });
}

async function status(
  role: Role,
  method: string,
  path: string,
  ownership: 'own' | 'other' | 'unknown' | 'not-applicable',
): Promise<number> {
  useRole(role);
  const access = await requireResourceAccess(
    new Request(`https://example.invalid${path}`, { method }),
    ownership,
  );
  return access.ok ? 204 : access.response.status;
}

describe('resource routes use the existing RBAC policy', () => {
  it('allows Owner and Admin to rewrite agent assignments but denies Viewer', async () => {
    const path = '/api/agents/22222222-2222-4222-8222-222222222222/resources';
    await expect(status('owner', 'PUT', path, 'unknown')).resolves.toBe(204);
    await expect(status('admin', 'PUT', path, 'unknown')).resolves.toBe(204);
    await expect(status('viewer', 'PUT', path, 'unknown')).resolves.toBe(403);
  });

  it('allows a Builder only after the route establishes ownership', async () => {
    const path = '/api/agents/22222222-2222-4222-8222-222222222222/resources';
    await expect(status('builder', 'PUT', path, 'own')).resolves.toBe(204);
    await expect(status('builder', 'PUT', path, 'other')).resolves.toBe(403);
    await expect(status('builder', 'PUT', path, 'unknown')).resolves.toBe(403);
  });

  it('applies the declared Files and Skills role split to collection writes', async () => {
    for (const path of ['/api/files', '/api/skills']) {
      await expect(status('owner', 'POST', path, 'not-applicable')).resolves.toBe(204);
      await expect(status('builder', 'POST', path, 'not-applicable')).resolves.toBe(204);
      // ADR-0116: Admin holds skills and files like agents.
      await expect(status('admin', 'POST', path, 'not-applicable')).resolves.toBe(204);
      await expect(status('viewer', 'POST', path, 'not-applicable')).resolves.toBe(403);
    }
  });
});
