import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Sidebar } from './sidebar';

const WORKSPACE = { name: 'Acme Corp', detail: 'Self-hosted', slug: 'acme' };
const USER = { name: 'Aya Ito', role: 'Owner', initials: 'AI' };
const CHATS = [
  { id: '33333333-3333-4333-8333-333333333333', label: 'Q3 refunds report' },
  { id: '44444444-4444-4444-8444-444444444444', label: null },
];

function sidebar(props: { readonly recentChats?: typeof CHATS; readonly locale?: 'en' | 'ja' }) {
  return renderToStaticMarkup(
    createElement(Sidebar, { workspace: WORKSPACE, user: USER, managers: true, ...props }),
  );
}

// Spec §44 and UX-05 in #2086: recent chats directly under New chat, then "See all" into Runs.
describe('the recent chats in the sidebar', () => {
  it('lists them directly under New chat, each opening that chat, then See all into Runs', () => {
    const html = sidebar({ recentChats: CHATS });
    const newChat = html.indexOf('New chat');
    const list = html.indexOf('aria-label="Recent chats"');
    const projects = html.indexOf('Projects');
    expect(newChat).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(newChat);
    expect(projects).toBeGreaterThan(list);
    expect(html).toContain(
      'href="/?session=33333333-3333-4333-8333-333333333333">Q3 refunds report</a>',
    );
    expect(html).toContain(
      'href="/?session=44444444-4444-4444-8444-444444444444">Untitled chat</a>',
    );
    expect(html).toMatch(/href="\/runs"[^>]*>See all<\/a>/u);
    // The mockup's `.recent-item.more`: the link into Runs is the accent colour, not muted.
    const seeAll = /<a class="([^"]*)" href="\/runs">See all<\/a>/u.exec(html)?.[1] ?? '';
    expect(seeAll.split(' ')).toContain('text-accent');
    expect(seeAll.split(' ')).not.toContain('text-muted');
  });

  it('shows no list, and no See all, when there are no recent chats', () => {
    for (const html of [sidebar({}), sidebar({ recentChats: [] })]) {
      expect(html).not.toContain('Recent chats');
      expect(html).not.toContain('See all');
    }
  });

  it('speaks Japanese to a Japanese reader', () => {
    const html = sidebar({ recentChats: CHATS, locale: 'ja' });
    expect(html).toContain('aria-label="最近のチャット"');
    expect(html).toContain('>無題のチャット</a>');
    expect(html).toMatch(/href="\/runs"[^>]*>すべて表示<\/a>/u);
  });
});
