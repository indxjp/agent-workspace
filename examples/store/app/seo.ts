/**
 * What search engines and social cards read about the store (use-cases plan §6.3), from the
 * catalog: every entry's page in both languages at `/agents/<slug>?lang=<ja|en>`, with its title,
 * description, canonical URL, `hreflang` pairs (and `x-default`, the page without a language),
 * social card and JSON-LD, and the sitemap (the entries and the site's own pages) and robots.txt.
 *
 * An absolute URL needs the store's public origin, `STORE_PUBLIC_URL` (`https://` and the store's
 * domain; nothing but https), read once. Without it nothing guesses a host: the canonical and
 * `hreflang` URLs stay relative, and the sitemap's URLs, the social card, `og:url`, the JSON-LD
 * `url` and robots.txt's sitemap line are left out.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { AREAS, type CatalogEntry } from '../catalog/define.ts';
import { CATALOG } from '../catalog/index.ts';
import { LANDING } from '../catalog/landing.generated.ts';
import { LANGS, pick, type Lang } from './lang.ts';

const HttpsOrigin = z.url({ protocol: /^https$/u }).transform((url) => new URL(url).origin);
/** `value` as an https origin; `undefined` when it is missing or not an https URL. */
export const originOf = (value: string | undefined) => HttpsOrigin.safeParse(value).data;
export const PUBLIC_URL = originOf(process.env['STORE_PUBLIC_URL']);

/** The site's own pages the sitemap lists beside the entries. */
const SITE_PAGES = ['/', '/platform', '/contact', '/privacy'];
const OG_LOCALES = { ja: 'ja_JP', en: 'en_US' } as const;
const entryPath = (entry: CatalogEntry) => `/agents/${entry.slug}`;
const langUrl = (page: string, lang: Lang, origin = '') => `${origin}${page}?lang=${lang}`;
/** A page's URL in each language, and `x-default` without one: its `hreflang` pairs. */
const pairs = (page: string, origin = '') => ({
  ...Object.fromEntries(LANGS.map((lang) => [lang, langUrl(page, lang, origin)])),
  'x-default': origin + page,
});

/** An entry's one sentence: its landing headline, else its catalog summary. */
export const headline = (entry: CatalogEntry, lang: Lang) =>
  pick(LANDING[entry.slug]?.headline ?? entry.summary, lang);

/** What an entry's social card draws: its name, then its headline. */
export const cardText = (entry: CatalogEntry, lang: Lang) =>
  `${pick(entry.name, lang)}\n${headline(entry, lang)}`;

/** The colour of an entry's area on its social card: one hue per shelf, in the shelves' order. */
export const areaColour = (entry: CatalogEntry) =>
  `hsl(${String((AREAS.findIndex(({ id }) => id === entry.area) * 360) / AREAS.length)} 56% 30%)`;

/** An entry's social card; `v` follows what it draws, so a cached card never outlives its copy. */
const cardUrl = (entry: CatalogEntry, lang: Lang, origin: string) =>
  `${origin}/og/${entry.slug}/${lang}?v=${digest(cardText(entry, lang) + areaColour(entry))}`;
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 8);

/** An entry page's `<title>`, description, canonical and `hreflang` URLs and social card. */
export function entryMetadata(entry: CatalogEntry, lang: Lang, origin = PUBLIC_URL) {
  const [title, description] = [pick(entry.name, lang), headline(entry, lang)];
  const url = origin === undefined ? undefined : langUrl(entryPath(entry), lang, origin);
  const images = origin === undefined ? [] : [cardUrl(entry, lang, origin)];
  return {
    metadataBase: origin === undefined ? null : new URL(origin),
    title,
    description,
    alternates: { canonical: langUrl(entryPath(entry), lang), languages: pairs(entryPath(entry)) },
    openGraph: { title, description, url, images, locale: OG_LOCALES[lang] },
  };
}

/** An entry page's JSON-LD, a schema.org `SoftwareApplication`, safe inside `<script>`. */
export const entryJsonLd = (entry: CatalogEntry, lang: Lang, origin = PUBLIC_URL) =>
  JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: pick(entry.name, lang),
    description: headline(entry, lang),
    applicationCategory: 'BusinessApplication',
    inLanguage: lang,
    url: origin === undefined ? undefined : langUrl(entryPath(entry), lang, origin),
  }).replace(/</gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** Every entry page and site page in both languages, each with its pairs; none without an origin. */
export const sitemap = (origin = PUBLIC_URL) =>
  origin === undefined
    ? []
    : [...SITE_PAGES, ...CATALOG.map(entryPath)].flatMap((page) =>
        LANGS.map((lang) => ({
          url: langUrl(page, lang, origin),
          alternates: { languages: pairs(page, origin) },
        })),
      );

/** The public pages are open to crawlers; a visitor's own pages and the API are not. */
export const robots = (origin = PUBLIC_URL) => ({
  rules: { userAgent: '*', disallow: ['/api/', '/chat', '/files', '/runs', '/sign-in'] },
  sitemap: origin === undefined ? undefined : `${origin}/sitemap.xml`,
});
