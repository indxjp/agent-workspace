/** The conformance cases for access: the rule matrix and the agent rules. */
import assert from 'node:assert/strict';

import { fakePerson } from './fake-person.js';
import type { Person } from '../person.js';
import {
  MATRIX,
  manualClock,
  matrixPeople,
  matrixResources,
  notes,
  principalOf,
  rejects,
  seedAssigned,
  tickets,
  workspace,
  type MakeStore,
  type TestRunner,
} from './conformance-support.js';

async function checkRead(
  makeStore: MakeStore,
  slug: string,
  admitted: readonly string[],
): Promise<void> {
  const resource = matrixResources.find((one) => one.name === `read_${slug}`);
  assert.ok(resource !== undefined);
  const { store } = await makeStore(resource, manualClock());
  const workspaceId = workspace();
  const people = matrixPeople(workspaceId);
  const id = await seedAssigned(store, workspaceId, principalOf(people, 'assigned'));
  const guestId = await seedAssigned(store, workspaceId, principalOf(people, 'assigned_guest'));
  for (const [label, who] of Object.entries(people)) {
    const own = label === 'assigned_guest' ? guestId : id;
    const may = admitted.includes(label);
    const listed = (await store.list(who)).items.map((item) => item.id);
    assert.equal(listed.includes(own), may, `read ${slug}: ${label} lists the record`);
    if (may) assert.equal((await store.get(who, own)).id, own);
    else await rejects(store.get(who, own), 'resource_not_found');
  }
}

async function checkWrite(
  makeStore: MakeStore,
  slug: string,
  admitted: readonly string[],
): Promise<void> {
  const resource = matrixResources.find((one) => one.name === `write_${slug}`);
  assert.ok(resource !== undefined);
  const { store } = await makeStore(resource, manualClock());
  const workspaceId = workspace();
  const people = matrixPeople(workspaceId);
  for (const [label, who] of Object.entries(people)) {
    const assigned = label.startsWith('assigned');
    const may = admitted.includes(label);
    const assignee = assigned ? who.principalId : crypto.randomUUID();
    const create = store.create(who, { title: 'new', assignee });
    if (may) await create;
    else await rejects(create, 'forbidden');
    // A guest reads nothing under `read: 'member'`, so its update and delete are concealed.
    const canRead = who.role !== null;
    const target = await seedAssigned(store, workspaceId, assignee);
    const update = store.update(who, target, { title: 'changed' });
    const remove = (): Promise<void> => store.delete(who, target);
    if (!canRead) {
      await rejects(update, 'resource_not_found');
      await rejects(remove(), 'resource_not_found');
    } else if (may) {
      await update;
      await remove();
    } else {
      await rejects(update, 'forbidden');
      await rejects(remove(), 'forbidden');
    }
  }
}

export function registerAccessMatrix(runner: TestRunner, makeStore: MakeStore): void {
  for (const [slug, , admitted] of MATRIX) {
    runner.it(`access matrix: read rule ${slug}`, () => checkRead(makeStore, slug, admitted));
    runner.it(`access matrix: create, update and delete rule ${slug}`, () =>
      checkWrite(makeStore, slug, admitted),
    );
  }
}

export function registerAgentCases(runner: TestRunner, makeStore: MakeStore): void {
  runner.it('an agent write within agents.write succeeds, in its run', async () => {
    const { store, auditEvents } = await makeStore(tickets, manualClock());
    const workspaceId = workspace();
    const admin = fakePerson({ workspaceId, role: 'admin' });
    const agent = fakePerson({
      workspaceId,
      role: 'admin',
      via: 'agent',
      principalId: admin.principalId,
    });
    const record = await store.create(agent, { title: 'filed by an agent' });
    const updated = await store.update(agent, record.id, { status: 'pending' });
    assert.equal(updated['status'], 'pending');
    const events = (await auditEvents()).filter((event) => event.record_id === record.id);
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.via, 'agent');
      assert.equal(event.run_id, agent.runId);
    }
  });

  runner.it('an agent write outside agents.write is forbidden', async () => {
    const { store } = await makeStore(tickets, manualClock());
    const workspaceId = workspace();
    const admin = fakePerson({ workspaceId, role: 'admin' });
    const agent = fakePerson({ workspaceId, role: 'admin', via: 'agent' });
    const record = await store.create(admin, { title: 'by hand' });
    await rejects(store.update(agent, record.id, { priority: 3 }), 'forbidden', [
      'fields:priority',
    ]);
    await rejects(
      store.create(agent, { title: 'x', priority: 1, assignee: admin.principalId }),
      'forbidden',
      ['fields:assignee', 'fields:priority'],
    );
    const other = await makeStore(notes, manualClock());
    await rejects(other.store.create(agent, { title: 'x' }), 'forbidden', ['agents.write']);
    const runless = { ...agent, runId: undefined } as unknown as Person;
    await rejects(store.update(runless, record.id, { status: 'closed' }), 'forbidden', ['run_id']);
    assert.equal((await store.get(admin, record.id))['priority'], null);
  });

  runner.it("an agent cannot exceed the person's access", async () => {
    const { store } = await makeStore(tickets, manualClock());
    const workspaceId = workspace();
    const admin = fakePerson({ workspaceId, role: 'admin' });
    const builderAgent = fakePerson({ workspaceId, role: 'builder', via: 'agent' });
    const guestAgent = fakePerson({ workspaceId, role: null, via: 'agent' });
    const record = await store.create(admin, { title: 'admins only' });
    // `update` is admin-or-assignee and `delete` admin: a builder's agent may do neither, even on
    // a field agents may write.
    await rejects(store.update(builderAgent, record.id, { status: 'closed' }), 'forbidden');
    await rejects(store.delete(builderAgent, record.id), 'forbidden');
    await rejects(store.create(guestAgent, { title: 'x' }), 'forbidden');
    const adminAgent = fakePerson({ workspaceId, role: 'admin', via: 'agent' });
    await store.delete(adminAgent, record.id);
  });

  runner.it('an agent reads only where the resource lets agents read', async () => {
    const other = await makeStore(notes, manualClock());
    const agent = fakePerson({ role: 'owner', via: 'agent', workspaceId: workspace() });
    await rejects(other.store.list(agent), 'forbidden', ['agents.read']);
  });
}
