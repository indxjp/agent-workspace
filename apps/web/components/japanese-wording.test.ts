/**
 * One spelling for "folder" on every Japanese screen: フォルダー, with the long vowel, as most
 * screens already wrote it. A source scan, because the word sits in many message catalogs.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const WEB = join(import.meta.dirname, '..');

function messageCatalogs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : messageCatalogs(path);
    return /-messages\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

describe('Japanese wording', () => {
  const catalogs = [
    ...messageCatalogs(join(WEB, 'components')),
    ...messageCatalogs(join(WEB, 'app')),
  ];

  it('finds the message catalogs', () => {
    expect(catalogs.length).toBeGreaterThan(20);
  });

  it('spells folder as フォルダー', () => {
    const short = catalogs.filter((path) => /フォルダ(?!ー)/u.test(readFileSync(path, 'utf8')));
    expect(short).toEqual([]);
  });
});
