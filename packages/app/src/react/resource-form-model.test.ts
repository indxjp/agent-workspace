import { describe, expect, it } from 'vitest';

import { enumOf, files, money, number, person, richText, tags, text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import {
  checkDraft,
  controlsOf,
  draftOf,
  formReducer,
  initialForm,
} from './resource-form-model.js';

const REQUESTER = 'a1b2c3d4-0000-4000-8000-000000000001';

const ticket = defineResource({
  name: 'ticket',
  fields: {
    title: text({ max: 200 }),
    description: richText({ optional: true }),
    status: enumOf(['new', 'in_progress', 'resolved', 'closed'], { default: 'new' }),
    requester: person(),
    estimate: number({ min: 0, max: 100, optional: true }),
    budget: money({ currency: 'JPY', optional: true }),
    labels: tags({ optional: true }),
    attachments: files(),
  },
  access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
});

describe('controlsOf (#1508)', () => {
  it("gives one control per field, the field's own, with its bounds", () => {
    const controls = controlsOf(ticket);
    expect(controls.map((control) => [control.name, control.control, control.required])).toEqual([
      ['title', 'input', true],
      ['description', 'editor', false],
      ['status', 'select', true],
      ['requester', 'people', true],
      ['estimate', 'number', false],
      ['budget', 'money', false],
      ['labels', 'tags', false],
      ['attachments', 'uploader', true],
    ]);
    expect(controls[0]).toMatchObject({ maxLength: 200 });
    expect(controls[2]?.options.map((option) => option.value)).toEqual([
      'new',
      'in_progress',
      'resolved',
      'closed',
    ]);
    expect(controls[4]).toMatchObject({ min: 0, max: 100 });
    expect(controls[5]).toMatchObject({ currency: 'JPY' });
  });
});

describe('checkDraft (#1508): the create and update schemas, in the browser', () => {
  it('starts a create from the defaults and refuses a missing required field', () => {
    const draft = draftOf(ticket);
    expect(draft['status']).toBe('new');
    expect(draft['attachments']).toEqual([]);
    expect(checkDraft(ticket, 'create', draft)).toEqual({
      ok: false,
      errors: { title: 'required', requester: 'required' },
    });
  });

  it('turns the controls into the body the route takes', () => {
    const check = checkDraft(ticket, 'create', {
      ...draftOf(ticket),
      title: 'Printer jam',
      description: 'It jams.\n\nOn page two.',
      requester: REQUESTER,
      estimate: '3',
      budget: '1500.50',
      labels: 'urgent, , vip',
    });
    expect(check).toEqual({
      ok: true,
      body: {
        title: 'Printer jam',
        description: [
          { type: 'paragraph', text: 'It jams.' },
          { type: 'paragraph', text: 'On page two.' },
        ],
        status: 'new',
        requester: REQUESTER,
        estimate: 3,
        budget: { amount: '1500.50', currency: 'JPY' },
        labels: ['urgent', 'vip'],
        attachments: [],
      },
    });
  });

  it('marks a value the field schema refuses as invalid', () => {
    const check = checkDraft(ticket, 'create', {
      ...draftOf(ticket),
      title: 'x'.repeat(201),
      requester: 'not-a-uuid',
      estimate: '1000',
      budget: '12.345678',
    });
    expect(check).toEqual({
      ok: false,
      errors: { title: 'invalid', requester: 'invalid', estimate: 'invalid', budget: 'invalid' },
    });
  });

  it('clears an emptied optional field with null on update, and refuses an emptied required one', () => {
    const record = {
      id: '0f5c2a8e-1b2c-4d3e-8f90-123456789abc',
      title: 'Printer jam',
      description: null,
      status: 'in_progress',
      requester: REQUESTER,
      estimate: 4,
      budget: null,
      labels: ['urgent'],
      attachments: [],
    };
    const draft = draftOf(ticket, record);
    expect(draft['status']).toBe('in_progress');
    expect(draft['estimate']).toBe('4');
    expect(draft['labels']).toBe('urgent');
    expect(checkDraft(ticket, 'update', { ...draft, estimate: '' })).toMatchObject({
      ok: true,
      body: { estimate: null, status: 'in_progress' },
    });
    expect(checkDraft(ticket, 'update', { ...draft, title: ' ' })).toEqual({
      ok: false,
      errors: { title: 'required' },
    });
  });
});

describe('formReducer (#1508)', () => {
  it('clears a field error on change, and puts a problem naming no field on the form', () => {
    let state = initialForm(draftOf(ticket));
    state = formReducer(state, { type: 'refused', errors: { title: 'required' } });
    expect(state.status).toBe('failed');
    state = formReducer(state, { type: 'change', name: 'title', value: 'Jam' });
    expect(state.errors).toEqual({});
    state = formReducer(state, { type: 'saving' });
    state = formReducer(state, {
      type: 'failed',
      code: 'forbidden',
      placement: { fields: {}, form: [] },
    });
    expect(state).toMatchObject({ status: 'failed', problem: 'forbidden', errors: {} });
    state = formReducer(state, {
      type: 'failed',
      code: 'invalid_body',
      placement: { fields: { title: ['Too long'] }, form: [] },
    });
    expect(state).toMatchObject({ problem: null, errors: { title: 'invalid' } });
    expect(formReducer(state, { type: 'saved' })).toMatchObject({ status: 'editing', errors: {} });
  });
});
