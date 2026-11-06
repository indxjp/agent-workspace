import { describe, expect, it } from 'vitest';

import { ProjectRenderError } from './errors.js';
import {
  appConfigLines,
  appConfigRecipeLines,
  GENERATOR_FIELD_TYPES,
  parseFieldSpec,
  parseFieldSpecs,
  renderAgentSpec,
  renderAppSpec,
  renderFieldCode,
  renderRecipeSpec,
  renderResourceSpec,
} from './generate.js';

/** What `fn` threw, as a ProjectRenderError's issues. */
function issuesOf(fn: () => unknown): readonly { path: string; message: string }[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProjectRenderError) return error.issues;
    throw error;
  }
  throw new Error('nothing was refused');
}

describe('parseFieldSpec', () => {
  it.each([
    ['title:text', 'text', [], false, 'title: text()'],
    ['title:text(200)', 'text', ['200'], false, 'title: text({ max: 200 })'],
    ['title:text(200)?', 'text', ['200'], true, 'title: text({ max: 200, optional: true })'],
    ['notes:richText', 'richText', [], false, 'notes: richText()'],
    ['score:number', 'number', [], false, 'score: number()'],
    ['score:number(0,10)', 'number', ['0', '10'], false, 'score: number({ min: 0, max: 10 })'],
    ['amount:money(JPY)', 'money', ['JPY'], false, "amount: money({ currency: 'JPY' })"],
    [
      'amount:money(USD)?',
      'money',
      ['USD'],
      true,
      "amount: money({ currency: 'USD', optional: true })",
    ],
    ['done:bool', 'bool', [], false, 'done: bool()'],
    ['due:date?', 'date', [], true, 'due: date({ optional: true })'],
    ['at:dateTime', 'dateTime', [], false, 'at: dateTime()'],
    [
      'status:enum(new,closed)',
      'enumOf',
      ['new', 'closed'],
      false,
      "status: enumOf(['new', 'closed'])",
    ],
    [
      'stage:enum(lead, won, lost)?',
      'enumOf',
      ['lead', 'won', 'lost'],
      true,
      "stage: enumOf(['lead', 'won', 'lost'], { optional: true })",
    ],
    ['assignee:person?', 'person', [], true, 'assignee: person({ optional: true })'],
    ['parent:ref(ticket)', 'ref', ['ticket'], false, "parent: ref('ticket')"],
    ['parent:ref(ticket)?', 'ref', ['ticket'], true, "parent: ref('ticket', { optional: true })"],
    ['attachments:files', 'files', [], false, 'attachments: files()'],
    ['labels:tags', 'tags', [], false, 'labels: tags()'],
  ] as const)('%s → %s', (argument, type, args, optional, code) => {
    const spec = parseFieldSpec(argument);

    expect(spec).toEqual({ name: argument.split(':')[0], type, args, optional });
    expect(renderFieldCode(spec)).toBe(code);
  });

  it('covers every field type with a spelling', () => {
    const types = [
      'a:text',
      'b:richText',
      'c:number',
      'd:money(JPY)',
      'e:bool',
      'f:date',
      'g:dateTime',
      'h:enum(x)',
      'i:person',
      'j:ref(x)',
      'k:files',
      'l:tags',
    ].map((argument) => parseFieldSpec(argument).type);

    expect(types).toEqual([...GENERATOR_FIELD_TYPES]);
  });

  it.each([
    ['amount:money(yen)', 'the currency must be one ISO 4217 code such as JPY'],
    ['amount:money(JPY,USD)', 'the currency must be one ISO 4217 code such as JPY'],
    ['amount:money', 'write it as money(JPY)'],
    ['status:enum()', 'an enum needs at least one value'],
    ['status:enum', 'write it as enum(a,b,…)'],
    ['status:enum(New)', 'the value "New" must be snake_case'],
    ['status:enum(a,a)', 'the values must be unique'],
    ['title:text(0)', 'the maximum must be one whole number from 1 to 100000'],
    ['title:text()', 'the maximum must be one whole number from 1 to 100000'],
    ['score:number(5)', 'the bounds must be two whole numbers, the minimum then the maximum'],
    ['score:number(10,1)', 'the minimum must not be greater than the maximum'],
    ['score:number(0.5,1)', 'the bounds must be two whole numbers, the minimum then the maximum'],
    ['done:bool(true)', 'bool takes no arguments'],
    ['parent:ref(Ticket)', 'the resource it refers to must be one snake_case name'],
    [
      'id:text',
      'the field name "id" is reserved for a column every resource has (id, workspace_id, created_at, updated_at, created_by, updated_by)',
    ],
    ['Title:text', 'the field name "Title" must be snake_case, 1-63 characters'],
    ['title', 'must be name:type, such as title:text or status:enum(new,closed)'],
  ])('refuses %s', (argument, message) => {
    expect(issuesOf(() => parseFieldSpec(argument))).toEqual([{ path: argument, message }]);
  });

  it('refuses an unknown type, naming the spellings', () => {
    expect(issuesOf(() => parseFieldSpec('title:string'))).toEqual([
      {
        path: 'title:string',
        message:
          'the type "string" is not one of text, richText, number, money, bool, date, dateTime, enum, person, ref, files, tags',
      },
    ]);
  });

  it('does not take the builder name enumOf as a spelling', () => {
    expect(issuesOf(() => parseFieldSpec('status:enumOf(a)'))[0]?.message).toMatch(
      /^the type "enumOf" is not one of/u,
    );
  });

  it('gives every reason of one argument at once', () => {
    expect(issuesOf(() => parseFieldSpec('Bad:money(yen)'))).toEqual([
      {
        path: 'Bad:money(yen)',
        message: 'the field name "Bad" must be snake_case, 1-63 characters',
      },
      { path: 'Bad:money(yen)', message: 'the currency must be one ISO 4217 code such as JPY' },
    ]);
  });

  it('returns a frozen spec', () => {
    const spec = parseFieldSpec('status:enum(a,b)');

    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.args)).toBe(true);
  });
});

