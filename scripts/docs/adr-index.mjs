#!/usr/bin/env node
/**
 * Prints the ADR index — one row per `docs/adr/*.md` record — derived from the directory itself.
 * The index is not committed: a committed table gains a row and a new count in every ADR pull
 * request, so two parallel ADR pull requests always conflicted on it (ADR-0150). Usage:
 *   pnpm --silent adr:index                  the table on stdout
 *   pnpm --silent adr:index > adr-index.md   as a file to browse
 *
 * Reads all three header shapes in the directory: `Status:` / `Date:` / `Scope:` on their own lines
 * (programme records), the `· `-separated single line (W0-DOC-01), and the `- **Status:**` list
 * form with `**Context task:**` (the W0-INF task records).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * @param {string[]} lines
 * @param {RegExp} pattern
 * @returns {string}
 */
const firstCapture = (lines, pattern) => {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return match[1] ?? '';
  }
  return '';
};

/**
 * The index fields of one record, as the table shows them.
 *
 * @param {string} file the record's filename
 * @param {string} text the record's contents
 */
export function parseRecord(file, text) {
  const base = file.slice(0, -'.md'.length);
  const id = /^(W[0-9]+-[A-Z]+-[0-9]+|[0-9]{4})-/u.exec(base)?.[1] ?? base;
  const meta = text.replaceAll('\r', '').split('\n').slice(0, 12);
  const title = (meta[0] ?? '').replace(/^# +/u, '').replace(/^[^ ]+ +(—|·|-) +/u, '');
  const status = firstCapture(meta, /.*[Ss]tatus:?\*{0,2}:? *([^·|]*)/u)
    .replace(/ *$/u, '')
    .replace(/^Accepted/u, 'accepted');
  const date = firstCapture(meta, /.*[Dd]ate:?\*{0,2}:? *([0-9]{4}-[0-9]{2}-[0-9]{2})/u);
  const contextTask = firstCapture(meta, /^[-* ]*\*\*Context task:\*\* *(.*)/u);
  const scope =
    firstCapture(meta, /^Scope: *(.*)/u) ||
    (contextTask && `task ${contextTask}`) ||
    (meta.some((line) => line.includes('Task:'))
      ? `task ${firstCapture(meta, /.*Task: *([^·]*)/u)}`.replace(/ *$/u, '')
      : '');
  return { id, title, date, scope, status };
}

/** The records of an ADR directory, sorted by filename.
 *
 * @param {string} dir
 */
export async function readRecords(dir) {
  const files = (await readdir(dir))
    .filter((file) => file.endsWith('.md') && !file.includes('README'))
    .sort();
  return Promise.all(
    files.map(async (file) => ({
      file,
      ...parseRecord(file, await readFile(path.join(dir, file), 'utf8')),
    })),
  );
}

/**
 * The index as Markdown: the record count, then the table sorted by filename.
 *
 * @param {string} dir the ADR directory
 * @returns {Promise<string>}
 */
export async function renderAdrIndex(dir) {
  const records = await readRecords(dir);
  const rows = records.map(
    ({ file, id, title, date, scope, status }) =>
      `| [${id}](${file}) | ${title} | ${date} | ${scope} | ${status} |`,
  );
  return [
    `**${records.length} records** in \`docs/adr/\`.`,
    '',
    '| Id | Title | Date | Scope | Status |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const adrDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/adr');
  process.stdout.write(await renderAdrIndex(adrDir));
}
