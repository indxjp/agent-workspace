#!/usr/bin/env node
/**
 * Fails when a front-door page (the README and every getting-started page) says the release is
 * "not published" or "not on npm", or names a package version older than the release line. The release line is the
 * lock-step version of the published packages (`packages/aw/package.json`); the root
 * `package.json` is the private workspace and does not move with a release (issue #688).
 * Site pages and the published packages' READMEs must not link where a public visitor cannot
 * follow, and a site link must not drop an apostrophe the heading's anchor keeps.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE = 'docs/sdk/site';
const GETTING_STARTED = `${SITE}/getting-started`;
/** What a public visitor cannot open: the internal repository, or a file path inside it. */
const INTERNAL_LINK =
  /github\.com\/INDXDev|`(?:docs|packages)\/[\w./<>-]+\.md`|\]\((?:\.\.\/)+[^)]*\)/gu;
/** Wording that says a shipped feature is still to come. */
const FUTURE_WORDING = /\bcoming in \d|\b0\.1\.x\b|@0\.2\.1\b/gu;
/** `@indx-workspace/aw@0.2.1`, `@indx-workspace/aw@0.2`, a range such as `0.2.x`, or "installs 0.2.1". */
const VERSION =
  /@indx-workspace\/[\w-]+@(\d+)\.(\d+)|\b(\d+)\.(\d+)\.x\b|\binstall(?:s|ed)?\s+v?(\d+)\.(\d+)\.\d+/gu;

/**
 * @param {readonly { readonly path: string, readonly text: string }[]} pages
 * @param {string} releaseLine The release version, such as `0.3.0`.
 * @returns {string[]} One issue per stale claim.
 */
export function findStaleClaims(pages, releaseLine) {
  const [major = 0, minor = 0] = releaseLine.split('.').map(Number);
  /** @type {string[]} */
  const issues = [];
  for (const page of pages) {
    page.text.split('\n').forEach((line, index) => {
      const where = `${page.path}:${String(index + 1)}`;
      const unpublished = /not (?:published|on npm)/iu.exec(line);
      if (unpublished) issues.push(`${where}: says "${unpublished[0]}"`);
      for (const match of line.matchAll(VERSION)) {
        const pageMajor = Number(match[1] ?? match[3] ?? match[5]);
        const pageMinor = Number(match[2] ?? match[4] ?? match[6]);
        if (pageMajor < major || (pageMajor === major && pageMinor < minor)) {
          issues.push(`${where}: names ${match[0]}, older than the release line ${releaseLine}`);
        }
      }
    });
  }
  return issues;
}

/**
 * @param {readonly { readonly path: string, readonly text: string }[]} pages Site pages outside `reference/`.
 * @returns {string[]} One issue per link or path a public visitor cannot follow, or stale promise.
 */
export function findPublicSiteIssues(pages) {
  /** @type {string[]} */
  const issues = [];
  for (const page of pages) {
    page.text.split('\n').forEach((line, index) => {
      const where = `${page.path}:${String(index + 1)}`;
      for (const match of line.matchAll(INTERNAL_LINK)) {
        issues.push(`${where}: points at something a visitor cannot open: ${match[0]}`);
      }
      for (const match of line.matchAll(FUTURE_WORDING)) {
        issues.push(`${where}: stale wording "${match[0]}"`);
      }
    });
  }
  return issues;
}

/** A GitHub-style slug: lower case, punctuation (apostrophes included) dropped, each space a hyphen. */
const droppedSlug = (/** @type {string} */ heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/gu, '-');

