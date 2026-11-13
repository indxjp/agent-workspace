/**
 * What the `ResourceStore` conformance cases share: the harness types, the fixture resources, the
 * access matrix, and the small helpers a case uses (a hand-set clock, a refusal check, people).
 */
import assert from 'node:assert/strict';

import { enumOf, number, person, richText, text } from '../fields/index.js';
import type { Person } from '../person.js';
import { defineResource, type AccessRule, type DefinedResource } from '../resource.js';
import { AppStoreError, type AppStoreErrorCode } from '../db/errors.js';
import type { AfterWrite, AuditEvent, OnCommitted, ResourceStore } from '../db/port.js';
import { fakePerson } from './fake-person.js';

/** A store under test and the audit rows it has written. */
interface StoreHarness {
  readonly store: ResourceStore;
  readonly auditEvents: () => Promise<readonly AuditEvent[]>;
}

/** Makes a store of `resource`; `now` is its clock, and `afterWrite` and `onCommitted` its hooks. */
export type MakeStore = (
  resource: DefinedResource,
  options: {
    readonly now: () => Date;
    readonly afterWrite?: AfterWrite;
    readonly onCommitted?: OnCommitted;
  },
) => StoreHarness | Promise<StoreHarness>;

/** The parts of a test runner the suite uses. */
export interface TestRunner {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
}

const ticketFields = {
  title: text({ max: 200 }),
  body: richText({ optional: true }),
  status: enumOf(['open', 'pending', 'closed'], { default: 'open' }),
  assignee: person({ optional: true }),
  priority: number({ min: 0, max: 10, optional: true }),
};

/** The main fixture: searched, audited, with a board, agents writing two fields. */
export const tickets = defineResource({
  name: 'ticket',
  fields: ticketFields,
  access: {
    read: 'member',
    create: 'member',
    update: ['role:admin', 'assignee'],
    delete: 'role:admin',
  },
  agents: { read: true, write: ['title', 'status'] },
  search: ['title', 'body'],
  board: 'status',
});

/** No search, no audit, no agents. */
export const notes = defineResource({
  name: 'note',
  fields: { title: text() },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
  audit: false,
});

/** The access rules the matrix covers, each with the people (below) it admits. */
export const MATRIX: readonly (readonly [
  string,
  AccessRule | readonly AccessRule[],
  readonly string[],
])[] = [
  ['member', 'member', ['viewer', 'builder', 'admin', 'owner', 'assigned']],
  ['role_viewer', 'role:viewer', ['viewer', 'builder', 'admin', 'owner', 'assigned']],
  ['role_builder', 'role:builder', ['builder', 'admin', 'owner']],
  ['role_admin', 'role:admin', ['admin', 'owner']],
  ['role_owner', 'role:owner', ['owner']],
  ['assignee', 'assignee', ['assigned', 'assigned_guest']],
  ['any_of', ['role:admin', 'assignee'], ['admin', 'owner', 'assigned', 'assigned_guest']],
];

function matrixResource(
  slug: string,
  rule: AccessRule | readonly AccessRule[],
  family: 'read' | 'write',
): DefinedResource {
  const rules = rule as AccessRule;
  return defineResource({
    name: `${family}_${slug}`,
    fields: { title: text(), assignee: person({ optional: true }) },
    access:
      family === 'read'
        ? { read: rules, create: 'member', update: 'member', delete: 'member' }
        : { read: 'member', create: rules, update: rules, delete: rules },
    audit: false,
  });
}

export const matrixResources = MATRIX.flatMap(([slug, rule]) => [
  matrixResource(slug, rule, 'read'),
  matrixResource(slug, rule, 'write'),
]);

/** The people of the matrix, in one workspace; the `assigned*` ones are a record's assignee. */
export function matrixPeople(workspaceId: string): Readonly<Record<string, Person>> {
  return {
    guest: fakePerson({ workspaceId, role: null }),
    viewer: fakePerson({ workspaceId, role: 'viewer' }),
    builder: fakePerson({ workspaceId, role: 'builder' }),
    admin: fakePerson({ workspaceId, role: 'admin' }),
    owner: fakePerson({ workspaceId, role: 'owner' }),
    assigned: fakePerson({ workspaceId, role: 'viewer' }),
    assigned_guest: fakePerson({ workspaceId, role: null }),
  };
}

export function principalOf(people: Readonly<Record<string, Person>>, label: string): string {
  const one = people[label];
  assert.ok(one !== undefined, `no ${label} in the matrix`);
  return one.principalId;
}

export async function rejects(
  operation: Promise<unknown>,
  code: AppStoreErrorCode,
  details?: readonly string[],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof AppStoreError, `expected an AppStoreError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (details !== undefined) assert.deepEqual(error.details, details);
    return true;
  });
}

/** A clock a test moves by hand. */
export function manualClock(): { now: () => Date; set(at: string): void } {
  let current = new Date('2026-10-01T00:00:00.000Z');
  return {
    now: () => new Date(current),
    set(at: string) {
      current = new Date(at);
    },
  };
}

export function workspace(): string {
  return crypto.randomUUID();
}

/**
 * Makes a record assigned to `assigneeId`, written by an owner who is that assignee, so every rule
 * of the matrix admits the write.
 */
export async function seedAssigned(
  store: ResourceStore,
  workspaceId: string,
  assigneeId: string,
): Promise<string> {
  const writer = fakePerson({ workspaceId, role: 'owner', principalId: assigneeId });
  const record = await store.create(writer, { title: 'seeded', assignee: assigneeId });
  return record.id;
}
