import { describe, expect, it } from 'vitest';

import { channelRouteEdits, refFieldsOf, renderPageSpec } from './generate.js';
import {
  agent,
  channel,
  channelRefusal,
  contentsOf,
  importSpecifiersOf,
  messageResource,
  pages,
  recipes,
  resourcePages,
  workItemPages,
} from './templates.test-support.js';

describe('the generator templates: resource pages', () => {
  it("writes the resource's pages a few lines each, from the app kit's parts alone", () => {
    const every = [...resourcePages, ...workItemPages, ...Object.values(pages).flat()];

    expect(resourcePages.map((file) => file.path)).toEqual([
      'app/tickets/[id]/edit/page.tsx',
      'app/tickets/[id]/page.tsx',
      'app/tickets/new/page.tsx',
      'app/tickets/page.tsx',
    ]);
    for (const file of [...resourcePages, ...workItemPages]) {
      expect(file.contents.trimEnd().split('\n').length).toBeLessThanOrEqual(10);
    }
    expect(new Set(importSpecifiersOf(every))).toEqual(
      new Set([
        '@/resources/ticket',
        '@/resources/work_item',
        '@indx-workspace/app/react',
        '@indx-workspace/app/server',
        'react',
      ]),
    );
  });

  it('lists a resource with a board as a board, and one without as a table', () => {
    expect(contentsOf(resourcePages, 'app/tickets/page.tsx')).toBe(
      [
        "'use client';",
        "import ticket from '@/resources/ticket';",
        "import { ResourceBoard } from '@indx-workspace/app/react';",
        '',
        'export default function TicketsPage() {',
        '  return <ResourceBoard resource={ticket} />;',
        '}',
        '',
      ].join('\n'),
    );
    expect(contentsOf(workItemPages, 'app/work_items/page.tsx')).toContain(
      'export default function WorkItemsPage() {\n  return <ResourceList resource={work_item} />;',
    );
    expect(contentsOf(workItemPages, 'app/work_items/new/page.tsx')).toContain(
      'window.location.assign(`/work_items/${id}`);',
    );
    expect(contentsOf(resourcePages, 'app/tickets/[id]/page.tsx')).toContain(
      '<ResourceDetailLoader resource={ticket} id={id} editHref={`/tickets/${id}/edit`} />',
    );
    expect(contentsOf(resourcePages, 'app/tickets/[id]/edit/page.tsx')).toContain(
      '<ResourceFormLoader resource={ticket} id={id} cancelHref={`/tickets/${id}`} onSaved={saved} />',
    );
  });
});

describe('the generator templates: page kinds', () => {
  it('writes app/<name>/page.tsx for each page kind', () => {
    expect(pages.dashboard.map((file) => file.path)).toEqual([
      'app/dashboard/page.tsx',
      'app/api/dashboard/route.ts',
    ]);
    expect(contentsOf(pages.list, 'app/open-tickets/page.tsx')).toContain(
      'export default function OpenTicketsPage() {\n  return <ResourceList resource={ticket} />;',
    );
    expect(contentsOf(pages.custom, 'app/team_rota/page.tsx')).toContain('<h1>Team rota</h1>');
    expect(contentsOf(pages.dashboard, 'app/dashboard/page.tsx')).toContain(
      '<Dashboard platformUrl={appRuntime().awUrl} />',
    );
    expect(contentsOf(pages.dashboard, 'app/api/dashboard/route.ts')).toBe(
      [
        "import { dashboardRoutes } from '@indx-workspace/app/server';",
        '',
        'export const { GET } = dashboardRoutes();',
        '',
      ].join('\n'),
    );
  });

  it('refuses an unknown kind, a list without its resource and a reserved or bad name', () => {
    expect(() => renderPageSpec('board', { kind: 'kanban' })).toThrow(
      '--kind: must be one of dashboard, list, custom',
    );
    expect(() => renderPageSpec('open', { kind: 'list' })).toThrow(
      '--resource: a list page needs the resource it lists, --resource <name>',
    );
    expect(() => renderPageSpec('home', { kind: 'custom', resource: 'ticket' })).toThrow(
      '--resource: only a list page shows a resource',
    );
    expect(() => renderPageSpec('api', { kind: 'custom' })).toThrow(
      'name: is reserved: app/api/ holds the generated routes',
    );
    expect(() => renderPageSpec('Open Tickets', { kind: 'custom' })).toThrow(
      'name: must be lower-case words joined by - or _',
    );
  });
});

describe('the generator templates: agent and recipe', () => {
  it('wires the agent to the app connector', () => {
    expect(contentsOf(agent, 'agents/triage.ts')).toMatchSnapshot();
  });

  it('recipe: writes exactly the recipe and its test, for each trigger (#1514)', () => {
    expect(recipes.resource.map((file) => file.path)).toEqual([
      'recipes/enrich-contact.ts',
      'tests/recipes/enrich-contact.test.ts',
    ]);
    expect(contentsOf(recipes.resource, 'recipes/enrich-contact.ts')).toMatchSnapshot();
    expect(contentsOf(recipes.resource, 'tests/recipes/enrich-contact.test.ts')).toMatchSnapshot();
    expect(contentsOf(recipes.schedule, 'recipes/sla-sweep.ts')).toMatchSnapshot();
    expect(contentsOf(recipes.schedule, 'tests/recipes/sla-sweep.test.ts')).toMatchSnapshot();
    expect(contentsOf(recipes.schedule, 'recipes/sla-sweep.ts')).toContain(
      "on: schedule('*/5 * * * *', 'UTC'),",
    );
  });
});

describe('the generator templates: channel', () => {
  it('channel: writes the channel, its events route and its page, keyed on the first ref() to another resource (#1519)', () => {
    expect(channel.map((file) => file.path)).toEqual([
      'app/api/channels/message/events/route.ts',
      'app/channels/message/[key]/page.tsx',
      'channels/message.ts',
    ]);
    expect(contentsOf(channel, 'channels/message.ts')).toMatchSnapshot();
    expect(contentsOf(channel, 'app/api/channels/message/events/route.ts')).toMatchSnapshot();
    expect(contentsOf(channel, 'app/channels/message/[key]/page.tsx')).toMatchSnapshot();
    expect(contentsOf(channel, 'channels/message.ts')).toContain(
      "export default channel('message', { resource: roomResource, key: 'room' });",
    );
  });

  it("channel: edits each of the resource's route files by one line, from the line it generated", () => {
    const edits = channelRouteEdits('message');
    expect(edits).toMatchSnapshot();
    for (const edit of edits) {
      const generated = contentsOf(messageResource, edit.path) ?? '';
      expect(generated.split('\n')).toContain(edit.replaced);
    }
  });

  it('channel: refuses a resource with no ref() to key on, as channel_key_required', () => {
    const refs = refFieldsOf(contentsOf(messageResource, 'resources/message.ts') ?? '');
    expect(refs).toEqual([
      { field: 'thread_root', resource: 'message' },
      { field: 'room', resource: 'room' },
    ]);
    expect(channelRefusal('note', { refs: [] })).toMatch(/^--key: channel_key_required: /u);
    expect(channelRefusal('message', { refs, key: 'body' })).toMatch(
      /^--key: channel_key_required: body is not a ref\(\) field/u,
    );
    expect(channelRefusal('message', { refs, key: 'thread_root' })).toMatch(
      /^--key: channel_key_required: thread_root refers to the resource itself/u,
    );
    expect(channelRefusal('message', { refs, key: 'room' })).toBeUndefined();
    expect(channelRefusal('Message', { refs })).toMatch(/^name: /u);
  });
});
