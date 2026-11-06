import { describe, expect, it } from 'vitest';

import { defineApp } from '../app.js';
import { AppStoreError } from '../db/errors.js';
import { enumOf, number, person, richText, text } from '../fields/index.js';
import { definePages } from '../pages/define-pages.js';
import type { Person } from '../person.js';
import { defineResource, type FieldMap } from '../resource.js';
import { fakePerson } from '../testing/fake-person.js';
import { memoryPageStoreOf } from '../testing/memory-page-store.js';
import { memoryStoreOf } from '../testing/memory-store.js';
import { agentToolsOf, callAgentTool, parseToolArguments, type AgentTool } from './mcp-tools.js';

const tickets = defineResource({
  name: 'ticket',
  fields: {
    title: text({ max: 200 }),
    body: richText({ optional: true }),
    status: enumOf(['open', 'closed'], { default: 'open' }),
    priority: number({ optional: true }),
    assignee: person({ optional: true }),
  },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
  agents: { read: true, write: ['status', 'body', 'assignee'] },
  search: ['title'],
});

const notes = defineResource({
  name: 'note',
  fields: { title: text() },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
  agents: { read: true, write: false },
});

const secrets = defineResource({
  name: 'secret',
  fields: { title: text() },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
});

const app = defineApp({ name: 'desk', resources: [tickets, notes, secrets] });

function toolNamed(name: string): AgentTool {
  const tool = agentToolsOf(app).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
}

describe('agentToolsOf', () => {
  it('derives list, get, search and update from each resource’s agents and search', () => {
    expect(agentToolsOf(app).map((tool) => tool.name)).toEqual([
      'ticket_list',
      'ticket_get',
      'ticket_search',
      'ticket_update',
      'note_list',
      'note_get',
    ]);
  });

  it('gives update an input of the id and only the agents.write fields, strict', () => {
    const update = toolNamed('ticket_update');
    expect(update.inputSchema).toMatchObject({
      type: 'object',
      required: ['id'],
      additionalProperties: false,
    });
    expect(Object.keys(update.inputSchema.properties)).toEqual([
      'id',
      'status',
      'body',
      'assignee',
    ]);
    expect(update.inputSchema.properties['status']).toEqual({
      type: 'string',
      enum: ['open', 'closed'],
    });
    expect(update.inputSchema.properties['body']).toEqual({
      anyOf: [{ type: 'string', contentMediaType: 'text/markdown' }, { type: 'null' }],
    });
    expect(update.inputSchema.properties['assignee']).toMatchObject({
      anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }],
    });
  });

  it('offers the enum fields as list filters', () => {
    const list = toolNamed('ticket_list');
    expect(Object.keys(list.inputSchema.properties)).toEqual(['cursor', 'limit', 'status']);
    expect(Object.keys(toolNamed('note_list').inputSchema.properties)).toEqual(['cursor', 'limit']);
  });
});

describe('parseToolArguments', () => {
  const id = crypto.randomUUID();

  it('refuses a field of the resource agents may not write as forbidden, naming it', () => {
    expect(() => parseToolArguments(toolNamed('ticket_update'), { id, priority: 3 })).toThrow(
      expect.objectContaining({ code: 'forbidden', details: ['fields:priority'] }),
    );
  });

  it('refuses an unknown key and a bad value by path', () => {
    expect(() => parseToolArguments(toolNamed('ticket_update'), { id, colour: 'red' })).toThrow(
      expect.objectContaining({ code: 'invalid_body', details: ['colour'] }),
    );
    expect(() => parseToolArguments(toolNamed('ticket_list'), { status: 'lost' })).toThrow(
      expect.objectContaining({ code: 'invalid_query', details: ['status'] }),
    );
    expect(() => parseToolArguments(toolNamed('ticket_get'), {})).toThrow(AppStoreError);
  });
});

describe('callAgentTool', () => {
  it('writes markdown into rich text and reads it back as markdown', async () => {
    const store = memoryStoreOf<FieldMap>(tickets);
    const builder = fakePerson();
    const created = await store.create(builder, { title: 'Printer jam' });
    const agent = fakePerson({ principalId: builder.principalId, via: 'agent' });
    const markdown = '# Steps\n\nOpen the tray.\nPull the sheet.';
    const updated = await callAgentTool(
      toolNamed('ticket_update'),
      { id: created.id, body: markdown, status: 'closed' },
      agent,
      store,
    );
    expect(updated).toMatchObject({ body: markdown, status: 'closed' });
    expect((await store.get(builder, created.id))['body']).toEqual([
      { type: 'heading1', text: 'Steps' },
      { type: 'paragraph', text: 'Open the tray.\nPull the sheet.' },
    ]);
    const page = await callAgentTool(toolNamed('ticket_list'), { status: 'closed' }, agent, store);
    expect(page).toMatchObject({ items: [{ id: created.id, body: markdown }], nextCursor: null });
    const found = await callAgentTool(toolNamed('ticket_search'), { q: 'printer' }, agent, store);
    expect(found).toMatchObject({ items: [{ id: created.id }] });
  });
});

const wiki = definePages({
  access: { read: 'member', create: 'role:builder', update: 'role:builder', delete: 'role:admin' },
  // `parent` lets an agent create a page under another one; no tool moves a page.
  agents: { read: true, write: ['title', 'blocks', 'parent'] },
});
const titlesOnly = definePages({
  name: 'memo',
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
  agents: { read: true, write: ['title'] },
});
const wikiApp = defineApp({ name: 'wiki', resources: [wiki, titlesOnly, tickets] });

