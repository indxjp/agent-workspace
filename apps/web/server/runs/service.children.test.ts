/** `startRunOnSession` for a child run of a team lead (ADR-0104 acceptance, #1517). */
import { describe, expect, it } from 'vitest';

import { parseStartRunBody } from './api';
import type { RunApiEnvironment } from './environment';
import type { InMemoryRunStore } from './memory-store';
import { startRunOnSession } from './service';
import { AGENT, PRINCIPAL, START, WORKSPACE, harness } from './service.test-support';

const LEAD = '88888888-8888-4888-8888-888888888888';
const TEAM_VERSION = '99999999-9999-4999-8999-999999999999';
const FAN_OUT = 16;

/** A root run that is `running`, as a lead whose member calls start children is. */
async function runningLead(env: RunApiEnvironment, store: InMemoryRunStore): Promise<string> {
  const lead = await startRunOnSession(env, PRINCIPAL, AGENT, START);
  if (lead.kind !== 'started') throw new Error(lead.code);
  expect(await store.markRunning(lead.run.id)).toBe(true);
  return lead.run.id;
}

describe('startRunOnSession: a child run of a team lead (ADR-0104 acceptance, #1517)', () => {
  it('writes parent_run_id and the team version on insert, and they are read back', async () => {
    const { env, store } = harness();
    const lead = await startRunOnSession(env, PRINCIPAL, AGENT, {
      ...START,
      agentTeamVersionId: TEAM_VERSION,
    });
    if (lead.kind !== 'started') throw new Error(lead.code);
    expect((await store.get(lead.run.id))?.agentTeamVersionId).toBe(TEAM_VERSION);
    expect(await store.markRunning(lead.run.id)).toBe(true);
    const child = await startRunOnSession(env, PRINCIPAL, AGENT, {
      ...START,
      parent: { runId: lead.run.id, maxChildren: FAN_OUT },
    });
    if (child.kind !== 'started') throw new Error(child.code);
    expect((await store.get(child.run.id))?.parentRunId).toBe(lead.run.id);
    expect((await store.get(child.run.id))?.agentTeamVersionId).toBeNull();
    expect((await store.get(lead.run.id))?.parentRunId).toBeNull();
  });

  it('refuses a child of a lead that is no longer running with parent_run_stopped', async () => {
    const { env, store, sessions } = harness();
    const leadId = await runningLead(env, store);
    await store.finish(leadId, 'cancelled', null);
    const before = sessions.size;
    await expect(
      startRunOnSession(env, PRINCIPAL, AGENT, {
        ...START,
        parent: { runId: leadId, maxChildren: FAN_OUT },
      }),
    ).resolves.toMatchObject({ kind: 'refused', status: 409, code: 'parent_run_stopped' });
    expect(sessions.size).toBe(before);
    await expect(store.listChildren(WORKSPACE, leadId, FAN_OUT)).resolves.toEqual([]);
  });

  it('refuses the start over the fan-out limit with team_member_limit, leaving no session', async () => {
    const { env, store, sessions } = harness();
    const parent = { runId: await runningLead(env, store), maxChildren: 1 };
    const first = await startRunOnSession(env, PRINCIPAL, AGENT, { ...START, parent });
    expect(first.kind).toBe('started');
    const before = sessions.size;
    await expect(
      startRunOnSession(env, PRINCIPAL, AGENT, { ...START, parent }),
    ).resolves.toMatchObject({ kind: 'refused', code: 'team_member_limit' });
    expect(sessions.size).toBe(before);
  });

  it('is refused from a request body: parseStartRunBody rejects every tree field', () => {
    for (const field of ['parent', 'parentRunId', 'agentTeamVersionId']) {
      expect(parseStartRunBody({ prompt: 'hi', [field]: LEAD })).toEqual({
        kind: 'rejected',
        reason: `unknown field ${JSON.stringify(field)} in the request body`,
      });
    }
  });
});
