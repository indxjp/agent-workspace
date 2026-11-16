import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import type { ResourceClient } from './client.js';
import {
  INITIAL_RECORD_STATE,
  recordReducer,
  ResourceDetailLoader,
  ResourceFormLoader,
  type RecordState,
} from './resource-detail-loader.js';
import { ResourceDetail } from './resource-detail.js';
import { AppTheme } from './theme.js';

const note = defineResource({
  name: 'note',
  fields: { title: text({ max: 200 }) },
  access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
  agents: { read: true, write: false },
});

type NoteRecord = { readonly id: string; readonly title: string };

const record: NoteRecord = { id: '0f5c2a8e-1b2c-4d3e-8f90-123456789abc', title: 'First' };

/** A client whose answers never come: the server render draws the state before the first one. */
const pending = {
  list: () => new Promise(() => undefined),
  get: () => new Promise(() => undefined),
  create: () => new Promise(() => undefined),
  update: () => new Promise(() => undefined),
} as unknown as ResourceClient<typeof note.fields>;

describe('recordReducer', () => {
  it('loads, fails with the code, and retries as a new attempt', () => {
    const failed = recordReducer<NoteRecord>(INITIAL_RECORD_STATE, {
      type: 'failed',
      code: 'resource_not_found',
    });
    const retried = recordReducer(failed, { type: 'retry' });
    const loaded = recordReducer(retried, { type: 'loaded', record });

    expect(failed).toEqual({ status: 'failed', attempt: 0, code: 'resource_not_found' });
    expect(retried).toEqual({ status: 'loading', attempt: 1 });
    expect(loaded).toEqual({ status: 'loaded', attempt: 1, record });
  });

  it('a request keeps the attempt and drops a record shown for another id', () => {
    const shown: RecordState<NoteRecord> = { status: 'loaded', attempt: 2, record };

    expect(recordReducer(shown, { type: 'request' })).toEqual({ status: 'loading', attempt: 2 });
    expect(recordReducer(INITIAL_RECORD_STATE, { type: 'request' })).toBe(INITIAL_RECORD_STATE);
  });
});

describe('ResourceDetailLoader', () => {
  it('announces the loading record politely, in the page locale', () => {
    const en = renderToStaticMarkup(
      <ResourceDetailLoader resource={note} id={record.id} client={pending} />,
    );
    const ja = renderToStaticMarkup(
      <ResourceDetailLoader resource={note} id={record.id} client={pending} locale="ja" />,
    );

    expect(en).toContain('<p class="aw-app-status" role="status" aria-live="polite">Loading…</p>');
    expect(ja).not.toContain('Loading…');
    expect(en).not.toContain('<button');
  });
});

describe('ResourceFormLoader', () => {
  it('announces the record it loads to change, and draws no form before it has it', () => {
    const html = renderToStaticMarkup(
      <ResourceFormLoader resource={note} id={record.id} client={pending} />,
    );

    expect(html).toContain(
      '<p class="aw-app-status" role="status" aria-live="polite">Loading…</p>',
    );
    expect(html).not.toContain('<form');
  });
});

describe("a part's language", () => {
  const PERSON = '9b2c3d4e-0000-4000-8000-000000000003';
  const stored: RecordOf<typeof note.fields> = {
    ...record,
    workspace_id: 'b1b2c3d4-0000-4000-8000-000000000002',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    created_by: PERSON,
    updated_by: PERSON,
  };

  it("is the AppTheme's around it when the part is given no locale", () => {
    const html = renderToStaticMarkup(
      <AppTheme theme={{ locale: 'ja' }}>
        <ResourceFormLoader resource={note} id={record.id} client={pending} />
        <ResourceDetail resource={note} record={stored} editHref="/notes/1/edit" />
      </AppTheme>,
    );

    expect(html).toContain('<div class="aw-app" lang="ja"');
    expect(html).toContain('読み込み中…');
    expect(html).toContain('>編集</a>');
    expect(html).not.toContain('Loading…');
  });

  it("is the part's own locale over the AppTheme's, and en outside any AppTheme", () => {
    const own = renderToStaticMarkup(
      <AppTheme locale="ja">
        <ResourceDetail resource={note} record={stored} editHref="/e" locale="en" />
      </AppTheme>,
    );
    const outside = renderToStaticMarkup(
      <ResourceDetail resource={note} record={stored} editHref="/e" />,
    );

    expect(own).toContain('>Edit</a>');
    expect(outside).toContain('>Edit</a>');
  });
});
