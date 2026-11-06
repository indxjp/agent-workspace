import { describe, expect, it } from 'vitest';

import { rewritePrompt, summarizePrompt } from './page-actions.js';

const PAGE = { id: '0f5c2a8e-1b2c-4d3e-8f90-123456789abc', title: 'Printer  "jams"\n' };
const REVISION = '9d1e2f3a-4b5c-4d6e-8f70-0123456789ab';
const CHILDREN = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

describe('rewritePrompt (#1521)', () => {
  it('names the page id, the update tool and expectedRevisionId', () => {
    const prompt = rewritePrompt(PAGE, REVISION);
    expect(prompt).toContain(PAGE.id);
    expect(prompt).toContain('page_update');
    expect(prompt).toContain(`"expectedRevisionId":"${REVISION}"`);
    expect(prompt).toMatchInlineSnapshot(`
      "Rewrite the page "Printer \\"jams\\"" (id 0f5c2a8e-1b2c-4d3e-8f90-123456789abc) so it reads clearly, keeping its facts.
      1. Read it with page_get {"id":"0f5c2a8e-1b2c-4d3e-8f90-123456789abc"}.
      2. Save the new body with page_update {"id":"0f5c2a8e-1b2c-4d3e-8f90-123456789abc","markdown":"…","expectedRevisionId":"9d1e2f3a-4b5c-4d6e-8f70-0123456789ab"}, keeping expectedRevisionId 9d1e2f3a-4b5c-4d6e-8f70-0123456789ab.
      The change lands as a new revision. If it is refused page_conflict, someone saved since: read it again and start over."
    `);
  });

  it('names the tools of the resource it is given, and speaks Japanese', () => {
    const prompt = rewritePrompt(PAGE, REVISION, { name: 'doc', locale: 'ja' });
    expect(prompt).toContain('doc_update');
    expect(prompt).toContain('doc_get');
    expect(prompt).toMatchInlineSnapshot(`
      "ページ "Printer \\"jams\\""（id 0f5c2a8e-1b2c-4d3e-8f90-123456789abc）を、内容の事実を変えずに読みやすく書き換えてください。
      1. doc_get {"id":"0f5c2a8e-1b2c-4d3e-8f90-123456789abc"} で読みます。
      2. 新しい本文を doc_update {"id":"0f5c2a8e-1b2c-4d3e-8f90-123456789abc","markdown":"…","expectedRevisionId":"9d1e2f3a-4b5c-4d6e-8f70-0123456789ab"} で保存します。expectedRevisionId は 9d1e2f3a-4b5c-4d6e-8f70-0123456789ab のままにしてください。
      変更は新しいリビジョンとして残ります。page_conflict が返ったら、その後に誰かが保存しています。読み直してからやり直してください。"
    `);
  });
});

describe('summarizePrompt (#1521)', () => {
  it('names the page, the pages under it and the create tool, under the page', () => {
    const prompt = summarizePrompt(PAGE, CHILDREN);
    for (const id of [PAGE.id, ...CHILDREN]) expect(prompt).toContain(id);
    expect(prompt).toContain(`page_create {"parent":"${PAGE.id}"`);
    expect(prompt).toMatchInlineSnapshot(`
      "Summarize the page "Printer \\"jams\\"" (id 0f5c2a8e-1b2c-4d3e-8f90-123456789abc) and the pages under it into one new page.
      1. Read each of them with page_get: 0f5c2a8e-1b2c-4d3e-8f90-123456789abc, 11111111-1111-4111-8111-111111111111, 22222222-2222-4222-8222-222222222222.
      2. Create the summary under it with page_create {"parent":"0f5c2a8e-1b2c-4d3e-8f90-123456789abc","title":"…","markdown":"…"}.
      Do not change the pages you read."
    `);
  });

  it('speaks Japanese', () => {
    expect(summarizePrompt(PAGE, [], { locale: 'ja' })).toMatchInlineSnapshot(`
      "ページ "Printer \\"jams\\""（id 0f5c2a8e-1b2c-4d3e-8f90-123456789abc）とその下のページを要約して、新しいページにまとめてください。
      1. page_get で次のページを読みます：0f5c2a8e-1b2c-4d3e-8f90-123456789abc。
      2. 要約を page_create {"parent":"0f5c2a8e-1b2c-4d3e-8f90-123456789abc","title":"…","markdown":"…"} で、このページの下に新しいページとして作成します。
      既存のページは変更しないでください。"
    `);
  });
});
