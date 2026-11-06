import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { enumOf, files, person, richText, text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import { ResourceBoard } from './resource-board.js';

/** The ticket of the app kit's resource design (03 §5), with its board on `status`. */
const ticket = defineResource({
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
  board: 'status',
});

const ID = '0f5c2a8e-1b2c-4d3e-8f90-123456789abc';
const REQUESTER = 'a1b2c3d4-0000-4000-8000-000000000001';
const NOW = '2026-10-31T09:00:00Z';

const record: RecordOf<typeof ticket.fields> = {
  id: ID,
  workspace_id: 'b1b2c3d4-0000-4000-8000-000000000002',
  created_at: NOW,
  updated_at: NOW,
  created_by: REQUESTER,
  updated_by: REQUESTER,
  title: 'Printer <jams>',
  description: [{ type: 'paragraph', text: 'On page two.' }],
  status: 'in_progress',
  priority: 'p1',
  assignee: null,
  requester: REQUESTER,
  attachments: [],
};

/** Every `<input>`, `<select>` and `<textarea>` without a `<label for>` or an aria name. */
function unlabelledControls(html: string): string[] {
  const labelled = new Set([...html.matchAll(/<label[^>]* for="([^"]+)"/gu)].map((m) => m[1]));
  return [...html.matchAll(/<(input|select|textarea)\b[^>]*>/gu)]
    .map((match) => match[0])
    .filter((tag) => {
      const id = /\bid="([^"]+)"/u.exec(tag)?.[1];
      return !(id !== undefined && labelled.has(id)) && !/aria-label(ledby)?="/u.test(tag);
    });
}

describe('ResourceBoard (#1508)', () => {
  const closed = {
    ...record,
    id: 'c0000000-0000-4000-8000-000000000003',
    status: 'closed' as const,
  };
  const page = { items: [record, closed], nextCursor: null };

  it('renders a list of columns, one listitem per status in enum order, named by the value', () => {
    const html = renderToStaticMarkup(<ResourceBoard resource={ticket} initialPage={page} />);
    expect(html).toContain('<ul class="aw-app-board" aria-label="Board by Status">');
    const columns = [...html.matchAll(/<li class="aw-app-column" aria-label="([^"]+)">/gu)].map(
      (match) => match[1],
    );
    expect(columns).toEqual(['New', 'In progress', 'Resolved', 'Closed']);
    expect(html).toContain('1 card');
    expect(html).toContain('No cards');
    expect(unlabelledControls(html)).toEqual([]);
  });

  it('makes every card one link to the detail, with its other enum and person fields', () => {
    const html = renderToStaticMarkup(
      <ResourceBoard
        resource={ticket}
        initialPage={page}
        detailHref={(each) => `/desk/${each.id}`}
        people={{ [REQUESTER]: 'Aiko Sato' }}
      />,
    );
    expect(html).toContain(
      `<a href="/desk/${ID}" class="aw-app-card-title">Printer &lt;jams&gt;</a>`,
    );
    expect(html).toContain('<dt>Priority</dt>');
    expect(html).toContain('Aiko Sato');
    expect(html).not.toContain('<dt>Status</dt>');
    expect(html).not.toMatch(/draggable/u);
  });

  it('puts a record whose status the field no longer defines in no column', () => {
    const retired = { ...record, id: 'd0000000-0000-4000-8000-000000000004', title: 'Gone' };
    Reflect.set(retired, 'status', 'retired');
    const html = renderToStaticMarkup(
      <ResourceBoard resource={ticket} initialPage={{ items: [retired], nextCursor: null }} />,
    );
    expect(html).not.toContain('Gone');
  });

  it('speaks Japanese', () => {
    const html = renderToStaticMarkup(
      <ResourceBoard
        resource={ticket}
        initialPage={{ items: [], nextCursor: 'next' }}
        locale="ja"
        labels={{ status: '状態' }}
        valueLabels={{ status: { new: '新規' } }}
      />,
    );
    expect(html).toContain('aria-label="状態別のボード"');
    expect(html).toContain('aria-label="新規"');
    expect(html).toContain('カードはありません');
    expect(html).toContain('>さらに読み込む</button>');
  });

  it('groups by another enum field when asked', () => {
    const html = renderToStaticMarkup(
      <ResourceBoard resource={ticket} field="priority" initialPage={page} />,
    );
    expect(html).toContain('aria-label="Board by Priority"');
    expect(html).toContain('aria-label="P1"');
  });
});
