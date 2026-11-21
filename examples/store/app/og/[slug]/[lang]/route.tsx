/**
 * An entry's social card (use-cases plan §6.3), 1200 × 630, at `/og/<slug>/<ja|en>`: its name and
 * headline on its area's colour. Every card is drawn once, at build time, from the catalog, with
 * the Noto Sans JP subset beside this route (`../../noto-sans-jp.otf`: kana, JIS level-1 kanji and
 * every other glyph a card draws, `tests/store/og-font.test.ts`), so nothing is fetched and nothing is drawn per
 * request. Any other slug or language is not found, and a query string changes nothing.
 */
import { readFile } from 'node:fs/promises';

import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';

import { CATALOG } from '../../../../catalog/index.ts';
import { LANGS, langOf, pick } from '../../../lang.ts';
import { areaColour, headline } from '../../../seo.ts';

export const dynamicParams = false;
export const generateStaticParams = () =>
  CATALOG.flatMap(({ slug }) => LANGS.map((lang) => ({ slug, lang })));

/** A full card, its lines stacked and centred. */
const CARD = { display: 'flex', flexDirection: 'column', justifyContent: 'center' } as const;
const SIZE = { width: 1200, height: 630 };
const INK = { ...SIZE, color: 'white', fontFamily: 'Noto Sans JP' } as const;
/** The name's size, and the card's margin; the headline is half of it. */
const UNIT = SIZE.height / 9;

type Params = { params: Promise<{ slug: string; lang: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { slug, lang } = await params;
  const entry = CATALOG.find((candidate) => candidate.slug === slug) ?? notFound();
  const font = await readFile(`${process.cwd()}/app/og/noto-sans-jp.otf`);
  return new ImageResponse(
    <div style={{ ...CARD, ...INK, gap: UNIT / 2, padding: UNIT, background: areaColour(entry) }}>
      <div style={{ fontSize: UNIT }}>{pick(entry.name, langOf(lang))}</div>
      <div style={{ fontSize: UNIT / 2 }}>{headline(entry, langOf(lang))}</div>
    </div>,
    { ...SIZE, fonts: [{ name: 'Noto Sans JP', data: font }] },
  );
}
