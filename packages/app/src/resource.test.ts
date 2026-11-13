import { DefinitionError } from '@indx-workspace/sdk/define';
import { describe, expect, it } from 'vitest';

import {
  defineResource,
  enumOf,
  files,
  isDefinedResource,
  money,
  person,
  richText,
  text,
  type ResourceInput,
} from './index.js';

/** The ticket of the app kit's resource design, as written there. */
function ticketInput() {
  return {
    name: 'ticket',
    fields: {
      title: text({ max: 200 }),
      description: richText(),
      status: enumOf(['new', 'in_progress', 'resolved', 'closed'], { default: 'new' }),
      priority: enumOf(['p1', 'p2', 'p3', 'p4'], { default: 'p3' }),
      assignee: person({ optional: true }),
      requester: person(),
      attachments: files(),
    },
    access: {
      read: 'member',
      create: 'member',
      update: ['assignee', 'role:admin'],
      delete: 'role:admin',
    },
    agents: { read: true, write: ['status', 'priority', 'assignee'] },
    search: ['title', 'description'],
    audit: true,
  } as const;
}

/** Calls `defineResource` with a value the types would refuse, returning what it threw. */
function refusal(input: unknown): DefinitionError {
  try {
    defineResource(input as ResourceInput);
  } catch (error) {
    if (error instanceof DefinitionError) return error;
    throw error;
  }
  throw new Error('defineResource accepted the input');
}

describe('defineResource', () => {
  it('accepts the ticket example and fills in the defaults', () => {
    const ticket = defineResource(ticketInput());
    expect(isDefinedResource(ticket)).toBe(true);
    expect(ticket.name).toBe('ticket');
    expect(ticket.plural).toBe('tickets');
    expect(ticket.access).toEqual({
      read: ['member'],
      create: ['member'],
      update: ['assignee', 'role:admin'],
      delete: ['role:admin'],
    });
    expect(ticket.agents).toEqual({ read: true, write: ['status', 'priority', 'assignee'] });
    expect(ticket.search).toEqual(['title', 'description']);
    expect(ticket.audit).toBe(true);
    expect(Object.keys(ticket.fields)).toEqual([
      'title',
      'description',
      'status',
      'priority',
      'assignee',
      'requester',
      'attachments',
    ]);
  });

  it('defaults agents to nothing and audit to on, and takes a plural and a board', () => {
    const company = defineResource({
      name: 'company',
      plural: 'companies',
      fields: { name: text(), stage: enumOf(['lead', 'won']) },
      access: { read: 'member', create: 'member', update: 'member', delete: 'role:owner' },
      board: 'stage',
    });
    expect(company.plural).toBe('companies');
    expect(company.agents).toEqual({ read: false, write: false });
    expect(company.search).toEqual([]);
    expect(company.audit).toBe(true);
    expect(company.board).toBe('stage');
  });

  it('is frozen, and JSON shows no brand', () => {
    const ticket = defineResource(ticketInput());
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(Object.isFrozen(ticket.fields)).toBe(true);
    expect(Object.isFrozen(ticket.access.update)).toBe(true);
    expect(Object.isFrozen(ticket.agents)).toBe(true);
    const json = JSON.stringify(ticket);
    expect(json).not.toContain('agentworkspace');
    expect(Object.keys(JSON.parse(json) as object)).toEqual([
      'name',
      'plural',
      'fields',
      'access',
      'agents',
      'search',
      'audit',
    ]);
    expect(isDefinedResource(JSON.parse(json))).toBe(false);
    expect(isDefinedResource(Object.create(ticket))).toBe(false);
  });

  it('reports all five mistakes of one input at once', () => {
    const input = {
      ...ticketInput(),
      name: 'Ticket',
      serach: ['title'],
      access: { ...ticketInput().access, update: ['title', 'role:admin'] },
      agents: { read: true, write: ['status', 'resolution'] },
      board: 'priority_text',
      fields: { ...ticketInput().fields, priority_text: text() },
    };
    const error = refusal(input);
    expect(error.code).toBe('invalid_definition');
    expect(error.issues.length).toBe(5);
    expect(error.issues.map((issue) => issue.path).toSorted()).toEqual(
      ['(root)', 'access.update.0', 'agents.write.1', 'board', 'name'].toSorted(),
    );
    expect(error.message).toMatch(/^defineResource\(\) is not a valid definition: /u);
  });

  it('names the key an unknown root key is closest to', () => {
    const error = refusal({ ...ticketInput(), serach: ['title'] });
    expect(error.issues).toEqual([
      { path: '(root)', message: 'Unrecognized key: "serach" (did you mean "search"?)' },
    ]);
  });

  it('refuses a hand-built field', () => {
    const forged = { ...text(), type: 'text' };
    const error = refusal({ ...ticketInput(), fields: { title: forged } });
    expect(error.issues).toContainEqual({
      path: 'fields.title',
      message: 'must be made by a field builder such as text() or enumOf(), not written by hand',
    });
  });

  it.each([
    ['a reserved field name', { fields: { id: text() } }, 'fields.id'],
    ['no fields', { fields: {} }, 'fields'],
    [
      'an unknown role',
      { access: { ...ticketInput().access, delete: 'role:superuser' } },
      'access.delete',
    ],
    [
      'a rule naming a missing field',
      { access: { ...ticketInput().access, read: 'nobody' } },
      'access.read',
    ],
    ['search naming a non-text field', { search: ['status'] }, 'search.0'],
    ['search naming a missing field', { search: ['body'] }, 'search.0'],
    ['a board naming a missing field', { board: 'stage' }, 'board'],
    ['a name longer than 63 characters', { name: 'a'.repeat(64) }, 'name'],
    ['a 63-character name with no plural', { name: 'a'.repeat(63) }, 'plural'],
    [
      'a missing access operation',
      { access: { read: 'member', create: 'member', update: 'member' } },
      'access.delete',
    ],
  ])('refuses %s', (_, change, path) => {
    const error = refusal({ ...ticketInput(), ...change });
    expect(error.issues.map((issue) => issue.path)).toContain(path);
  });

  it('refuses a money field whose currency column would clash or not fit', () => {
    const base = {
      name: 'order',
      access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
    };
    const clash = refusal({
      ...base,
      fields: { price: money({ currency: 'JPY' }), price_currency: text() },
    });
    expect(clash.issues.map((issue) => issue.path)).toEqual(['fields.price_currency']);
    const long = refusal({
      ...base,
      fields: { [`p${'a'.repeat(55)}`]: money({ currency: 'JPY' }) },
    });
    expect(long.issues.map((issue) => issue.path)).toEqual([`fields.p${'a'.repeat(55)}`]);
  });

  it('types agents.write, search and board as field names of the resource', () => {
    const access = {
      read: 'member',
      create: 'member',
      update: 'member',
      delete: 'member',
    } as const;
    // A JavaScript caller has no types to stop it naming a field the resource does not have
    // (`title`), so the runtime check must refuse it.
    const fromJavaScript = (definition: unknown) =>
      defineResource(definition as Parameters<typeof defineResource>[0]);
    expect(() =>
      fromJavaScript({
        name: 'note',
        fields: { body: text() },
        access,
        agents: { read: true, write: ['title'] },
      }),
    ).toThrow(DefinitionError);
    expect(() =>
      fromJavaScript({ name: 'note', fields: { body: text() }, access, board: 'title' }),
    ).toThrow(DefinitionError);
  });

  it('refuses a value that is not an object', () => {
    expect(refusal(null).issues.length).toBeGreaterThan(0);
    expect(refusal('ticket').issues.length).toBeGreaterThan(0);
  });
});
