/**
 * What search engines and social cards read about the store (use-cases plan §6.3), from
 * `examples/store/app/seo.ts`: each entry page's title, description, canonical and `hreflang` URLs,
 * social card and JSON-LD, and the sitemap and robots.txt. With the public origin
 * (`STORE_PUBLIC_URL`) every URL is absolute on that host; without it nothing names a host at all.
 */
import { describe, expect, it } from 'vitest';

import { AREAS } from '../../examples/store/catalog/define.ts';
import { CATALOG, COUNTS } from '../../examples/store/catalog/index.ts';
import { LANDING } from '../../examples/store/catalog/landing.generated.ts';
import {
  areaColour,
  entryJsonLd,
  entryMetadata,
  originOf,
  PUBLIC_URL,
  robots,
  sitemap,
} from '../../examples/store/app/seo.ts';

const ORIGIN = 'https://agents.example';
/** The site's own pages the sitemap lists beside the entries. */
const SITE_PAGES = ['/', '/platform', '/contact', '/privacy'];

function entry(slug: string) {
  const found = CATALOG.find((candidate) => candidate.slug === slug);
  if (found === undefined) throw new Error(`no entry ${slug}`);
  return found;
}

describe('the public origin (STORE_PUBLIC_URL)', () => {
  it('is the origin of an https URL, and nothing for http, a missing or any other value', () => {
    expect(originOf('https://agents.example/some/path?x=1')).toBe(ORIGIN);
    expect(originOf('http://agents.example')).toBeUndefined();
    expect(originOf('http://127.0.0.1:3000')).toBeUndefined();
    expect(originOf(undefined)).toBeUndefined();
    expect(originOf('')).toBeUndefined();
    expect(originOf('agents.example')).toBeUndefined();
    expect(originOf('javascript:alert(1)')).toBeUndefined();
    expect(originOf('ftp://agents.example')).toBeUndefined();
  });

  it('is read from the environment once, and the test environment sets none', () => {
    expect(PUBLIC_URL).toBe(originOf(process.env['STORE_PUBLIC_URL']));
  });
});

describe('an entry page', () => {
  const contract = entry('contract-review');
  const headline = LANDING['contract-review']?.headline;

  it('has its name as title, its headline as description, and its URLs and card', () => {
    const metadata = entryMetadata(contract, 'en', ORIGIN);
    expect(metadata).toStrictEqual({
      metadataBase: new URL(ORIGIN),
      title: contract.name.en,
      description: headline?.en,
      alternates: {
        canonical: '/agents/contract-review?lang=en',
        languages: {
          ja: '/agents/contract-review?lang=ja',
          en: '/agents/contract-review?lang=en',
          'x-default': '/agents/contract-review',
        },
      },
      openGraph: {
        title: contract.name.en,
        description: headline?.en,
        url: `${ORIGIN}/agents/contract-review?lang=en`,
        images: [
          expect.stringMatching(
            /^https:\/\/agents\.example\/og\/contract-review\/en\?v=[0-9a-f]{8}$/u,
          ),
        ],
        locale: 'en_US',
      },
    });
    expect(entryMetadata(contract, 'ja', ORIGIN).openGraph.locale).toBe('ja_JP');
  });

  it("versions the card's URL by what it draws, so a new headline is a new URL", () => {
    const card = (entry: typeof contract) => entryMetadata(entry, 'en', ORIGIN).openGraph.images;
    expect(card(contract)).toStrictEqual(card({ ...contract }));
    expect(card(contract)).not.toStrictEqual(
      card({ ...contract, name: { ...contract.name, en: 'Renamed' } }),
    );
    expect(entryMetadata(contract, 'ja', ORIGIN).openGraph.images).not.toStrictEqual(
      card(contract),
    );
  });

  it('without a public origin, keeps its URLs relative and has no social card', () => {
    const metadata = entryMetadata(contract, 'ja', undefined);
    expect(metadata.metadataBase).toBeNull();
    expect(metadata.alternates.canonical).toBe('/agents/contract-review?lang=ja');
    expect(metadata.openGraph.images).toStrictEqual([]);
    expect(metadata.openGraph.url).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toMatch(/https?:\/\/(?!schema)/u);
  });

  it('falls back to the catalog summary when the entry has no landing copy yet', () => {
    const plain = { ...contract, slug: 'no-landing-copy' };
    expect(entryMetadata(plain, 'ja', ORIGIN).description).toBe(contract.summary.ja);
  });

  it('describes the agent as a schema.org SoftwareApplication, with its URL only when known', () => {
    expect(JSON.parse(entryJsonLd(contract, 'ja', ORIGIN))).toStrictEqual({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: contract.name.ja,
      description: headline?.ja,
      applicationCategory: 'BusinessApplication',
      inLanguage: 'ja',
      url: `${ORIGIN}/agents/contract-review?lang=ja`,
    });
    expect(JSON.parse(entryJsonLd(contract, 'en', undefined))).not.toHaveProperty('url');
  });

  it('escapes every < in the JSON-LD, so no copy can close its script', () => {
    const hostile = { ...contract, slug: 'hostile', name: { ja: '</script><b>', en: '<x>' } };
    const html = entryJsonLd(hostile, 'ja', ORIGIN);
    expect(html).not.toContain('<');
    expect(JSON.parse(html)).toMatchObject({ name: '</script><b>' });
  });

  it('gives every area its own colour on the social card', () => {
    const colours = AREAS.map(({ id }) => {
      const inArea = CATALOG.find((candidate) => candidate.area === id);
      return inArea === undefined ? id : areaColour(inArea);
    });
    expect(new Set(colours).size).toBe(AREAS.length);
  });
});

describe('the sitemap and robots.txt', () => {
  it('lists every entry page and site page in both languages, each with its pairs', () => {
    const pages = [...SITE_PAGES, ...CATALOG.map(({ slug }) => `/agents/${slug}`)];
    const urls = sitemap(ORIGIN);
    expect(urls).toHaveLength((COUNTS.total + SITE_PAGES.length) * 2);
    expect(new Set(urls.map(({ url }) => url)).size).toBe(urls.length);
    for (const page of pages) {
      const languages = {
        ja: `${ORIGIN}${page}?lang=ja`,
        en: `${ORIGIN}${page}?lang=en`,
        'x-default': `${ORIGIN}${page}`,
      };
      expect(urls.filter(({ url }) => url.startsWith(`${ORIGIN}${page}?`))).toStrictEqual([
        { url: languages.ja, alternates: { languages } },
        { url: languages.en, alternates: { languages } },
      ]);
    }
  });

  it('is empty without a public origin: a sitemap URL must be absolute, and no host is guessed', () => {
    expect(sitemap(undefined)).toStrictEqual([]);
  });

  it('keeps crawlers off the API and a visitor own pages, and names the sitemap when it can', () => {
    const disallow = ['/api/', '/chat', '/files', '/runs', '/sign-in'];
    expect(robots(ORIGIN)).toStrictEqual({
      rules: { userAgent: '*', disallow },
      sitemap: `${ORIGIN}/sitemap.xml`,
    });
    expect(robots(undefined).sitemap).toBeUndefined();
  });
});
