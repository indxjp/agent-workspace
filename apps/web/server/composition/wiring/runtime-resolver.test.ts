/**
 * The run's tool-sandbox secret source on its own: a storage connection's credential is never a
 * tool's, so the source answers it as missing without reading it, even when the secret is set and
 * the caller is not the sandbox builder.
 */
// @story US-STO-12
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';

import { runToolSecretSource } from './runtime-resolver';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';

function source() {
  const reads: string[] = [];
  const secret = runToolSecretSource(
    {
      scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
      // Every name is set, so a missing answer can only come from the guard.
      secretsService: {
        resolveByName: (_scope, name) => {
          reads.push(name);
          return Promise.resolve({ name, value: Buffer.from(`value-of-${name}`) });
        },
      },
    },
    WORKSPACE,
  );
  return { secret, reads };
}

describe('runToolSecretSource', () => {
  it('[US-STO-12][unit][run] answers a storage connection credential as missing without reading it', async () => {
    const { secret, reads } = source();
    await expect(secret('STORAGE_CONNECTION_77777777777747778777777777777777')).resolves.toBeNull();
    expect(reads).toEqual([]);
  });

  it('[US-STO-12][unit][run] reads any other secret the tool declares', async () => {
    const { secret, reads } = source();
    await expect(secret('TICKETS_TOKEN')).resolves.toBe('value-of-TICKETS_TOKEN');
    expect(reads).toEqual(['TICKETS_TOKEN']);
  });
});
