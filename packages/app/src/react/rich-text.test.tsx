import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { RichTextBlock } from '../fields/rich-text.js';
import { RichText } from './rich-text.js';

const blocks: RichTextBlock[] = [
  { type: 'heading1', text: 'Printers' },
  { type: 'paragraph', text: 'Floor 3 <jams>' },
  {
    type: 'bulleted_item',
    text: 'Open the tray',
    children: [{ type: 'bulleted_item', text: 'x' }],
  },
  { type: 'divider' },
  { type: 'code', text: 'reset --hard' },
];

/** Every `id` the markup defines, and every `for` / `aria-labelledby` it points at. */
function idsOf(html: string): { defined: string[]; referenced: string[] } {
  return {
    defined: [...html.matchAll(/\sid="([^"]+)"/gu)].map((m) => m[1] ?? ''),
    referenced: [...html.matchAll(/\s(?:for|aria-labelledby|aria-describedby)="([^"]+)"/gu)].map(
      (m) => m[1] ?? '',
    ),
  };
}

describe('RichText (#1521)', () => {
  const html = renderToStaticMarkup(<RichText value={blocks} />);

  it('draws a row per block: a labelled type select and a labelled textarea', () => {
    expect(html.match(/<li class="aw-app-rich-text-block"/gu)).toHaveLength(5);
    expect(html.match(/<select /gu)).toHaveLength(5);
    expect(html).toContain('aria-label="Block 1 type"');
    expect(html).toMatch(/<option value="heading1" selected="">Heading 1<\/option>/u);
    // A divider has no text box; every other block's textarea is labelled by its place and type.
    const textareas = [...html.matchAll(/<textarea id="([^"]+)"/gu)].map((m) => m[1] ?? '');
    expect(textareas).toHaveLength(4);
    for (const id of textareas)
      expect(html).toContain(`<label for="${id}" class="aw-app-sr-only">`);
    expect(html).toContain('>Block 2 text (Paragraph)</label>');
    expect(html).toContain('>Block 5 text (Code)</label>');
    expect(html).toContain('<hr class="aw-app-rich-text-divider"/>');
  });

  it('draws text as text, says how the keys work, and names the nested items it carries', () => {
    expect(html).toContain('Floor 3 &lt;jams&gt;</textarea>');
    expect(html).toContain('Alt+Up or Alt+Down moves it');
    expect(html).toContain('1 nested item');
    expect(html).toContain('aria-label="Remove block 3"');
    expect(html).toContain('>Add block</button>');
    expect(html).toMatch(
      /<div class="aw-app-rich-text" role="group" aria-labelledby="[^"]+-label">/u,
    );
    const { defined, referenced } = idsOf(html);
    expect(new Set(defined).size).toBe(defined.length);
    for (const target of referenced) expect(defined).toContain(target);
  });

  it('never draws raw HTML or an editable region', () => {
    expect(html).not.toContain('contenteditable');
    expect(html).not.toContain('<jams>');
  });

  it('starts an empty body with one paragraph to type in, in Japanese too', () => {
    const empty = renderToStaticMarkup(<RichText value={[]} locale="ja" />);
    expect(empty.match(/<textarea /gu)).toHaveLength(1);
    expect(empty).toContain('>ブロック 1 の本文（段落）</label>');
    expect(empty).toContain('>ページ本文</p>');
  });

  it('draws readOnly through AssistantProse as markdown, without raw HTML', () => {
    const prose = renderToStaticMarkup(
      <RichText
        value={[...blocks, { type: 'paragraph', text: '<script>alert(1)</script>' }]}
        readOnly
      />,
    );
    expect(prose).toContain('<h1>Printers</h1>');
    expect(prose).toContain('<li>Open the tray');
    expect(prose).toContain('<hr/>');
    expect(prose).not.toContain('<script>');
    expect(prose).not.toContain('<textarea');
  });
});