function wikiTool(name: string): AgentTool {
  const tool = agentToolsOf(wikiApp).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
}

describe('page tools', () => {
  const builder = fakePerson({ role: 'builder' });
  const agentOf = (someone: Person, runId = 'run_wiki_1'): Person =>
    fakePerson({ ...someone, via: 'agent', runId });

  it('derives the page tools, and page_create is the only create tool', () => {
    const names = agentToolsOf(wikiApp).map((tool) => tool.name);
    expect(names.slice(0, 6)).toEqual([
      'page_list',
      'page_get',
      'page_search',
      'page_children',
      'page_update',
      'page_create',
    ]);
    expect(names.filter((name) => name.endsWith('_create'))).toEqual([
      'page_create',
      'memo_create',
    ]);
    expect(Object.keys(wikiTool('page_update').inputSchema.properties)).toEqual([
      'id',
      'title',
      'markdown',
      'expectedRevisionId',
    ]);
    expect(Object.keys(wikiTool('memo_update').inputSchema.properties)).toEqual([
      'id',
      'title',
      'expectedRevisionId',
    ]);
  });

  it('an agent page_update records run_id; a person update after it does not', async () => {
    const store = memoryPageStoreOf<FieldMap>(wiki);
    const page = await store.create(builder, { title: 'Runbook' });
    const read = await callAgentTool(
      wikiTool('page_get'),
      { id: page.id },
      agentOf(builder),
      store,
    );
    const markdown = '# 保守手順\n\n- Close the valve';
    const updated = await callAgentTool(
      wikiTool('page_update'),
      { id: page.id, markdown, expectedRevisionId: read['revision_id'] },
      agentOf(builder),
      store,
    );
    expect(updated['blocks']).toBe(markdown);
    await store.update(builder, page.id, { title: 'Runbook, checked' });
    const revisions = (await store.revisions(builder, page.id)).items;
    expect(revisions.map((revision) => revision.run_id)).toEqual([null, 'run_wiki_1', null]);
    expect(store.auditEvents().at(1)).toMatchObject({ via: 'agent', run_id: 'run_wiki_1' });
    const found = await callAgentTool(
      wikiTool('page_search'),
      { q: '手順' },
      agentOf(builder),
      store,
    );
    expect(found).toMatchObject({ items: [{ id: page.id }] });
  });

  it('an agent cannot update or create a page the person cannot', async () => {
    const store = memoryPageStoreOf<FieldMap>(wiki);
    const page = await store.create(builder, { title: 'Locked' });
    const viewer = agentOf(fakePerson({ role: 'viewer' }));
    await expect(
      callAgentTool(wikiTool('page_update'), { id: page.id, title: 'Mine' }, viewer, store),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      callAgentTool(wikiTool('page_create'), { title: 'New' }, viewer, store),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      callAgentTool(
        wikiTool('page_update'),
        { id: page.id, title: 'Late', expectedRevisionId: crypto.randomUUID() },
        agentOf(builder),
        store,
      ),
    ).rejects.toMatchObject({ code: 'page_conflict', status: 409 });
  });

  it('refuses a write outside agents.write by name', () => {
    const id = crypto.randomUUID();
    expect(() => parseToolArguments(wikiTool('page_update'), { id, parent: null })).toThrow(
      expect.objectContaining({ code: 'forbidden', details: ['fields:parent'] }),
    );
    expect(() => parseToolArguments(wikiTool('memo_update'), { id, markdown: 'x' })).toThrow(
      expect.objectContaining({ code: 'forbidden', details: ['fields:blocks'] }),
    );
    expect(() => parseToolArguments(wikiTool('page_create'), { title: 'x', position: 1 })).toThrow(
      expect.objectContaining({ code: 'forbidden', details: ['fields:position'] }),
    );
  });

  it('page_create places a page under its parent; page_children lists it in order', async () => {
    const store = memoryPageStoreOf<FieldMap>(wiki);
    const agent = agentOf(builder);
    const memos = memoryPageStoreOf<FieldMap>(titlesOnly);
    const memo = await memos.create(builder, { title: 'Memo' });
    await expect(
      callAgentTool(wikiTool('memo_create'), { parent: memo.id, title: 'Below' }, agent, memos),
    ).rejects.toMatchObject({ code: 'forbidden', details: ['fields:parent', 'fields:blocks'] });
    const top = await callAgentTool(wikiTool('page_create'), { title: 'Top' }, agent, store);
    for (const title of ['First', 'Second']) {
      await callAgentTool(
        wikiTool('page_create'),
        { parent: top['id'], title, markdown: `${title} page.` },
        agent,
        store,
      );
    }
    const children = await callAgentTool(
      wikiTool('page_children'),
      { parent: top['id'] },
      agent,
      store,
    );
    expect(children).toMatchObject({
      items: [
        { title: 'First', blocks: 'First page.', position: 0 },
        { title: 'Second', position: 1 },
      ],
    });
    const roots = await callAgentTool(wikiTool('page_children'), {}, agent, store);
    expect(roots).toMatchObject({ items: [{ id: top['id'], blocks: '' }] });
    const revisions = await store.revisions(builder, String(top['id']));
    expect(revisions.items).toMatchObject([
      { run_id: 'run_wiki_1', author_principal_id: builder.principalId },
    ]);
  });

  it('a page tool on a store that is not a page store fails as internal_error', async () => {
    await expect(
      callAgentTool(wikiTool('page_children'), {}, builder, memoryStoreOf<FieldMap>(wiki)),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});
