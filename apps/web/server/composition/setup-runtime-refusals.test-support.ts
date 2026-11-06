import { expect, it } from 'vitest';
import { DomainError } from '../errors';
import { configureWebRuntimeRegistry } from '../runtimes/registry';
import { captureLog } from '../telemetry/capture-log';
import {
  BAD_KEY,
  complete,
  CONNECTION_NAME,
  db,
  decryption,
  expectOneWorkingConnection,
  expectUntouched,
  install,
  LOCAL_REGISTRY,
  models,
  scope,
  SEEDED_MODEL,
  setupInput,
  snapshot,
  workspace,
} from './setup-fixture.test-support';
import { GOOD_KEY, GOOD_KEY_2 } from './setup-provider.test-support';

export function registerRuntimeRefusalsTests(): void {
  it('answers 422 runtime_test_timeout, writing nothing, when the runtime test never settles', async () => {
    configureWebRuntimeRegistry({ ...LOCAL_REGISTRY, test: () => new Promise(() => undefined) });
    try {
      const impatient = await install(db(), { runtimeTestTimeoutMs: 100 });
      const refused = await impatient.complete(setupInput());
      expect(refused).toMatchObject({ ok: false, status: 422, code: 'runtime_test_timeout' });
      await expectUntouched();
    } finally {
      configureWebRuntimeRegistry(LOCAL_REGISTRY);
      await install(db());
    }
  });

  it('answers 422 runtime_connection_missing, writing nothing, for a provider driver with no connection', async () => {
    configureWebRuntimeRegistry({
      ...LOCAL_REGISTRY,
      test: () =>
        Promise.reject(
          new DomainError({
            category: 'validation',
            code: 'runtime_connection_missing',
            publicMessage: 'Create an external runtime connection.',
          }),
        ),
    });
    try {
      await install(db());
      const refused = await complete(setupInput());
      expect(refused).toEqual({
        ok: false,
        status: 422,
        code: 'runtime_connection_missing',
        message: 'Create an external runtime connection.',
      });
      await expectUntouched();
    } finally {
      configureWebRuntimeRegistry(LOCAL_REGISTRY);
      await install(db());
    }
  });

  it("tests the runtime in the signed-in admin's workspace, taken from the session", async () => {
    const scopes: unknown[] = [];
    configureWebRuntimeRegistry({
      ...LOCAL_REGISTRY,
      test: (driverId, _echo, testScope) => {
        scopes.push(testScope);
        return Promise.resolve({ driverId, transcript: [], destroyed: true });
      },
    });
    try {
      await install(db());
      const result = await complete(setupInput());
      expect(result.ok).toBe(true);
      expect(scopes).toEqual([{ workspaceId: workspace.id }]);
    } finally {
      configureWebRuntimeRegistry(LOCAL_REGISTRY);
      await install(db());
    }
  });

  it('never overwrites a stored key it cannot decrypt, and says to check the master key', async () => {
    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    const before = await snapshot();
    const logged = captureLog();
    decryption.fails = true;
    const refused = await complete(setupInput({ providerApiKey: GOOD_KEY_2 }));
    expect(refused).toMatchObject({ ok: false, status: 500, code: 'credential_unreadable' });
    if (refused.ok) throw new Error('unreachable');
    expect(refused.message).toContain('MASTER_ENCRYPTION_KEY');
    const messages = logged.text();
    expect(messages).toContain('DecryptError');
    expect(messages).not.toContain(GOOD_KEY);
    // With the right master key back, the original key is still there.
    decryption.fails = false;
    expect(await snapshot()).toEqual(before);
    expect(before.connections[0]?.credential).toBe(GOOD_KEY);
  });

  it('a refused attempt then an accepted one leaves exactly one working connection used everywhere', async () => {
    expect(await complete(setupInput({ providerApiKey: BAD_KEY }))).toMatchObject({
      ok: false,
      code: 'provider_test_failed',
    });
    const accepted = await complete(setupInput());
    if (!accepted.ok) throw new Error(`setup refused: ${accepted.code}`);
    const connectionId = await expectOneWorkingConnection(accepted.agentId);
    expect(accepted.modelConnectionId).toBe(connectionId);

    // A later refused attempt does not touch the working state, and a re-run is idempotent.
    await complete(setupInput({ providerApiKey: BAD_KEY }));
    expect(await expectOneWorkingConnection(accepted.agentId)).toBe(connectionId);
    const again = await complete(setupInput());
    if (!again.ok) throw new Error(`the re-run was refused: ${again.code}`);
    expect(again.agentId).toBe(accepted.agentId);
    expect(await expectOneWorkingConnection(again.agentId)).toBe(connectionId);
  });

  it('repairs the connection a refused 0.2.0 attempt left: the key is replaced, not duplicated', async () => {
    // What a refused setup on 0.2.0 left behind: `anthropic default`, ready, with the rejected key.
    const store = models.forWorkspace(workspace.id);
    const stale = await store.create({
      name: CONNECTION_NAME,
      provider: 'anthropic',
      apiKey: BAD_KEY,
      config: {},
    });
    if (stale.kind !== 'created') throw new Error(`stale connection: ${stale.kind}`);
    // And, as a later administrator action might have, the default and General pointing at it.
    await db().setWorkspaceModelDefault(workspace.id, {
      connectionId: stale.connection.id,
      model: SEEDED_MODEL,
    });
    await db().agents.forScope(scope()).update(workspace.generalAgentId, {
      modelConnectionId: stale.connection.id,
      model: SEEDED_MODEL,
    });

    const accepted = await complete(setupInput());
    if (!accepted.ok) throw new Error(`setup refused: ${accepted.code}`);
    expect(accepted.modelConnectionId).toBe(stale.connection.id);
    expect(await expectOneWorkingConnection(accepted.agentId)).toBe(stale.connection.id);
  });
}
