import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CATALOG, COUNTS } from '../../examples/store/catalog/index.ts';
import { LINE_COUNTS } from '../../examples/store/catalog/line-counts.generated.ts';
import {
  CONTROL_LABELS,
  renderSlots,
  SAFETY_LABELS,
  SLOT_NAMES,
  STORE_DATA,
  STORE_ORIGIN,
  storeUrl,
} from '../../scripts/sites/store-data.mjs';

const SITE = path.resolve(import.meta.dirname, '..', '..', 'sites', 'lp');
const slot = (name: string) => `<!-- data:${name} --><!-- /data:${name} -->`;

describe('the marketing site: Agent Store slots', () => {
  it('fills each count from the catalog', () => {
    expect(renderSlots(slot('store-live'), 'en')).toBe(
      `<!-- data:store-live -->${String(COUNTS.live)}<!-- /data:store-live -->`,
    );
    expect(renderSlots(slot('store-total'), 'ja')).toContain(String(COUNTS.total));
    const handwritten = Object.values(LINE_COUNTS).map((count) => count.handwritten);
    expect(renderSlots(slot('line-counts-max'), 'en')).toContain(String(Math.max(...handwritten)));
  });

  it('shows every live entry on the shelves, in the page language, and no entry that is not live', () => {
    const live = CATALOG.filter((entry) => entry.status === 'live');
    const en = renderSlots(slot('store-shelf'), 'en');
    const ja = renderSlots(slot('store-shelf'), 'ja');
    for (const entry of live) {
      expect(en).toContain(`href="${storeUrl(`/agents/${entry.slug}`, 'en')}"`);
      expect(ja).toContain(`href="${STORE_ORIGIN}/agents/${entry.slug}"`);
    }
    expect(en.match(/class="app-card" href/gu)).toHaveLength(live.length);
  });

  it('escapes catalog text', () => {
    const [entry] = CATALOG.filter((candidate) => candidate.status === 'live');
    if (entry?.status !== 'live') throw new Error('the catalog has no live entry');
    const hostile = { ...entry, summary: { en: '<b>x</b> & "y"', ja: '<b>x</b>' } };
    const html = renderSlots(slot('store-shelf'), 'en', { ...STORE_DATA, catalog: [hostile] });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('has words for every Customize control and safety property the catalog uses', () => {
    for (const control of STORE_DATA.controls) expect(CONTROL_LABELS[control]).toBeDefined();
    for (const entry of CATALOG)
      if (entry.status === 'live')
        for (const property of entry.safety) expect(SAFETY_LABELS[property]).toBeDefined();
  });

  it('opens the store in the page language', () => {
    expect(storeUrl('/', 'ja')).toBe(`${STORE_ORIGIN}/`);
    expect(storeUrl('/', 'en')).toBe(`${STORE_ORIGIN}/?lang=en`);
    expect(storeUrl('/?cat=hr', 'en')).toBe(`${STORE_ORIGIN}/?cat=hr&lang=en`);
  });

  it('refuses a slot it does not know', () => {
    expect(() => renderSlots(slot('store-nope'), 'en')).toThrow('unknown data slot: store-nope');
  });
});

describe('this checkout', () => {
  const pages = readdirSync(SITE).filter((name) => name.endsWith('.html'));

  it('uses only slots the build knows, and types no store address of its own', () => {
    for (const page of pages) {
      const html = readFileSync(path.join(SITE, page), 'utf8');
      for (const [, name] of html.matchAll(/<!-- data:([a-z-]+) -->/gu))
        expect(SLOT_NAMES, `${page}: data:${String(name)}`).toContain(name);
      expect(html, page).not.toContain(new URL(STORE_ORIGIN).host);
    }
  });
});
