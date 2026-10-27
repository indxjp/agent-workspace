#!/usr/bin/env node
// ADR gate (audit finding F-24): numbered records are unique and well named, every record
// carries a known status, and the index generator (scripts/docs/adr-index.mjs) reads a title and a
// date from every record. The index itself is not committed (ADR-0150).
//   node scripts/check-adrs.mjs
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readRecords } from './docs/adr-index.mjs';

const numbered = /^(\d{4})-[a-z0-9]+(-[a-z0-9]+)*\.md$/;
// Task records (W1-CP-04-...) keep their own id shape; they only need to be markdown.
const taskRecord = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const status = /status:.*\b(accepted|proposed|superseded|deprecated|rejected)\b/i;

/** @param {string} dir @returns {Promise<string[]>} one message per violation */
export async function validateAdrs(dir) {
  const failures = [];
  const seen = new Map();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
  for (const file of files) {
    const match = numbered.exec(file);
    if (/^\d/.test(file) && !match)
      failures.push(`${file}: malformed filename (expected NNNN-kebab-case.md)`);
    else if (!match && !taskRecord.test(file)) failures.push(`${file}: malformed filename`);
    if (match) {
      if (seen.has(match[1]))
        failures.push(`duplicate ADR number ${match[1]}: ${seen.get(match[1])} and ${file}`);
      else seen.set(match[1], file);
    }
    const head = (await readFile(path.join(dir, file), 'utf8')).split('\n', 12).join('\n');
    if (!status.test(head))
      failures.push(`${file}: missing or unknown Status in the first 12 lines`);
  }
  return failures;
}

/** Records the index generator cannot fully read: no title, or no date.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function indexFailures(dir) {
  return (await readRecords(dir)).flatMap(({ file, title, date }) => [
    ...(title ? [] : [`${file}: the index generator found no title`]),
    ...(date ? [] : [`${file}: the index generator found no Date`]),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/adr');
  const failures = await validateAdrs(dir);
  failures.push(...(await indexFailures(dir)));
  for (const f of failures)
    process.stderr.write(`adr:check: ${f}
`);
  process.exit(failures.length === 0 ? 0 : 1);
}
