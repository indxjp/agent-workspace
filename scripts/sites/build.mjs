// Builds the two public sites into dist/sites/, the asset directories the Cloudflare Workers in
// infra/cloudflare/ serve:
//   dist/sites/lp    sites/lp/ without _partials/ and _i18n/ (lp.agentworkspace.indx.jp), each
//                    page with its Agent Store slots filled from the store catalog, and its
//                    Japanese copy under ja/; the build refuses a page whose shared chrome drifted
//                    from the partials or that has an English string with no Japanese one
//   dist/sites/docs  a static `mint export` of docs/sdk/site (docs.agentworkspace.indx.jp)
// Usage: node scripts/sites/build.mjs [lp|docs]   (no argument builds both)
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

import { windowsCommandLine } from '../release/pack-packages.mjs';
import { syncSite } from './chrome.mjs';
import { siteDiscoveryFiles } from './discovery.mjs';
import { translateSite, withAlternates } from './i18n.mjs';
import { renderSlots } from './store-data.mjs';

const MINT_VERSION = '4.2.985';
const ROOT = resolve(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'dist', 'sites');
/**
 * On Windows `npx` is a `.cmd` shim only a shell runs; its arguments are quoted for `cmd.exe` so a
 * repository path with a space survives. An absolute executable runs without a shell.
 * @param {string} cmd @param {string[]} args @param {string} [cwd]
 */
const run = (cmd, args, cwd) =>
  process.platform === 'win32' && !isAbsolute(cmd)
    ? execFileSync(windowsCommandLine(cmd, args), { cwd, stdio: 'inherit', shell: true })
    : execFileSync(cmd, args, { cwd, stdio: 'inherit' });

function buildLp() {
  const drift = syncSite('--check');
  if (drift.length > 0) throw new Error(`sites/lp is out of sync:\n${drift.join('\n')}`);
  const dir = join(OUT, 'lp');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // og.png is the social card every page's og:image points at; the docs site reuses it.
  const src = join(ROOT, 'sites', 'lp');
  const sources = new Set([join(src, '_partials'), join(src, '_i18n')]);
  cpSync(src, dir, { recursive: true, filter: (from) => !sources.has(from) });
  const japanese = translateSite();
  const missing = [...japanese.missing].map(([page, keys]) => `${page}: ${String(keys.length)}`);
  if (missing.length > 0 || japanese.stale.length > 0)
    throw new Error(
      `sites/lp/_i18n/ja is out of date (node scripts/sites/i18n.mjs --missing lists what to add):\n${[...missing, ...japanese.stale].join('\n')}`,
    );
  mkdirSync(join(dir, 'ja'), { recursive: true });
  for (const [page, ja] of japanese.pages) {
    const en = readFileSync(join(src, page), 'utf8');
    writeFileSync(join(dir, page), withAlternates(renderSlots(en, 'en'), page));
    writeFileSync(join(dir, 'ja', page), withAlternates(renderSlots(ja, 'ja'), page));
  }
}

function buildDocs() {
  const dir = join(OUT, 'docs');
  const zip = join(OUT, 'docs.zip');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  run(
    'npx',
    ['--yes', `mint@${MINT_VERSION}`, 'export', '--output', zip],
    join(ROOT, 'docs', 'sdk', 'site'),
  );
  // Windows ships bsdtar, which reads zip (named by path: Git Bash's GNU tar may shadow it on
  // PATH and cannot); Linux CI images ship unzip.
  if (process.platform === 'win32')
    run(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe'), [
      '-xf',
      zip,
      '-C',
      dir,
    ]);
  else run('unzip', ['-q', zip, '-d', dir]);
  rmSync(zip);
  // The export bundles a local preview server; the Worker serves the files directly.
  for (const f of ['serve.js', 'Start Docs.bat', 'Start Docs.command'])
    rmSync(join(dir, f), { force: true });
  // The export writes a folder's index.mdx to <folder>/index/index.html, so /<folder> (the URL
  // Mintlify links it as) 404s on the Worker; serve the same page at <folder>/index.html too.
  // The export succeeds even when a page's MDX does not parse; that page ships as an error notice.
  const broken = [];
  for (const page of readdirSync(dir, { recursive: true }).map(String)) {
    const at = page.replaceAll('\\', '/');
    if (
      at.endsWith('.html') &&
      readFileSync(join(dir, at), 'utf8').includes('A parsing error occurred')
    )
      broken.push(at);
    if (!at.endsWith('/index/index.html')) continue;
    const folderIndex = join(dir, at.slice(0, -'/index/index.html'.length), 'index.html');
    if (!existsSync(folderIndex)) cpSync(join(dir, at), folderIndex);
  }
  if (broken.length > 0) throw new Error(`MDX failed to parse on: ${broken.join(', ')}`);
  // The export has no sitemap.xml, robots.txt or llms.txt (BH061-060).
  for (const [name, text] of Object.entries(siteDiscoveryFiles(join(ROOT, 'docs', 'sdk', 'site'))))
    writeFileSync(join(dir, name), text);
}

const target = process.argv[2];
if (target && target !== 'lp' && target !== 'docs') throw new Error(`unknown site: ${target}`);
if (!target || target === 'lp') buildLp();
if (!target || target === 'docs') buildDocs();
