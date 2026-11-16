import { DEMO_WORKSPACE_LIFETIME_SECONDS } from '@indx-workspace/contracts/email-link';
import { describe, expect, it } from 'vitest';

import { createGuestWorkspaceBinder } from '../../email-link/adapters/guest-workspace/production';
import { counterIds } from '../../ids';
import { asOwner } from '../../rbac/directory.test-support';
import { MemoryLeadStore } from '../adapters/leads/memory';
import { createDemoProvisioner } from './binder';
import type { DemoRunLimits } from './ports';
import type { TemplateSpec } from './templates.contract';
import { createMemoryTemplatesWorld } from './templates.world.test-support';

const T0 = new Date('2026-11-16T09:00:00.000Z');
const after = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

const SPEC: TemplateSpec = {
  agent: { name: 'sales-helper', instructions: 'Help.', maxTurns: 12, maxBudgetUsd: 0.6 },
  files: [{ path: 'deals/q1.csv', text: 'id,amount\n1,100\n' }],
  assign: [{ path: 'deals', access: 'read' }],
};
const LIMITS: DemoRunLimits = { maxTurns: 6, maxBudgetUsd: 0.25 };

async function setup() {
  const world = createMemoryTemplatesWorld();
  const leads = new MemoryLeadStore();
  const provisioner = createDemoProvisioner({
    directoryBinder: createGuestWorkspaceBinder({ directory: world.directory, ids: counterIds() }),
    templates: world.templates,
    leads,
    limits: LIMITS,
  });
  const first = world.entry('sales');
  const second = world.entry('ops');
  await world.seedTemplate(first, SPEC);
  await world.seedTemplate(second, {
    ...SPEC,
    agent: { ...SPEC.agent, name: 'ops-helper' },
    files: [{ path: 'tickets/t1.txt', text: 'ticket' }],
    assign: [{ path: 'tickets', access: 'read' }],
  });
  return { world, leads, provisioner, first, second };
}

describe('the demo provisioner', () => {
  it('binds the visitor with the entry copied in under the settings caps, and records the lead with the entry', async () => {
    const { world, leads, provisioner, first } = await setup();
    const binding = await provisioner.bind({
      email: 'Visitor@Example.test',
      now: T0,
      entry: first,
    });
    expect(binding?.created).toBe(true);
    const workspaceId = binding?.workspaceId ?? '';
    const [agent] = await world.agents(workspaceId);
    expect(agent?.name).toBe('sales-helper');
    expect(agent?.policy?.limits).toEqual({ maxTurns: 6, maxBudgetUsd: 0.25 });
    expect(await world.fileText(workspaceId, 'deals/q1.csv')).toBe('id,amount\n1,100\n');
    expect(leads.leads).toEqual([
      {
        email: 'visitor@example.test',
        entries: [first],
        enquiry: null,
        enquirySetup: null,
        launchNotices: [],
        createdAt: T0,
        lastContactAt: T0,
      },
    ]);
  });

  it('binds the workspace alone, copies nothing and records a lead with no entry, when no entry is chosen', async () => {
    const { world, leads, provisioner } = await setup();
    const binding = await provisioner.bind({ email: 'plain@example.test', now: T0 });
    expect(await world.agents(binding?.workspaceId ?? '')).toEqual([]);
    expect(leads.leads.map((lead) => lead.entries)).toEqual([[]]);
  });

  it('is idempotent per entry: the same visitor and entry again adds no second agent and no second entry', async () => {
    const { world, leads, provisioner, first } = await setup();
    const one = await provisioner.bind({ email: 'again@example.test', now: T0, entry: first });
    const two = await provisioner.bind({
      email: 'again@example.test',
      now: after(60),
      entry: first,
    });
    expect(two).toEqual({ ...one, created: false });
    expect(await world.agents(one?.workspaceId ?? '')).toHaveLength(1);
    expect(leads.leads).toHaveLength(1);
    expect(leads.leads[0]?.entries).toEqual([first]);
    expect(leads.leads[0]?.lastContactAt).toEqual(after(60));
  });

  it('adds a second entry to the same workspace within the day and records both entries on the lead', async () => {
    const { world, leads, provisioner, first, second } = await setup();
    const one = await provisioner.bind({ email: 'two@example.test', now: T0, entry: first });
    const two = await provisioner.bind({
      email: 'two@example.test',
      now: after(3600),
      entry: second,
    });
    expect(two?.workspaceId).toBe(one?.workspaceId);
    const names = (await world.agents(one?.workspaceId ?? '')).map((agent) => agent.name).sort();
    expect(names).toEqual(['ops-helper', 'sales-helper']);
    expect(leads.leads[0]?.entries).toEqual([first, second]);
  });

  it('makes a new workspace with the entry copied in once the 24 hours have passed', async () => {
    const { world, provisioner, first } = await setup();
    const one = await provisioner.bind({ email: 'late@example.test', now: T0, entry: first });
    const two = await provisioner.bind({
      email: 'late@example.test',
      now: after(DEMO_WORKSPACE_LIFETIME_SECONDS + 1),
      entry: first,
    });
    expect(two?.created).toBe(true);
    expect(two?.workspaceId).not.toBe(one?.workspaceId);
    expect(await world.agents(two?.workspaceId ?? '')).toHaveLength(1);
  });

  it('says an entry has no demo until its template exists, and fails to bind it', async () => {
    const { world, leads, provisioner } = await setup();
    const unknown = world.entry('nothing');
    expect(await provisioner.hasEntry(unknown)).toBe(false);
    await expect(
      provisioner.bind({ email: 'x@example.test', now: T0, entry: unknown }),
    ).rejects.toThrow(/no demo template/u);
    expect(leads.leads).toEqual([]);
  });

  it('answers hasEntry true for an entry with a template', async () => {
    const { provisioner, first } = await setup();
    expect(await provisioner.hasEntry(first)).toBe(true);
  });

  it('binds nothing, copies nothing and records no lead for an address with a real membership', async () => {
    const { world, leads, provisioner, first } = await setup();
    await world.directory
      .forWorkspace('real-workspace')
      .createUser({ email: 'real@example.test', name: 'Real', role: asOwner('viewer') });
    expect(
      await provisioner.bind({ email: 'real@example.test', now: T0, entry: first }),
    ).toBeNull();
    expect(leads.leads).toEqual([]);
  });
});
