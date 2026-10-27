#!/usr/bin/env node
/* global console */
// Changelog fragments (engineering audit F-17, changes/README.md).
//
// Pull requests do not edit any CHANGELOG.md: every PR appending to the same `## Unreleased`
// list was the main source of merge conflicts between parallel PRs. A PR adds a
// `changes/<slug>.md` fragment instead, and the release pull request (branch `release/*`) runs
// `--collect`, which merges every fragment into the `## Unreleased` section of its changelog and
// deletes it. Node built-ins only, so CI runs it before the install.
//
//   node scripts/release/changes.mjs --check        validate every fragment
//   node scripts/release/changes.mjs --collect      merge fragments into the changelogs, delete them
//   node scripts/release/changes.mjs --pr --base <sha> --head <sha> --head-ref <branch>
//       validate fragments and fail any CHANGELOG.md the diff touches outside a release/* branch

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

/** Keep a Changelog's sections, in the order a changelog lists them. */
export const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

const FRAGMENT_DIR = 'changes';
const RELEASE_BRANCH = /^release\//u;
/** Its presence at the merge base says the branch forked after this gate landed. */
const GATE_PATH = 'scripts/release/changes.mjs';

const invalid = (/** @type {string} */ reason) => new Error(`CHANGE_FRAGMENT_INVALID: ${reason}`);

/**
 * Parse one fragment: a front matter of exactly `changelog` and `section`, then a markdown list.
 * @param {string} source
 * @returns {{changelog: string, section: string, body: string}}
 */
export function parseFragment(source) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source.replaceAll('\r\n', '\n'));
  const [, frontMatter = '', rest = ''] = match ?? [];
  if (!match) throw invalid('expected a front matter between two --- lines');
  /** @type {Record<string, string | undefined>} */
  const fields = {};
  for (const line of frontMatter.split('\n')) {
    const [, key, value] = /^(changelog|section):\s*(\S+)\s*$/u.exec(line) ?? [];
    if (key === undefined) throw invalid(`unexpected front matter line ${JSON.stringify(line)}`);
    fields[key] = value;
  }
  const { changelog, section } = fields;
  if (changelog === undefined) throw invalid('missing "changelog:"');
  if (section === undefined || !SECTIONS.includes(section)) {
    throw invalid(`"section:" must be one of ${SECTIONS.join(', ')}`);
  }
  const body = rest.trim();
  if (!body.startsWith('- ')) throw invalid('the body must be a markdown list ("- ...")');
  if (/^#/mu.test(body)) throw invalid('the body must not contain headings');
  return { changelog, section, body };
}

/** @param {string} root @param {string} changelog */
function changelogPath(root, changelog) {
  const relative = changelog === 'platform' ? 'CHANGELOG.md' : `packages/${changelog}/CHANGELOG.md`;
  if (!/^[a-z0-9-]+$/u.test(changelog) || !existsSync(path.join(root, relative))) {
    throw invalid(
      `no changelog ${JSON.stringify(changelog)} (use "platform" or a packages/<name> that has a CHANGELOG.md)`,
    );
  }
  return relative;
}

/**
 * Every fragment, sorted by file name, parsed; errors are collected, not thrown.
 * @param {string} root
 */
