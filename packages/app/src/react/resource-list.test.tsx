import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { enumOf, files, person, richText, text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import { ResourceList } from './resource-list.js';

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

describe('ResourceList (#1508)', () => {
  const page = { items: [record], nextCursor: 'c2' };

  it('renders a table with a header per field, a linked title and the cells', () => {
    const html = renderToStaticMarkup(<ResourceList resource={ticket} initialPage={page} />);
    expect(html).toContain('<caption class="aw-app-sr-only">Tickets</caption>');
    for (const header of [
      'Title',
      'Description',
      'Status',
      'Priority',
      'Assignee',
      'Requester',
      'Attachments',
    ]) {
      expect(html).toMatch(new RegExp(`<th scope="col"[^>]*>${header}</th>`, 'u'));
    }
    expect(html).toContain(`<a href="/tickets/${ID}">Printer &lt;jams&gt;</a>`);
    expect(html).toContain(
      '<span class="aw-app-badge" data-value="in_progress">In progress</span>',
    );
    expect(html).toContain('0 files');
    expect(html).toContain('On page two.');
    expect(html).toContain('>Load more</button>');
  });

  it('offers a labelled filter per enum field, a person filter only with people, and labels every control', () => {
    const html = renderToStaticMarkup(<ResourceList resource={ticket} initialPage={page} />);
    expect(html).toContain('role="search" aria-label="Filters"');
    expect(html).toMatch(/<label for="[^"]+">Status<\/label><select/u);
    expect(html).toMatch(/<label for="[^"]+">Priority<\/label><select/u);
    expect(html).not.toMatch(/>Assignee<\/label>/u);
    expect(unlabelledControls(html)).toEqual([]);

    const withPeople = renderToStaticMarkup(
      <ResourceList resource={ticket} initialPage={page} people={{ [REQUESTER]: 'Aiko Sato' }} />,
    );
    expect(withPeople).toMatch(
      />Assignee<\/label><select[^>]*><option value="" selected="">Any<\/option><option value="a1b2c3d4-0000-4000-8000-000000000001">Aiko Sato<\/option>/u,
    );
    expect(withPeople).toContain('Aiko Sato');
    expect(unlabelledControls(withPeople)).toEqual([]);
  });

  it('speaks Japanese, and takes the page labels of fields and values', () => {
    const html = renderToStaticMarkup(
      <ResourceList
        resource={ticket}
        initialPage={{ items: [], nextCursor: null }}
        locale="ja"
        labels={{ status: '状態' }}
        valueLabels={{ status: { new: '新規' } }}
      />,
    );
    expect(html).toContain('まだ何もありません。');
    expect(html).toContain('aria-label="絞り込み"');
    expect(html).toContain('>すべて</option>');
    expect(html).toContain('<option value="new">新規</option>');
    expect(html).toContain('>状態</th>');
    expect(html).not.toContain('Load more');
  });

  it('uses only native interactive elements, so the keyboard path is the tab order', () => {
    const html = renderToStaticMarkup(<ResourceList resource={ticket} initialPage={page} />);
    expect(html).not.toMatch(/tabindex="[1-9]/u);
    expect(html).not.toMatch(/<(div|span|td|li)[^>]*\brole="button"/u);
  });
});
