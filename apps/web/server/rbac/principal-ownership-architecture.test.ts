import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

function source(relativePath: string): string {
  return readFileSync(resolve(HERE, relativePath), 'utf8');
}

function productionTypeScript(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return productionTypeScript(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });
}

describe('WorkspacePrincipal ownership architecture', () => {
  it('has no oldest-Owner identity fallback', () => {
    expect(source('./ownership.ts')).not.toMatch(/\boldestOwnerUserId\b/u);
  });

  it('authorizes durable ownership by exact principal id', () => {
    const itemOwnership = source('../resources/item-ownership.ts');
    // The caller's owner principal: its own id, or the member a local runtime key acts for (#509).
    expect(itemOwnership).toContain('principal.ownerPrincipalId === row.ownerPrincipalId');
    expect(itemOwnership).not.toContain('resolveActorUserId');
  });

  it('keeps removed actor-user resolvers out of production code', () => {
    const apiRoot = resolve(HERE, '../../app/api');
    const serverRoot = resolve(HERE, '..');
    const legacyCalls = productionTypeScript(apiRoot)
      .concat(productionTypeScript(serverRoot))
      .filter((path) =>
        /\bresolveActorUserId(?:ForWorkspace)?\s*\(/u.test(readFileSync(path, 'utf8')),
      );

    expect(legacyCalls).toEqual([]);
  });
});
