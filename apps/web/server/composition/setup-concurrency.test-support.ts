import { expect, it, vi } from 'vitest';
import { probeModelConnection } from '../models/probe';
import {
  complete,
  db,
  expectOneWorkingConnection,
  expectUntouched,
  install,
  models,
  scope,
  setupInput,
  snapshot,
  workspace,
} from './setup-fixture.test-support';
import { GOOD_KEY, GOOD_KEY_2 } from './setup-provider.test-support';

export function registerConcurrencyTests(): void {
  it('serialises the writes of two concurrent setups, even from two installed workflows', async () => {
    // Two installations stand for two replicas: separate in-process queues, one database lock.
    // Both create `anthropic default` on a fresh workspace; unserialised, one of them would be
    // refused with a name conflict and roll its rows back.
    const first = await install(db());
    const second = await install(db());
    const results = await Promise.all([
      first.complete(setupInput()),
      second.complete(setupInput({ providerApiKey: GOOD_KEY_2 })),
    ]);
    const accepted = results.map((result) => {
      if (!result.ok) throw new Error(`a concurrent setup was refused: ${result.code}`);
      return result;
    });
    expect(new Set(accepted.map((result) => result.modelConnectionId)).size).toBe(1);
    expect(new Set(accepted.map((result) => result.agentId)).size).toBe(1);
    const connectionId = await expectOneWorkingConnection(accepted[0]?.agentId ?? '', [
      GOOD_KEY,
      GOOD_KEY_2,
    ]);
    expect(connectionId).toBe(accepted[0]?.modelConnectionId);
    expect((await snapshot()).profiles).toEqual(['local default']);

    // And within one installation, two calls queue rather than overlap.
    const queued = await Promise.all([first.complete(setupInput()), first.complete(setupInput())]);
    expect(queued.every((result) => result.ok)).toBe(true);
    await expectOneWorkingConnection(accepted[0]?.agentId ?? '');
  });

  it('runs the provider checks before it takes the setup lock', async () => {
    // Another setup holds the lock; this one still probes the provider meanwhile.
    let release = (): void => undefined;
    const held = db().withWorkspaceSetupLock(
      workspace.id,
      1_000,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const probe = vi.mocked(probeModelConnection);
    const pending = complete(setupInput());
    await vi.waitFor(() => {
      expect(probe).toHaveBeenCalledTimes(1);
    });
    await expectUntouched();
    release();
    await held;
    const accepted = await pending;
    if (!accepted.ok) throw new Error(`setup refused: ${accepted.code}`);
    await expectOneWorkingConnection(accepted.agentId);
  });

  it('answers 409 setup_in_progress, writing nothing, when the lock stays held past the wait', async () => {
    let release = (): void => undefined;
    const held = db().withWorkspaceSetupLock(
      workspace.id,
      1_000,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      // Two setups through one installation: the second waits in the process's own queue behind
      // the first, which waits on the database lock; both give up at the same deadline.
      const impatient = await install(db(), { lockWaitMs: 300 });
      const started = Date.now();
      const results = await Promise.all([
        impatient.complete(setupInput()),
        impatient.complete(setupInput({ providerApiKey: GOOD_KEY_2 })),
      ]);
      expect(Date.now() - started).toBeLessThan(5_000);
      for (const result of results) {
        expect(result).toMatchObject({ ok: false, status: 409, code: 'setup_in_progress' });
      }
      await expectUntouched();
    } finally {
      release();
      await held;
      await install(db());
    }
  });

  it('answers 409 setup_conflict, writing nothing, when the connection changes during the checks', async () => {
    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    const store = models.forWorkspace(workspace.id);
    // While this re-run probes the provider, the setup connection is pointed somewhere else.
    vi.mocked(probeModelConnection).mockImplementationOnce(async () => {
      const changed = await store.update(first.modelConnectionId, {
        config: { baseUrl: 'https://anthropic-proxy.example.test' },
      });
      if (changed.kind !== 'updated') throw new Error(`fixture update: ${changed.kind}`);
      return { ok: true, status: 200, latencyMs: 1, message: 'Connection succeeded.' };
    });
    const before = await snapshot();
    const refused = await complete(
      setupInput({ providerApiKey: GOOD_KEY_2, agentInstructions: 'Changed.' }),
    );
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'setup_conflict' });
    // Only the administrator's config change landed: the key, rows and default are as they were.
    expect(await snapshot()).toEqual(before);
    expect(before.connections[0]?.credential).toBe(GOOD_KEY);
    expect((await store.get(first.modelConnectionId))?.config).toEqual({
      baseUrl: 'https://anthropic-proxy.example.test',
    });
    const agent = await db().agents.forScope(scope()).get(first.agentId);
    expect(agent?.instructions).toBe('Answer briefly.');
  });
}