/** `docs/sdk/site/guides/deploy.mdx` → `/guides/deploy`, the path a site link names. */
const sitePath = (/** @type {string} */ file) =>
  file.replace(/^.*?docs\/sdk\/site\//u, '/').replace(/\.mdx$/u, '');

/**
 * Mintlify keeps an apostrophe in a heading's anchor as `’` (`#what-an-api-key-can’t-do`), so a
 * link written with it dropped, as GitHub would slug it, lands at the top of the page.
 * @param {readonly { readonly path: string, readonly text: string }[]} pages Every site page.
 * @returns {string[]} One issue per link to such a heading without its apostrophe.
 */
export function findApostropheAnchors(pages) {
  /** @type {Map<string, Set<string>>} */
  const deadByPage = new Map();
  for (const page of pages) {
    const dead = new Set();
    for (const [, heading = ''] of page.text.matchAll(/^#{1,6}\s+(.*['’].*)$/gmu)) {
      dead.add(droppedSlug(heading));
    }
    deadByPage.set(sitePath(page.path), dead);
  }
  /** @type {string[]} */
  const issues = [];
  for (const page of pages) {
    page.text.split('\n').forEach((line, index) => {
      for (const [link, target = '', fragment = ''] of line.matchAll(
        /\]\((\/[^)#\s]*)?#([^)\s]+)\)/gu,
      )) {
        if (deadByPage.get(target === '' ? sitePath(page.path) : target)?.has(fragment)) {
          issues.push(
            `${page.path}:${String(index + 1)}: ${link.slice(1)} drops an apostrophe the site's anchor keeps as ’`,
          );
        }
      }
    });
  }
  return issues;
}

/**
 * A reflow that joins `- **You will learn:**` onto the line before turns an `<Info>` box's list
 * into one bullet.
 * @param {readonly { readonly path: string, readonly text: string }[]} pages Every site page.
 * @returns {string[]} One issue per `<Info>` line that carries a list item after other text.
 */
export function findReflowedInfoLists(pages) {
  /** @type {string[]} */
  const issues = [];
  for (const page of pages) {
    let inInfo = false;
    page.text.split('\n').forEach((line, index) => {
      if (line.startsWith('<Info')) inInfo = true;
      if (inInfo && /\S - \*\*/u.test(line)) {
        issues.push(
          `${page.path}:${String(index + 1)}: an <Info> list item joined to the line before`,
        );
      }
      if (line.startsWith('</Info>')) inInfo = false;
    });
  }
  return issues;
}

/**
 * @param {readonly string[]} pagePaths Every site page, as a path without extension, relative to the site (`guides/errors`).
 * @param {readonly string[]} navPages Every page `docs.json` lists.
 * @returns {string[]} One issue per page the navigation does not list.
 */
export function findOrphanPages(pagePaths, navPages) {
  const listed = new Set(navPages);
  return pagePaths
    .filter((page) => !listed.has(page))
    .map((page) => `${page}: not in docs.json navigation`);
}

/** @param {string} dir @returns {Promise<string[]>} */
async function listMdx(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listMdx(full)));
    else if (entry.name.endsWith('.mdx')) found.push(full);
  }
  return found;
}

/** @param {unknown} node @returns {string[]} */
function navPagesOf(node) {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(navPagesOf);
  if (node !== null && typeof node === 'object') return Object.values(node).flatMap(navPagesOf);
  return [];
}

/** @param {string} repoRoot */
export async function checkFrontDoor(repoRoot) {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'packages/aw/package.json'), 'utf8'));
  const files = ['README.md'];
  for (const name of await readdir(path.join(repoRoot, GETTING_STARTED))) {
    if (name.endsWith('.mdx')) files.push(`${GETTING_STARTED}/${name}`);
  }
  const pages = await Promise.all(
    files.map(async (file) => ({
      path: file,
      text: await readFile(path.join(repoRoot, file), 'utf8'),
    })),
  );
  const site = path.join(repoRoot, SITE);
  const siteFiles = (await listMdx(site)).map((file) =>
    path.relative(site, file).replaceAll('\\', '/'),
  );
  const sitePages = await Promise.all(
    siteFiles.map(async (file) => ({
      path: `${SITE}/${file}`,
      text: await readFile(path.join(site, file), 'utf8'),
    })),
  );
  const prose = sitePages.filter((page) => !page.path.startsWith(`${SITE}/reference/`));
  // npm renders a published package's README with no public repository to resolve a relative
  // link against (BH061-032), so the READMEs get the site's public-link check too.
  const readmes = [];
  for (const name of await readdir(path.join(repoRoot, 'packages'))) {
    const dir = path.join(repoRoot, 'packages', name);
    const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    // `embedded` is private in the workspace and published from a packed copy; the scope decides.
    if (!manifest.name.startsWith('@indx-workspace/')) continue;
    readmes.push({
      path: `packages/${name}/README.md`,
      text: await readFile(path.join(dir, 'README.md'), 'utf8'),
    });
  }
  const manifest = JSON.parse(await readFile(path.join(site, 'docs.json'), 'utf8'));
  const orphans = findOrphanPages(
    siteFiles
      .filter((file) => !file.startsWith('snippets/'))
      .map((file) => file.slice(0, -'.mdx'.length)),
    navPagesOf(manifest.navigation),
  );
  return [
    ...findStaleClaims(pages, pkg.version),
    ...findPublicSiteIssues([...prose, ...readmes]),
    ...findApostropheAnchors(sitePages),
    ...findReflowedInfoLists(sitePages),
    ...orphans,
  ];
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  const issues = await checkFrontDoor(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  );
  for (const issue of issues) process.stderr.write(`${issue}\n`);
  process.exitCode = issues.length === 0 ? 0 : 1;
}
