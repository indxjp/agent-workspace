import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AgentStorePort, CallContext } from '../../ports';
import { draftBody } from '../checker/checker.contract';
import type { AgentState, AuditEventRow } from '../../testing/views';

export interface StoreFixture {
  readonly port: AgentStorePort;
  /** A builder in the workspace. */
  readonly ctx: CallContext;
  readonly viewer: CallContext;
  readonly noCaller: CallContext;
  /** A builder in another workspace, who must never reach this workspace's agents. */
  readonly otherWorkspace: CallContext;
  readonly personId: string;
  /** Points `production` at `version`, as a person promoting through the console would. */
  readonly seedProduction: (agentId: string, version: number) => Promise<void>;
  /** Marks the agent a built-in one, as the platform seeds them: nothing but the platform changes it. */
  readonly markBuiltin: (agentId: string) => Promise<void>;
  readonly inspect: (agentId: string) => Promise<AgentState>;
  /** The `agent-created` rows that name `agentId`, as saved. */
  readonly auditEvents: (agentId: string) => Promise<readonly AuditEventRow[]>;
}

const nameOf = () => `agent-${crypto.randomUUID().slice(0, 8)}`;

/** Memory and production save a draft the same way: `local` only, `via: 'builder'`, never past a moved `local`. */
export function describeAgentStoreConformance(
  label: string,
  make: () => Promise<StoreFixture>,
): void {
  describe(`AgentStorePort: ${label}`, () => {
    async function start() {
      const fixture = await make();
      const name = nameOf();
      const save = (agentId: string | undefined, baseVersion: number | null = null) =>
        agentId === undefined
          ? fixture.port.save(fixture.ctx, { body: draftBody(name) })
          : fixture.port.save(fixture.ctx, { agentId, baseVersion, body: draftBody(name) });
      const created = await save(undefined);
      if (!created.ok) throw new Error(`the first save failed: ${created.code}`);
      return { ...fixture, save, agentId: created.agentId, created };
    }

    it('saves a new agent as version 1 on local, by the person, via the Builder', async () => {
      const { created, agentId, inspect, personId } = await start();
      expect(created).toEqual({ ok: true, agentId, version: 1 });
      expect(await inspect(agentId)).toEqual({
        versions: [{ number: 1, via: 'builder', createdByPrincipalId: personId }],
        local: 1,
        production: null,
      });
    });

    it('writes one agent-created row for a new agent, naming the person and the run, and none for a new version', async () => {
      const { save, agentId, auditEvents, ctx, personId } = await start();
      expect(await auditEvents(agentId)).toEqual([
        expect.objectContaining({
          action: 'agent-created',
          subjectId: agentId,
          actorPrincipalId: personId,
          details: { agentId, version: 1, via: 'builder', builderRunId: ctx.runId },
        }),
      ]);
      await save(agentId, 1);
      expect(await auditEvents(agentId)).toHaveLength(1);
    });

    it('counts new agents since a time, refuses a new one at the limit, and never counts a new version', async () => {
      const { port, ctx, save, agentId } = await start();
      // The database fixture shares one workspace across tests, so the counts are relative.
      const since = new Date(Date.now() - 86_400_000);
      const base = await port.creationsSince(ctx, since);
      expect(base).toBeGreaterThanOrEqual(1);
      await save(agentId, 1);
      expect(await port.creationsSince(ctx, since)).toBe(base);
      expect(await port.creationsSince(ctx, new Date(Date.now() + 60_000))).toBe(0);
      const body = draftBody(nameOf());
      expect(await port.save(ctx, { body, quota: { since, limit: base } })).toMatchObject({
        ok: false,
        code: 'quota_exceeded',
      });
      expect(await port.creationsSince(ctx, since)).toBe(base);
      expect(await port.save(ctx, { body, quota: { since, limit: base + 1 } })).toMatchObject({
        ok: true,
      });
      expect(await port.creationsSince(ctx, since)).toBe(base + 1);
    });

    it('refuses a run id over 128 characters as lineage, before writing a thing', async () => {
      const fixture = await make();
      const created = await fixture.port.save(
        { ...fixture.ctx, runId: 'r'.repeat(129) },
        { body: draftBody(nameOf()), createdByAgent: { agentId: crypto.randomUUID(), version: 1 } },
      );
      // A run id that long breaks a server invariant: the internal-error refusal, no admin fix text.
      expect(created).toMatchObject({ ok: false, code: 'internal_error' });
      expect(JSON.stringify(created)).not.toMatch(/allow|admin/i);
    });

    it('saves a new version from the current local and moves local to it', async () => {
      const { save, agentId, inspect, personId } = await start();
      expect(await save(agentId, 1)).toEqual({ ok: true, agentId, version: 2 });
      expect(await inspect(agentId)).toEqual({
        versions: [
          { number: 1, via: 'builder', createdByPrincipalId: personId },
          { number: 2, via: 'builder', createdByPrincipalId: personId },
        ],
        local: 2,
        production: null,
      });
    });

    it('refuses a stale base with where local is now, and leaves the new version unpointed', async () => {
      const { save, agentId, inspect } = await start();
      await save(agentId, 1);
      expect(await save(agentId, 1)).toEqual({ ok: false, code: 'pointer_moved', current: 2 });
      const state = await inspect(agentId);
      expect(state.local).toBe(2);
      expect(state.versions.map((version) => version.number)).toEqual([1, 2, 3]);
    });

    it('never moves production', async () => {
      const { save, agentId, inspect, seedProduction } = await start();
      await seedProduction(agentId, 1);
      await save(agentId, 1);
      await save(agentId, 1);
      expect((await inspect(agentId)).production).toBe(1);
    });

    it('refuses a Viewer and a run with no person, and writes nothing', async () => {
      const { port, ctx, viewer, noCaller } = await make();
      const body = draftBody(nameOf());
      expect(await port.save(viewer, { body })).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await port.save(noCaller, { body })).toMatchObject({ ok: false, code: 'no_caller' });
      expect(await port.save(ctx, { body })).toMatchObject({ ok: true, version: 1 });
    });

    it('refuses a save to a built-in agent with builtin_agent_read_only, and writes nothing', async () => {
      const { save, agentId, markBuiltin, inspect } = await start();
      await markBuiltin(agentId);
      const before = await inspect(agentId);
      expect(await save(agentId, 1)).toMatchObject({ ok: false, code: 'builtin_agent_read_only' });
      expect(await inspect(agentId)).toEqual(before);
    });

    it('answers null to a run with no person, even for an agent that exists', async () => {
      const { agentId, port, noCaller } = await start();
      expect(await port.localVersion(noCaller, agentId)).toBeNull();
    });

    it('answers the version local points at, or null for none', async () => {
      const { save, agentId, port, ctx } = await start();
      expect(await port.localVersion(ctx, agentId)).toBe(1);
      await save(agentId, 1);
      expect(await port.localVersion(ctx, agentId)).toBe(2);
      expect(await port.localVersion(ctx, crypto.randomUUID())).toBeNull();
    });

    it('never reaches an agent of another workspace', async () => {
      const { port, agentId, otherWorkspace, inspect } = await start();
      expect(
        await port.save(otherWorkspace, { agentId, baseVersion: 1, body: draftBody(nameOf()) }),
      ).toMatchObject({ ok: false, code: 'agent_not_found' });
      expect(await port.localVersion(otherWorkspace, agentId)).toBeNull();
      expect((await inspect(agentId)).versions).toHaveLength(1);
    });
  });
}
