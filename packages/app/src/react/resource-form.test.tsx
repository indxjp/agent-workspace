import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { enumOf, files, person, richText, text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import { appStrings } from './locale.js';
import { FormAlert, ResourceForm } from './resource-form.js';
import { draftOf, initialForm } from './resource-form-model.js';

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

describe('ResourceForm (#1508)', () => {
  it('renders one labelled control per field, the field control, marking the required ones', () => {
    const html = renderToStaticMarkup(<ResourceForm resource={ticket} cancelHref="/tickets" />);
    expect(html).toContain('<form class="aw-app-form" noValidate=""');
    expect(html).toMatch(
      /<label for="[^"]+" id="[^"]+" class="aw-app-label">Title<span class="aw-app-required"> \(required\)<\/span><\/label><input id="[^"]+" aria-invalid="false" aria-required="true" type="text" maxLength="200" value=""\/>/u,
    );
    expect(html).toMatch(
      />Description<span class="aw-app-required"> \(required\)<\/span><\/label><textarea/u,
    );
    expect(html).toMatch(
      />Status<span[^>]*>[^<]*<\/span><\/label><select[^>]*><option value="new" selected="">New<\/option>/u,
    );
    expect(html).toMatch(/>Assignee<\/label><input[^>]*aria-required="false"[^>]*type="text"/u);
    expect(html).toMatch(
      /<span id="([^"]+)-label" class="aw-app-label">Attachments.*<div id="\1" role="group" aria-labelledby="\1-label"/u,
    );
    expect(html).toContain('One paragraph per line.');
    expect(html).toContain(
      '<button type="submit" class="aw-app-button aw-app-primary">Save</button>',
    );
    expect(html).toContain('<a href="/tickets" class="aw-app-button">Cancel</a>');
    expect(unlabelledControls(html)).toEqual([]);
  });

  it("starts an edit from the record's values, attachments as removable chips", () => {
    const FILE = 'f0000000-0000-4000-8000-000000000001';
    const html = renderToStaticMarkup(
      <ResourceForm
        resource={ticket}
        record={{ ...record, attachments: [FILE] }}
        fileName={() => 'jam.png'}
        people={{ [REQUESTER]: 'Aiko Sato' }}
      />,
    );
    expect(html).toContain('value="Printer &lt;jams&gt;"');
    expect(html).toContain('<option value="in_progress" selected="">In progress</option>');
    expect(html).toContain(
      '<option value="a1b2c3d4-0000-4000-8000-000000000001" selected="">Aiko Sato</option>',
    );
    expect(html).toContain('aria-label="Remove jam.png"');
    expect(unlabelledControls(html)).toEqual([]);
  });

  it('speaks Japanese', () => {
    const html = renderToStaticMarkup(
      <ResourceForm resource={ticket} locale="ja" labels={{ title: '件名' }} cancelHref="/" />,
    );
    expect(html).toContain('件名<span class="aw-app-required"> （必須）</span>');
    expect(html).toContain('>保存</button>');
    expect(html).toContain('>キャンセル</a>');
    expect(html).toContain('1 行が 1 段落になります。');
  });
});

describe('FormAlert (#1508): a problem maps to a banner with a recovery action', () => {
  const base = initialForm(draftOf(ticket));

  it('says nothing while editing', () => {
    expect(renderToStaticMarkup(<FormAlert state={base} strings={appStrings('en')} />)).toBe('');
  });

  it('names a problem code and offers to try again', () => {
    const state = { ...base, status: 'failed' as const, problem: 'forbidden' };
    expect(renderToStaticMarkup(<FormAlert state={state} strings={appStrings('en')} />)).toBe(
      '<div class="aw-app-alert" role="alert"><p class="aw-app-alert-heading">The record was not saved.</p>' +
        '<p>You do not have permission to do this.</p><button type="submit" class="aw-app-button">Try again</button></div>',
    );
    const ja = renderToStaticMarkup(
      <FormAlert state={{ ...state, problem: 'internal_error' }} strings={appStrings('ja')} />,
    );
    expect(ja).toContain('問題が発生しました。再試行してください。');
    expect(ja).toContain('>再試行</button>');
  });

  it('points at the fields when the problem is theirs', () => {
    const state = { ...base, status: 'failed' as const, errors: { title: 'invalid' as const } };
    const html = renderToStaticMarkup(<FormAlert state={state} strings={appStrings('en')} />);
    expect(html).toContain('Some fields need attention.');
    expect(html).not.toContain('<button');
  });
});
