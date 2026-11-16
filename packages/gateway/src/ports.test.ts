import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const src = path.dirname(fileURLToPath(import.meta.url));
const isTest = (file: string) => /\.(?:test|spec|test-support)\.ts$/u.test(file);

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') && !isTest(entry.name) ? [full] : [];
  });
}

describe('the gateway database ports', () => {
  it('only ports.ts names DatabaseRoot; adapters take the small ports (refactoring part 08 step 6)', () => {
    const naming = sources(src)
      .filter((file) => /\bDatabaseRoot\b/u.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(src, file).split(path.sep).join('/'));
    expect(naming).toEqual(['ports.ts']);
  });
});
