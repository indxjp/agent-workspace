#!/usr/bin/env node
/**
 * Fails when a relative Markdown link in a tracked `*.md` file points at a path that does not
 * exist. Fenced code blocks and inline code are ignored; `http(s):`, `mailto:`, `#anchor` and
 * site-absolute (`/...`) links are out of scope.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Blank out text but keep newlines, so line numbers survive.
 *
 * @param {string} text
 */
const blank = (text) => text.replace(/[^\n]/g, ' ');

/** `](target)` or `](target "title")`; the target has no spaces or parentheses. */
export const LINK = /\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g;

/** The relative target of a raw link, without fragment, or null when out of scope.
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function relativeTarget(raw) {
  const target = raw.split('#')[0] ?? '';
  if (target === '' || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/**
 * @param {string} root
 * @param {string[]} files
 */
export function findBrokenLinks(root, files) {
  /** @type {{ file: string, line: number, target: string }[]} */
  const broken = [];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8')
      .replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm, blank)
      .replace(/`+[^`]+`+/g, blank);
    const dir = path.dirname(path.join(root, file));
    for (const match of text.matchAll(LINK)) {
      const target = relativeTarget(match[1] ?? '');
      if (target === null || existsSync(path.resolve(dir, target))) continue;
      const line = text.slice(0, match.index).split('\n').length;
      broken.push({ file, line, target });
    }
  }
  return broken;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const files = execFileSync('git', ['-C', root, 'ls-files', '--', '*.md'], { encoding: 'utf8' })
    .split('\n')
    .filter(
      (f) =>
        f &&
        (!f.includes('/') ||
          /^(docs|internal)\//.test(f) ||
          /^packages\/[^/]+\/README\.md$/.test(f)),
    );
  const broken = findBrokenLinks(root, files);
  for (const { file, line, target } of broken)
    process.stdout.write(`${file}:${line}: ${target}
`);
  process.exit(broken.length > 0 ? 1 : 0);
}
