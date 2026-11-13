import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { enumOf, files, person, ref, richText, text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import { ResourceDetail } from './resource-detail.js';

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

describe('ResourceDetail (#1508)', () => {
  const FILE = 'f0000000-0000-4000-8000-000000000001';
  const withFiles = { ...record, attachments: [FILE], assignee: REQUESTER };

  it('renders the title, each field as a labelled row, and the files as read-only chips', () => {
    const html = renderToStaticMarkup(
      <ResourceDetail
        resource={ticket}
        record={withFiles}
        fileName={(id) => (id === FILE ? 'jam.png' : id)}
        people={{ [REQUESTER]: 'Aiko Sato' }}
        editHref={`/tickets/${ID}/edit`}
      />,
    );
    expect(html).toMatch(/<h1 id="[^"]+">Printer &lt;jams&gt;<\/h1>/u);
    expect(html).toContain(`<a href="/tickets/${ID}/edit" class="aw-app-button">Edit</a>`);
    for (const label of [
      'Title',
      'Description',
      'Status',
      'Priority',
      'Assignee',
      'Requester',
      'Attachments',
    ]) {
      expect(html).toContain(`<dt>${label}</dt>`);
    }
    expect(html).toContain('<span class="aw-app-chip">jam.png</span>');
    expect(html).not.toContain('<button');
    expect(html).toContain('Aiko Sato');
    expect(unlabelledControls(html)).toEqual([]);
  });

  it('links a ref() value to its record', () => {
    const task = defineResource({
      name: 'task',
      fields: { title: text(), project: ref('project') },
      access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
    });
    const html = renderToStaticMarkup(
      <ResourceDetail
        resource={task}
        record={{ ...record, title: 'Fix', project: ID }}
        refHref={(target, id) => `/apps/${target}/${id}`}
      />,
    );
    expect(html).toContain(`<a href="/apps/project/${ID}">0f5c2a8e</a>`);
  });

  it('draws the history and aside slots, named, only when given', () => {
    const bare = renderToStaticMarkup(<ResourceDetail resource={ticket} record={record} />);
    expect(bare).not.toContain('<aside');
    expect(bare).not.toContain('aria-label="History"');
    const html = renderToStaticMarkup(
      <ResourceDetail
        resource={ticket}
        record={record}
        history={
          <ol>
            <li>created</li>
          </ol>
        }
        aside={<p>agent panel</p>}
      />,
    );
    expect(html).toContain(
      '<section class="aw-app-history" aria-label="History"><ol><li>created</li></ol></section>',
    );
    expect(html).toContain(
      '<aside class="aw-app-aside" aria-label="Assistant"><p>agent panel</p></aside>',
    );
  });

  it('speaks Japanese', () => {
    const html = renderToStaticMarkup(
      <ResourceDetail
        resource={ticket}
        record={record}
        locale="ja"
        history={<p />}
        aside={<p />}
        editHref="/e"
      />,
    );
    expect(html).toContain('aria-label="詳細"');
    expect(html).toContain('aria-label="履歴"');
    expect(html).toContain('aria-label="アシスタント"');
    expect(html).toContain('>編集</a>');
    expect(html).toContain('<span class="aw-app-empty">—</span>');
  });
});
