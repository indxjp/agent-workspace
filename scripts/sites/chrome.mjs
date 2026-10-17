// Keeps the shared head, header and footer of every page in sites/lp/ identical to the partials in
// sites/lp/_partials/. The site is plain static HTML with no templating at serve time, so each page
// carries its own copy between markers:
//   <!-- chrome:head -->…<!-- /chrome:head -->   (and chrome:header, chrome:footer)
// --write rewrites those blocks from the partials; --check (the default) fails on any drift.
// The header link to the page itself is marked aria-current="page".
// Usage: node scripts/sites/chrome.mjs [--write|--check]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SITE = resolve(import.meta.dirname, '..', '..', 'sites', 'lp');
/** The shared blocks, in the order they appear in a page. */
const PARTS = ['head', 'header', 'footer'];

/**
 * @param {string} page The page's file name, such as `use-cases.html`.
 * @param {string} part One of {@link PARTS}.
 * @param {string} body The partial's contents.
 * @returns {string} The block as it belongs in that page.
 */
export function renderBlock(page, part, body) {
  const marked =
    part === 'header'
      ? body.replaceAll(`href="${page}">`, `href="${page}" aria-current="page">`)
      : body;
  return `<!-- chrome:${part} -->\n${marked.trimEnd()}\n<!-- /chrome:${part} -->`;
}

/**
 * @param {string} page
 * @param {string} html The page as it is on disk.
 * @param {Readonly<Record<string, string>>} partials
 * @returns {{ readonly html: string, readonly problems: readonly string[] }}
 */
export function syncPage(page, html, partials) {
  const problems = [];
  let out = html;
  for (const part of PARTS) {
    const block = new RegExp(`<!-- chrome:${part} -->[\\s\\S]*?<!-- /chrome:${part} -->`, 'gu');
    const found = out.match(block) ?? [];
    if (found.length !== 1) {
      problems.push(`${page}: expected one chrome:${part} block, found ${String(found.length)}`);
      continue;
    }
    out = out.replace(block, () => renderBlock(page, part, partials[part] ?? ''));
  }
  return { html: out, problems };
}

/**
 * @param {'--write' | '--check'} mode
 * @returns {string[]} One line per page that is missing a block or, under --check, has drifted.
 */
export function syncSite(mode) {
  const partials = Object.fromEntries(
    PARTS.map((part) => [part, readFileSync(join(SITE, '_partials', `${part}.html`), 'utf8')]),
  );
  const problems = [];
  for (const page of readdirSync(SITE).filter((f) => f.endsWith('.html'))) {
    const path = join(SITE, page);
    const html = readFileSync(path, 'utf8');
    const synced = syncPage(page, html, partials);
    problems.push(...synced.problems);
    if (synced.problems.length > 0 || synced.html === html) continue;
    if (mode === '--write') writeFileSync(path, synced.html);
    else
      problems.push(
        `${page}: shared chrome differs from sites/lp/_partials/ (run: node scripts/sites/chrome.mjs --write)`,
      );
  }
  return problems;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  const mode = process.argv[2] ?? '--check';
  if (mode !== '--write' && mode !== '--check') throw new Error(`unknown mode: ${mode}`);
  const problems = syncSite(mode);
  for (const p of problems) process.stderr.write(`${p}\n`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
