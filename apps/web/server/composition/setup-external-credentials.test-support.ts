import { type WorkspaceScope } from '@agent-workspace/core/db';
import { createSecretsService, type SecretsService } from '@agent-workspace/core/secrets';
import crypto from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { log as webLogger } from '../telemetry/logger';
import {
  EXTERNAL,
  runtimeConnectionNames,
  storedKey,
  testedWith,
} from './setup-external-fixture.test-support';
import {
  complete,
  db,
  E2B_ENDPOINT,
  E2B_KEY,
  E2B_KEY_2,
  expectUntouched,
  install,
  isolated,
  runtimeSecrets,
  scope,
  setupInput,
} from './setup-fixture.test-support';

export function registerExternalCredentialsTests(): void {
  it('refuses a key for a driver that takes none, before testing or writing anything', async () => {
    const refused = await complete(setupInput({ ...EXTERNAL, runtime: 'local' }));
    expect(refused).toMatchObject({ ok: false, status: 400, code: 'invalid_setup' });
    expect(testedWith).toEqual([]);
    await expectUntouched();
    expect(await runtimeConnectionNames()).toEqual([]);
  });

  it('still answers 422 runtime_connection_missing without a key, naming the setup fields', async () => {
    const refused = await complete(setupInput({ runtime: 'external' }));
    expect(refused).toMatchObject({ ok: false, status: 422, code: 'runtime_connection_missing' });
    if (refused.ok) throw new Error('unreachable');
    expect(refused.message).toContain('runtimeCredential');
    await expectUntouched();
  });

  it('answers 503 setup_unavailable when encrypted runtime storage is unavailable, before any check', async () => {
    await install(db(), { runtimeSecrets: null });
    const refused = await complete(setupInput(EXTERNAL));
    expect(refused).toMatchObject({ ok: false, status: 503, code: 'setup_unavailable' });
    expect(testedWith).toEqual([]);
    await expectUntouched();
  });

  it('never overwrites a stored key it cannot read, and names no key in the refusal', async () => {
    if (isolated === undefined) throw new Error('the isolated database is not open');
    const otherMasterKey = await createSecretsService({
      MASTER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      DATABASE_URL: isolated.url,
    });
    try {
      const name = 'RUNTIME_CONNECTION__EXTERNAL__EXTERNAL_DEFAULT';
      const sealed = JSON.stringify({ endpoint: E2B_ENDPOINT, credential: E2B_KEY_2 });
      const seeded = await otherMasterKey.create(scope(), {
        name,
        value: Buffer.from(sealed, 'utf8'),
      });
      if (seeded.kind !== 'created') throw new Error('the unreadable key was not seeded');

      const refused = await complete(setupInput(EXTERNAL));
      expect(refused).toMatchObject({ ok: false, status: 500, code: 'credential_unreadable' });
      if (refused.ok) throw new Error('unreachable');
      expect(refused.message).not.toContain(E2B_KEY);
      expect(refused.message).not.toContain(E2B_KEY_2);
      expect((await otherMasterKey.resolveByName(scope(), name))?.value.toString('utf8')).toBe(
        sealed,
      );
      await expectUntouched();
      expect(await runtimeConnectionNames()).toEqual([name]);
    } finally {
      await otherMasterKey.close();
    }
  });

  it('answers 409 when the runtime connection cannot be created, writing nothing', async () => {
    const conflicting: SecretsService = Object.assign(
      Object.create(runtimeSecrets) as SecretsService,
      {
        create: (_scope: WorkspaceScope, input: { readonly name: string }) =>
          Promise.resolve({ kind: 'name-conflict' as const, name: input.name }),
      },
    );
    await install(db(), { runtimeSecrets: conflicting });
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const refused = await complete(setupInput(EXTERNAL));
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'name-conflict' });
    await expectUntouched();
    expect(await runtimeConnectionNames()).toEqual([]);
  });

  it('answers 500 when a retry cannot rotate the stored key, keeping the old one', async () => {
    const first = await complete(setupInput(EXTERNAL));
    if (!first.ok || first.runtimeConnectionId === null) throw new Error('first setup failed');
    const vanishing: SecretsService = Object.assign(
      Object.create(runtimeSecrets) as SecretsService,
      { replace: () => Promise.resolve({ kind: 'not-found' as const }) },
    );
    await install(db(), { runtimeSecrets: vanishing });
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const refused = await complete(setupInput({ ...EXTERNAL, runtimeCredential: E2B_KEY_2 }));
    expect(refused).toMatchObject({
      ok: false,
      status: 500,
      code: 'runtime_connection_unavailable',
    });
    if (refused.ok) throw new Error('unreachable');
    expect(refused.message).not.toContain(E2B_KEY_2);
    expect(await storedKey(first.runtimeConnectionId)).toBe(E2B_KEY);
  });

  it('refuses a wrong administrator password before it looks at the key', async () => {
    const refused = await complete(setupInput({ ...EXTERNAL, adminPassword: 'wrong password' }));
    expect(refused).toMatchObject({ ok: false, status: 401 });
    expect(testedWith).toEqual([]);
    expect(await runtimeConnectionNames()).toEqual([]);
  });
}
