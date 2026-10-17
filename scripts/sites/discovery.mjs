// The files a crawler or an LLM asks a docs site for first: sitemap.xml, robots.txt and llms.txt.
// Mintlify's hosted sites serve them; a static `mint export` does not (BH061-060), so the docs
// build writes them from docs.json's navigation and each page's frontmatter.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCS_ORIGIN = 'https://docs.agentworkspace.indx.jp';

/**
 * @param {unknown} node @param {boolean} [inPages] Whether `node` sits in a `pages` list.
 * @returns {string[]} Every page docs.json's navigation lists, in order (not tab or group names).
 */
function navPages(node, inPages = false) {
  if (typeof node === 'string') return inPages ? [node] : [];
  if (Array.isArray(node)) return node.flatMap((each) => navPages(each, inPages));
  if (node !== null && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) => navPages(value, key === 'pages'));
  }
  return [];
}

/** @param {string} mdx @returns {{ title: string, description: string }} */
export function frontmatter(mdx) {
  const head = /^---\n([\s\S]*?)\n---/u.exec(mdx.replaceAll('\r\n', '\n'))?.[1] ?? '';
  const field = (/** @type {string} */ name) =>
    new RegExp(`^${name}:\\s*"?(.*?)"?\\s*$`, 'mu').exec(head)?.[1] ?? '';
  return { title: field('title'), description: field('description') };
}

/**
 * @param {{ name: string, description: string, navigation: unknown }} manifest docs.json.
 * @param {(page: string) => { title: string, description: string }} meta A page's frontmatter.
 * @returns {Record<string, string>} The three files, by name.
 */
export function discoveryFiles(manifest, meta) {
  const pages = [...new Set(navPages(manifest.navigation))];
  const url = (/** @type {string} */ page) =>
    page === 'index' ? `${DOCS_ORIGIN}/` : `${DOCS_ORIGIN}/${page}`;
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...pages.map((page) => `  <url><loc>${url(page)}</loc></url>`),
    '</urlset>',
  ];
  const llms = [
    `# ${manifest.name}`,
    '',
    `> ${manifest.description}`,
    '',
    '## Pages',
    '',
    ...pages.map((page) => {
      const { title, description } = meta(page);
      return `- [${title || page}](${url(page)})${description ? `: ${description}` : ''}`;
    }),
  ];
  return {
    'sitemap.xml': `${sitemap.join('\n')}\n`,
    'robots.txt': `User-agent: *\nAllow: /\n\nSitemap: ${DOCS_ORIGIN}/sitemap.xml\n`,
    'llms.txt': `${llms.join('\n')}\n`,
  };
}

/** @param {string} siteDir docs/sdk/site. @returns {Record<string, string>} */
export function siteDiscoveryFiles(siteDir) {
  const manifest = JSON.parse(readFileSync(join(siteDir, 'docs.json'), 'utf8'));
  return discoveryFiles(manifest, (page) =>
    frontmatter(readFileSync(join(siteDir, `${page}.mdx`), 'utf8')),
  );
}
