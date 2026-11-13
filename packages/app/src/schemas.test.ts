import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  bool,
  createInputSchema,
  defineResource,
  enumOf,
  person,
  recordSchema,
  text,
  updateInputSchema,
  type CreateInput,
} from './index.js';

const ticket = defineResource({
  name: 'ticket',
  fields: {
    title: text({ max: 20 }),
    status: enumOf(['new', 'closed'], { default: 'new' }),
    assignee: person({ optional: true }),
    urgent: bool(),
  },
  access: { read: 'member', create: 'member', update: 'assignee', delete: 'role:admin' },
});

const ids = {
  id: '018f2b4e-7c1d-7a00-8000-000000000001',
  workspace_id: '018f2b4e-7c1d-7a00-8000-000000000002',
  created_by: '018f2b4e-7c1d-7a00-8000-000000000003',
  updated_by: '018f2b4e-7c1d-7a00-8000-000000000003',
  created_at: '2026-10-31T00:00:00.000Z',
  updated_at: '2026-10-31T09:00:00+09:00',
};

describe('createInputSchema', () => {
  const schema = createInputSchema(ticket);

  it('needs the required fields and leaves optional and defaulted ones out', () => {
    expect(schema.safeParse({ title: 'Printer', urgent: false }).success).toBe(true);
    expect(schema.safeParse({ title: 'Printer' }).success).toBe(false);
    expect(schema.safeParse({ title: 'Printer', urgent: true, assignee: null }).success).toBe(true);
    expect(schema.safeParse({ title: 'Printer', urgent: true, status: null }).success).toBe(false);
  });

  it('refuses unknown keys, reserved columns among them', () => {
    expect(schema.safeParse({ title: 'Printer', urgent: false, owner: 'x' }).success).toBe(false);
    expect(schema.safeParse({ title: 'Printer', urgent: false, id: ids.id }).success).toBe(false);
  });

  it('applies each field value schema', () => {
    expect(schema.safeParse({ title: 'x'.repeat(21), urgent: false }).success).toBe(false);
    expect(schema.safeParse({ title: 'P', urgent: false, status: 'open' }).success).toBe(false);
  });

  it('types the input from the fields', () => {
    expectTypeOf<CreateInput<typeof ticket.fields>>().toEqualTypeOf<
      { readonly title: string; readonly urgent: boolean } & {
        readonly status?: 'new' | 'closed';
        readonly assignee?: string | null;
      }
    >();
  });
});

describe('updateInputSchema', () => {
  const schema = updateInputSchema(ticket);

  it('is partial and still strict', () => {
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ status: 'closed' }).success).toBe(true);
    expect(schema.safeParse({ created_by: ids.created_by }).success).toBe(false);
  });

  it('clears an optional field with null, never a required one', () => {
    expect(schema.safeParse({ assignee: null }).success).toBe(true);
    expect(schema.safeParse({ title: null }).success).toBe(false);
  });
});

describe('recordSchema', () => {
  const schema = recordSchema(ticket);

  it('includes the reserved columns and every field', () => {
    const record = { ...ids, title: 'Printer', status: 'new', assignee: null, urgent: false };
    expect(schema.parse(record)).toEqual(record);
    const withoutTenant = Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== 'workspace_id'),
    );
    expect(schema.safeParse(withoutTenant).success).toBe(false);
    expect(schema.safeParse({ ...record, assignee: undefined }).success).toBe(false);
  });
});
