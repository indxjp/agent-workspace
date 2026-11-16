import { auditEvents } from '@agent-workspace/core/db/unscoped';
import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { probeModelConnection } from '../models/probe';
import {
  adminUserId,
  BAD_KEY,
  complete,
  db,
  expectUntouched,
  install,
  isolated,
  models,
  scope,
  SEEDED_MODEL,
  setupInput,
  snapshot,
  workspace,
} from './setup-fixture.test-support';

export function registerProviderRefusalsTests(): void {
  it('a refused provider test persists nothing: no connection, credential or other write', async () => {
    const refused = await complete(setupInput({ providerApiKey: BAD_KEY }));
    expect(refused).toEqual({
      ok: false,
      status: 422,
      code: 'provider_test_failed',
      message: 'Provider returned HTTP 401.',
    });
    await expectUntouched();
  });

  it('probes and stores the provider base URL setup was given, and a refusal restores the stored one', async () => {
    const baseUrl = 'https://fake-provider.example.test';
    const first = await complete(setupInput({ providerBaseUrl: baseUrl }));
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    expect(vi.mocked(probeModelConnection).mock.calls[0]?.[0].connection.config).toEqual({
      baseUrl,
    });
    const store = models.forWorkspace(workspace.id);
    expect((await store.get(first.modelConnectionId))?.config).toEqual({ baseUrl });

    // A retry that names another URL moves the row; one the provider refuses leaves it as it was.
    const other = 'https://other-provider.example.test';
    const refused = await complete(setupInput({ providerApiKey: BAD_KEY, providerBaseUrl: other }));
    expect(refused).toMatchObject({ ok: false, code: 'provider_test_failed' });
    expect((await store.get(first.modelConnectionId))?.config).toEqual({ baseUrl });
    const moved = await complete(setupInput({ providerBaseUrl: other }));
    if (!moved.ok) throw new Error(`setup refused: ${moved.code}`);
    expect(moved.modelConnectionId).toBe(first.modelConnectionId);
    expect((await store.get(first.modelConnectionId))?.config).toEqual({ baseUrl: other });
  });

  it('refuses over the policy ceiling before the setup lock: one audit row, nothing written (issue #535)', async () => {
    const live = db();
    const locked = vi.spyOn(live, 'withWorkspaceSetupLock');
    await install(live, { policyCeiling: { models: ['claude-opus-4-1'] } });
    try {
      expect(await complete(setupInput())).toEqual({
        ok: false,
        status: 403,
        code: 'policy_cannot_widen',
        message: `The first agent would be wider than this deployment's policy ceiling allows: model:${SEEDED_MODEL}`,
      });
    } finally {
      await install(live);
    }
    expect(locked).not.toHaveBeenCalled();
    await expectUntouched();
    if (isolated === undefined) throw new Error('the isolated database is not open');
    const rows = await isolated.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, workspace.id));
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'agent-changed',
        actorPrincipalId: workspace.principalId,
        actorUserId: adminUserId,
        subjectId: null,
        subjectLabel: `Setup Wizard Agent: refused policy_cannot_widen model:${SEEDED_MODEL}`,
      }),
    ]);
  });

  it('judges the agent a re-run updates with its stored policy (issue #535)', async () => {
    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup failed: ${first.code}`);
    const before = await snapshot();
    // The agent setup will update keeps this stored policy, so its limit is judged too.
    const replaced = await db()
      .agents.forScope(scope())
      .replacePolicy(first.agentId, {
        engine: 'claude-agent-sdk',
        tools: {
          base: 'claude_code_preset',
          autoApprove: [],
          deny: [],
          permissionMode: 'default',
          allowDangerouslySkipPermissions: false,
        },
        skills: { mode: 'all' },
        limits: { maxTurns: 50, maxBudgetUsd: null },
      });
    expect(replaced.kind).toBe('updated');
    const live = db();
    await install(live, { policyCeiling: { limits: { maxTurns: 10 } } });
    try {
      expect(await complete(setupInput())).toMatchObject({
        ok: false,
        status: 403,
        code: 'policy_cannot_widen',
        message: expect.stringContaining('limits.maxTurns') as unknown,
      });
    } finally {
      await install(live);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('an administrator password that does not match persists nothing', async () => {
    const refused = await complete(setupInput({ adminPassword: 'not-the-one-time-password' }));
    expect(refused).toMatchObject({ ok: false, status: 401, code: 'invalid_credentials' });
    await expectUntouched();
  });

  it('a refusal after the provider test (no runtime) persists nothing either', async () => {
    const refused = await complete(setupInput({ runtime: 'docker' }));
    expect(refused).toMatchObject({ ok: false, status: 422, code: 'runtime_unavailable' });
    await expectUntouched();
  });
}
