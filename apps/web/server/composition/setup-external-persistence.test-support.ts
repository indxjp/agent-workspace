import { type SecretsService } from '@agent-workspace/core/secrets';
import { expect, it, vi } from 'vitest';
import { captureLog } from '../telemetry/capture-log';
import { log as webLogger } from '../telemetry/logger';
import { EXTERNAL, runtimeConnectionNames, storedKey } from './setup-external-fixture.test-support';
import {
  complete,
  db,
  E2B_KEY,
  E2B_KEY_2,
  expectUntouched,
  install,
  runtimeSecrets,
  scope,
  setupInput,
  withFailingRoot,
} from './setup-fixture.test-support';

export function registerExternalPersistenceTests(): void {
  it('answers 503 setup_unavailable naming the secrets store, and writes nothing, when the store throws', async () => {
    const spy = captureLog();
    const broken: SecretsService = Object.assign(Object.create(runtimeSecrets) as SecretsService, {
      list: () => Promise.reject(new Error(`store unreachable for ${E2B_KEY}`)),
    });
    await install(db(), { runtimeSecrets: broken });
    const refused = await complete(setupInput(EXTERNAL));
    expect(refused).toMatchObject({ ok: false, status: 503, code: 'setup_unavailable' });
    if (refused.ok) throw new Error('unreachable');
    expect(refused.message).toContain('secrets store');
    expect(refused.message).not.toContain(E2B_KEY);
    expect(spy.text()).not.toContain(E2B_KEY);
    await expectUntouched();
    expect(await runtimeConnectionNames()).toEqual([]);
  });

  it('answers 500 setup_failed naming persistence, and rolls back, when a write throws', async () => {
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    await withFailingRoot(
      { setWorkspaceSetupAgentId: () => Promise.reject(new Error('connection terminated')) },
      async () => {
        const refused = await complete(setupInput(EXTERNAL));
        expect(refused).toMatchObject({ ok: false, status: 500, code: 'setup_failed' });
        if (refused.ok) throw new Error('unreachable');
        expect(refused.message).toContain('persistence');
      },
    );
    await expectUntouched();
    expect(await runtimeConnectionNames()).toEqual([]);
  });

  it('rolls the runtime connection back with the rest of a refused setup', async () => {
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    await withFailingRoot({ setWorkspaceSetupAgentId: () => Promise.resolve(false) }, async () => {
      expect(await complete(setupInput(EXTERNAL))).toMatchObject({
        ok: false,
        code: 'setup_agent_missing',
      });
    });
    await expectUntouched();
    expect(await runtimeConnectionNames()).toEqual([]);
  });

  it('a retry rotates the same connection, and a refused retry puts the old key back', async () => {
    const first = await complete(setupInput(EXTERNAL));
    if (!first.ok || first.runtimeConnectionId === null) throw new Error('first setup failed');
    const connectionId = first.runtimeConnectionId;
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    await withFailingRoot({ setWorkspaceSetupAgentId: () => Promise.resolve(false) }, async () => {
      expect(
        await complete(setupInput({ ...EXTERNAL, runtimeCredential: E2B_KEY_2 })),
      ).toMatchObject({ ok: false, code: 'setup_agent_missing' });
    });
    expect(await storedKey(connectionId)).toBe(E2B_KEY);
    const profile = await db().runtimeProfiles.forScope(scope()).get(first.runtimeProfileId);
    expect(profile?.runtimeConnectionId).toBe(connectionId);

    const rotated = await complete(setupInput({ ...EXTERNAL, runtimeCredential: E2B_KEY_2 }));
    if (!rotated.ok) throw new Error(`setup refused: ${rotated.code}`);
    expect(rotated.runtimeConnectionId).toBe(connectionId);
    expect(await storedKey(connectionId)).toBe(E2B_KEY_2);
    expect(await runtimeConnectionNames()).toHaveLength(1);
  });
}