describe('parseFieldSpecs', () => {
  it('refuses a duplicate field and every bad argument together', () => {
    expect(
      issuesOf(() => parseFieldSpecs(['title:text', 'status:enum()', 'title:richText', 'x:nope'])),
    ).toEqual([
      { path: 'status:enum()', message: 'an enum needs at least one value' },
      { path: 'title:richText', message: 'repeats the field "title"' },
      {
        path: 'x:nope',
        message:
          'the type "nope" is not one of text, richText, number, money, bool, date, dateTime, enum, person, ref, files, tags',
      },
    ]);
  });

  it('keeps the order the fields were given in', () => {
    expect(parseFieldSpecs(['b:bool', 'a:text']).map((spec) => spec.name)).toEqual(['b', 'a']);
  });
});

describe('renderResourceSpec', () => {
  const specs = parseFieldSpecs([
    'title:text(200)',
    'stage:enum(lead,won,lost)',
    'amount:money(JPY)?',
    'score:number(5,10)',
  ]);

  it('renders the imports, fields, search, board and test record', () => {
    expect(renderResourceSpec('deal', specs, { board: 'stage' })).toEqual({
      name: 'deal',
      plural: 'deals',
      component: 'Deal',
      components: 'Deals',
      listPart: 'ResourceBoard',
      imports: "import { defineResource, enumOf, money, number, text } from '@indx-workspace/app';",
      fields:
        "    title: text({ max: 200 }),\n    stage: enumOf(['lead', 'won', 'lost']),\n    amount: money({ currency: 'JPY', optional: true }),\n    score: number({ min: 5, max: 10 }),\n",
      options: "  search: ['title'],\n  board: 'stage',\n",
      sample: "  title: 'example',\n  stage: 'lead',\n  score: 5,\n",
    });
  });

  it('leaves search and board out when there is nothing to give them', () => {
    expect(renderResourceSpec('flag', parseFieldSpecs(['on:bool']))['options']).toBe('');
  });

  it('names the components in PascalCase and lists a resource without a board as a table', () => {
    expect(renderResourceSpec('work_item', parseFieldSpecs(['on:bool']))).toMatchObject({
      component: 'WorkItem',
      components: 'WorkItems',
      listPart: 'ResourceList',
    });
  });

  it('refuses a board that is not an enum field, a bad name and no fields, all at once', () => {
    expect(issuesOf(() => renderResourceSpec('Deal', specs, { board: 'title' }))).toEqual([
      { path: 'name', message: 'must be snake_case, 1-62 characters' },
      { path: '--board', message: 'must name an enum field of the resource; "title" is not one' },
    ]);
    expect(issuesOf(() => renderResourceSpec('deal', []))).toEqual([
      { path: 'fields', message: 'a resource needs at least one field, such as title:text' },
    ]);
  });

  it('refuses a resource name the route files could not bind', () => {
    expect(issuesOf(() => renderResourceSpec('delete', specs))).toEqual([
      {
        path: 'name',
        message:
          'is a reserved word in TypeScript, and the route files bind the resource to its name',
      },
    ]);
  });

  it('refuses a repeated field even when the specs were not parsed together', () => {
    const title = parseFieldSpec('title:text');

    expect(issuesOf(() => renderResourceSpec('deal', [title, title]))).toEqual([
      { path: 'fields', message: 'a field name is repeated' },
    ]);
  });
});

