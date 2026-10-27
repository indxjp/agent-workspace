/**
 * `runs.output_schema` and `runs.output` against a real PostgreSQL (issue #1283, ADR-0143): the
 * schema is stored at creation, the output is written only by the transition to `completed`. The
 * run's `subject` (ADR-0157) is stored at creation the same way.
 */
import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseRunRepositoryProvider, type RunRepository } from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations } from './violations.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[repositories/runs-output.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

describe.skipIf(!hasDatabase)('runs.output_schema and runs.output', () => {
  let isolated: IsolatedTestDatabase;
  let repository: RunRepository;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const outputSchema = {
    type: 'object',
    properties: { verdict: { type: 'string' } },
    required: ['verdict'],
  };
  const output = { text: '{"verdict":"ok"}', structured: { verdict: 'ok' } };

  /** One run in a fresh session (a session holds one active run at a time). */
  async function createRun(schema?: Record<string, unknown>, subject?: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    const id = crypto.randomUUID();
    await isolated.db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    const created = await repository.create({
      id,
      sessionId,
      engine: 'claude-agent-sdk',
      ...(schema === undefined ? {} : { outputSchema: schema }),
      ...(subject === undefined ? {} : { subject }),
    });
    expect(created.kind).toBe('created');
    return id;
  }

  async function stored(runId: string) {
    const rows = await isolated.db
      .select({ outputSchema: runs.outputSchema, output: runs.output })
      .from(runs)
      .where(eq(runs.id, runId));
    return rows[0];
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_p31_run_output');
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: 'run-output', name: 'Run Output' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId,
        kind: 'membership',
        membershipId,
      });
    });
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Output agent',
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: userId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
    repository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);
  }, 180_000);

  afterAll(async () => isolated.close());

  it('stores the requested schema exactly, and NULL when none was asked for', async () => {
    const asked = await createRun(outputSchema);
    const unasked = await createRun();
    expect(await stored(asked)).toEqual({ outputSchema, output: null });
    expect(await stored(unasked)).toEqual({ outputSchema: null, output: null });
  });

  it('reads the requested schema back from get(), and not on listed runs', async () => {
    const asked = await createRun(outputSchema);
    const unasked = await createRun();
    expect((await repository.get(asked))?.outputSchema).toEqual(outputSchema);
    expect((await repository.get(unasked))?.outputSchema).toBeNull();
    const page = await repository.listRuns({ limit: 200 });
    expect(page.items.find((run) => run.id === asked)?.outputSchema).toBeUndefined();
  });

  it('reads the prompt back from get() only (ADR-0158)', async () => {
    const sessionId = crypto.randomUUID();
    const id = crypto.randomUUID();
    await isolated.db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, ownerPrincipalId: principalId, agentId });
    await repository.create({ id, sessionId, engine: 'claude-agent-sdk', prompt: 'Summarise it.' });
    expect((await repository.get(id))?.prompt).toBe('Summarise it.');
    expect((await repository.get(await createRun()))?.prompt).toBeNull();
    const page = await repository.listRuns({ limit: 200 });
    expect(page.items.find((run) => run.id === id)?.prompt).toBeUndefined();
  });

  it("a run's subject is stored and read back; a run with none reads null", async () => {
    const asserted = await createRun(undefined, 'user-4711');
    const unasserted = await createRun();
    const row = async (runId: string) =>
      (await isolated.db.select({ subject: runs.subject }).from(runs).where(eq(runs.id, runId)))[0];
    expect(await row(asserted)).toEqual({ subject: 'user-4711' });
    expect(await row(unasserted)).toEqual({ subject: null });
    expect((await repository.get(asserted))?.subject).toBe('user-4711');
    expect((await repository.get(unasserted))?.subject).toBeNull();
  });

  it('writes the output with the transition to completed and reads it back', async () => {
    const runId = await createRun(outputSchema);
    expect((await repository.get(runId))?.output).toBeNull();
    const outcome = await repository.finish(runId, 'completed', null, undefined, output);
    expect(outcome.kind).toBe('moved');
    expect((await repository.get(runId))?.output).toEqual(output);
    expect((await stored(runId))?.output).toEqual(output);
  });

  it('round-trips a null structured value as null, not as a missing run output', async () => {
    const runId = await createRun();
    const plain = { text: 'done', structured: null };
    await repository.finish(runId, 'completed', null, undefined, plain);
    expect((await repository.get(runId))?.output).toEqual(plain);
  });

  it('stores an undefined structured value as null, so the run stays readable', async () => {
    const runId = await createRun();
    await repository.finish(runId, 'completed', null, undefined, {
      text: 'x',
      structured: undefined,
    });
    expect((await repository.get(runId))?.output).toEqual({ text: 'x', structured: null });
  });

  it('leaves output NULL when a run completes without one', async () => {
    const runId = await createRun();
    await repository.finish(runId, 'completed', null);
    expect((await repository.get(runId))?.output).toBeNull();
  });

  it.each(['failed', 'cancelled'] as const)(
    'refuses an output for a run that ends %s and leaves the run untouched',
    async (status) => {
      const runId = await createRun();
      await expect(repository.finish(runId, status, 'boom', undefined, output)).rejects.toThrow(
        /cannot carry an output/u,
      );
      const run = await repository.get(runId);
      expect(run?.status).toBe('queued');
      expect(run?.output).toBeNull();
      await repository.finish(runId, status, 'boom');
      expect((await repository.get(runId))?.output).toBeNull();
    },
  );

  it('keeps the first output when an already-finished run is finished again', async () => {
    const runId = await createRun();
    await repository.finish(runId, 'completed', null, undefined, output);
    const second = { text: 'later', structured: null };
    await expect(repository.finish(runId, 'completed', null, undefined, second)).resolves.toEqual({
      kind: 'no-op',
    });
    expect((await repository.get(runId))?.output).toEqual(output);
  });

  it('rejects an output on a run that has not completed (runs_output_only_when_completed)', async () => {
    const runId = await createRun();
    let thrown: unknown;
    try {
      await isolated.db.update(runs).set({ output }).where(eq(runs.id, runId));
    } catch (error) {
      thrown = error;
    }
    expect(thrown, 'the update should have been rejected').toBeDefined();
    expect([...postgresViolations(thrown)].map((violation) => violation.constraint)).toContain(
      'runs_output_only_when_completed',
    );
  });

  it('refuses to read a persisted output that is not { text, structured }', async () => {
    const runId = await createRun();
    await repository.finish(runId, 'completed', null);
    await isolated.db
      .update(runs)
      .set({ output: { text: 1 } as unknown as typeof output })
      .where(eq(runs.id, runId));
    await expect(repository.get(runId)).rejects.toThrow(/runs\.output/u);
    // Leave the shared database readable for the list test.
    await isolated.db.update(runs).set({ output: null }).where(eq(runs.id, runId));
  });

  it('carries the output on listed runs', async () => {
    const runId = await createRun();
    await repository.finish(runId, 'completed', null, undefined, output);
    const page = await repository.listRuns({ limit: 200 });
    expect(page.items.find((run) => run.id === runId)?.output).toEqual(output);
  });
});