async function readFragments(root) {
  const names = (await readdir(path.join(root, FRAGMENT_DIR)).catch(() => []))
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort();
  const fragments = [];
  const errors = [];
  for (const name of names) {
    const file = `${FRAGMENT_DIR}/${name}`;
    try {
      const fragment = parseFragment(await readFile(path.join(root, file), 'utf8'));
      fragments.push({ file, ...fragment, target: changelogPath(root, fragment.changelog) });
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { fragments, errors };
}

/** @param {string} root @returns {Promise<string[]>} one line per invalid fragment */
export async function validateFragments(root) {
  return (await readFragments(root)).errors;
}

/**
 * Insert entries into a changelog's `## Unreleased` section, creating the section and any
 * `### <Section>` heading it lacks. Entries go at the end of their section.
 * @param {string} text
 * @param {Map<string, string[]>} entries section → bodies
 */
export function mergeIntoChangelog(text, entries) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  let start = lines.findIndex((line) => /^## Unreleased\s*$/u.test(line));
  if (start === -1) {
    const firstRelease = lines.findIndex((line) => line.startsWith('## '));
    start = firstRelease === -1 ? lines.length : firstRelease;
    lines.splice(start, 0, '## Unreleased', '');
  }
  const blockEnd = () => {
    const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
    return next === -1 ? lines.length : next;
  };
  for (const section of SECTIONS) {
    const bodies = entries.get(section);
    if (!bodies) continue;
    const entryLines = bodies.flatMap((body) => body.split('\n'));
    const end = blockEnd();
    const heading = lines.findIndex(
      (line, index) => index > start && index < end && line === `### ${section}`,
    );
    if (heading !== -1) {
      let last = heading;
      for (let index = heading + 1; index < end; index++) {
        const line = lines[index] ?? '';
        if (line.startsWith('### ')) break;
        if (line.trim() !== '') last = index;
      }
      lines.splice(last + 1, 0, ...entryLines);
      continue;
    }
    // A new heading goes before the first later Keep a Changelog section, else at the block end.
    const later = SECTIONS.slice(SECTIONS.indexOf(section) + 1).map((name) => `### ${name}`);
    let at = lines.findIndex((line, index) => index > start && index < end && later.includes(line));
    if (at === -1) {
      at = end;
      while (at > start + 1 && lines[at - 1]?.trim() === '') at--;
    }
    const before = lines[at - 1]?.trim() === '' ? [] : [''];
    const after = lines[at]?.trim() === '' ? [] : [''];
    lines.splice(at, 0, ...before, `### ${section}`, '', ...entryLines, ...after);
  }
  return lines.join('\n');
}

/**
 * Merge every fragment into its changelog and delete the fragments. Nothing is written when any
 * fragment is invalid.
 * @param {string} root
 */
export async function collectFragments(root) {
  const { fragments, errors } = await readFragments(root);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  /** @type {Map<string, Map<string, string[]>>} */
  const byTarget = new Map();
  for (const { target, section, body } of fragments) {
    const sections = byTarget.get(target) ?? new Map();
    sections.set(section, [...(sections.get(section) ?? []), body]);
    byTarget.set(target, sections);
  }
  const changelogs = [...byTarget.keys()].sort();
  for (const target of changelogs) {
    const file = path.join(root, target);
    const sections = byTarget.get(target) ?? new Map();
    await writeFile(file, mergeIntoChangelog(await readFile(file, 'utf8'), sections));
  }
  await Promise.all(fragments.map(({ file }) => rm(path.join(root, file))));
  return { changelogs, fragments: fragments.length };
}

/**
 * The pull-request half: a CHANGELOG.md in the diff fails unless the head branch is `release/*`.
 * A branch that forked before this gate existed only gets a warning, so the PRs open when it
 * landed are not failed on their next run; merging main into such a branch enforces it.
 * @param {{root: string, base: string, head: string, headRef: string}} options
 */
export function checkPullRequest({ root, base, head, headRef }) {
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  const edited = git('diff', '--name-only', `${base}...${head}`)
    .split('\n')
    .filter((file) => file === 'CHANGELOG.md' || file.endsWith('/CHANGELOG.md'));
  if (edited.length === 0 || RELEASE_BRANCH.test(headRef)) return { failures: [], warnings: [] };
  const messages = edited.map(
    (file) =>
      `${file}: CHANGELOG_EDITED_OUTSIDE_RELEASE: add a changes/<slug>.md fragment instead (changes/README.md)`,
  );
  const mergeBase = git('merge-base', base, head).trim();
  try {
    git('cat-file', '-e', `${mergeBase}:${GATE_PATH}`);
  } catch {
    const note =
      ' (not enforced: this branch forked before the fragment gate; it is enforced once the branch merges main)';
    return { failures: [], warnings: messages.map((message) => message + note) };
  }
  return { failures: messages, warnings: [] };
}

async function main() {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean' },
      collect: { type: 'boolean' },
      pr: { type: 'boolean' },
      base: { type: 'string' },
      head: { type: 'string' },
      'head-ref': { type: 'string' },
    },
  });
  const root = path.resolve(import.meta.dirname, '..', '..');
  if (values.collect) {
    const { changelogs, fragments } = await collectFragments(root);
    console.log(
      `Collected ${String(fragments)} fragment(s) into ${changelogs.join(', ') || 'no changelog'}.`,
    );
    return 0;
  }
  if (!values.check && !values.pr) {
    console.error(
      'usage: changes.mjs --check | --collect | --pr --base <sha> --head <sha> --head-ref <branch>',
    );
    return 2;
  }
  const failures = await validateFragments(root);
  if (values.pr) {
    const { base, head } = values;
    if (!base || !head || values['head-ref'] === undefined) {
      console.error('--pr needs --base, --head and --head-ref');
      return 2;
    }
    const result = checkPullRequest({ root, base, head, headRef: values['head-ref'] });
    for (const warning of result.warnings) console.warn(`::warning::${warning}`);
    failures.push(...result.failures);
  }
  for (const failure of failures) console.error(failure);
  if (failures.length > 0) return 1;
  console.log('Changelog fragments are valid.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = await main();
}