describe('renderAppSpec', () => {
  it('names the schema and lists the starting resources', () => {
    expect(renderAppSpec('service-desk', ['ticket'])).toEqual({
      appName: 'service-desk',
      schema: 'app_service_desk',
      imports: "import ticket from './resources/ticket.ts';\n",
      resources: '    ticket,\n',
    });
    expect(appConfigLines('ticket')).toEqual({
      import: "import ticket from './resources/ticket.ts';",
      entry: '    ticket,',
    });
  });

  it('refuses a name that is not a kebab name key or too long for the schema', () => {
    expect(issuesOf(() => renderAppSpec('Service_Desk'))).toEqual([
      { path: 'name', message: 'must be lower-case kebab, 1-59 characters' },
    ]);
    expect(issuesOf(() => renderAppSpec('a'.repeat(60)))).toHaveLength(1);
  });
});

describe('renderAgentSpec', () => {
  it('names the tools of each resource and wires the app connector', () => {
    const values = renderAgentSpec('triage', { appName: 'service-desk', resources: ['ticket'] });

    expect(values['appName']).toBe('service-desk');
    expect(values['resources']).toBe('tickets');
    expect(values['instructions']).toContain('ticket_list');
    expect(values['instructions']).toContain('ticket_update');
  });

  it('refuses no resources and a bad agent name together', () => {
    expect(issuesOf(() => renderAgentSpec('Triage', { appName: 'desk', resources: [] }))).toEqual([
      { path: 'name', message: 'must be lower-case kebab, 1-64 characters' },
      { path: '--tools', message: 'name at least one resource, such as --tools ticket' },
    ]);
  });
});

describe('renderRecipeSpec (#1514)', () => {
  const resources = ['contact', 'ticket'];

  it('renders a resourceEvent trigger on a resource of the app', () => {
    const { trigger, values } = renderRecipeSpec('enrich-contact', {
      on: 'resource:contact.created',
      resources,
    });
    expect(trigger).toEqual({ kind: 'resourceEvent', resource: 'contact', event: 'created' });
    expect(values['on']).toBe("resourceEvent('contact', 'created')");
    expect(values['builder']).toBe('resourceEvent');
    expect(values['agentVariable']).toBe('AW_ENRICH_CONTACT_AGENT_ID');
  });

  it("renders a schedule in UTC, or in the --tz given, with the cron's spacing tidied", () => {
    const { trigger, values } = renderRecipeSpec('sla-sweep', {
      on: 'schedule:*/5 * * * *',
      resources,
    });
    expect(trigger).toEqual({ kind: 'schedule', cron: '*/5 * * * *', timezone: 'UTC' });
    expect(values['on']).toBe("schedule('*/5 * * * *', 'UTC')");
    expect(
      renderRecipeSpec('sla-sweep', { on: 'schedule:0  9 * * 1-5', tz: 'Asia/Tokyo', resources })
        .values['on'],
    ).toBe("schedule('0 9 * * 1-5', 'Asia/Tokyo')");
  });

  it('lists every reason at once', () => {
    expect(
      issuesOf(() => renderRecipeSpec('Enrich', { on: 'resource:lead.made', resources })),
    ).toEqual([
      { path: 'name', message: 'must be lower-case kebab from a letter, 1-63 characters' },
      {
        path: '--on',
        message: 'the event must be one of created, updated, deleted, as resource:lead.created',
      },
      { path: '--on', message: 'names no resource of this app: lead (it has contact, ticket)' },
    ]);
    expect(
      issuesOf(() =>
        renderRecipeSpec('sweep', { on: "schedule:* * * 'x", tz: 'Not a zone', resources }),
      ),
    ).toEqual([
      { path: '--on', message: 'a schedule has exactly five cron fields, as schedule:*/5 * * * *' },
      { path: '--on', message: 'a cron field holds only digits, letters and * / , ? # -' },
      { path: '--tz', message: 'must be an IANA time zone such as Asia/Tokyo' },
    ]);
    expect(
      issuesOf(() =>
        renderRecipeSpec('sweep', { on: 'resource:ticket.updated', tz: 'UTC', resources }),
      ),
    ).toEqual([{ path: '--tz', message: 'only a schedule: trigger takes a time zone' }]);
    expect(issuesOf(() => renderRecipeSpec('sweep', { on: 'trigger:inbound', resources }))).toEqual(
      [
        {
          path: '--on',
          message:
            'trigger:<name> is not available yet: a trigger reaches an app through an entry agent',
        },
      ],
    );
    expect(issuesOf(() => renderRecipeSpec('sweep', { on: 'nightly', resources: [] }))).toEqual([
      {
        path: '--on',
        message: 'must be resource:<resource>.<created|updated|deleted> or schedule:<cron>',
      },
    ]);
  });

  it('binds the recipe in app.config.ts to a variable of its own', () => {
    expect(appConfigRecipeLines('enrich-contact')).toEqual({
      import: "import enrichContactRecipe from './recipes/enrich-contact.ts';",
      entry: '    enrichContactRecipe,',
    });
  });
});
