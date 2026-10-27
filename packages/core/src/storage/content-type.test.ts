import { describe, expect, it } from 'vitest';

import { inferContentType } from './content-type.js';

describe('inferContentType', () => {
  it.each([
    ['report.pdf', 'application/pdf'],
    ['out/Photo.PNG', 'image/png'],
    ['a/b/data.json', 'application/json'],
    ['notes.md', 'text/markdown'],
    ['bundle.tar.gz', 'application/gzip'],
    ['main.ts', 'text/plain'],
    ['noext', 'application/octet-stream'],
    ['.gitignore', 'application/octet-stream'],
    ['weird.xyz', 'application/octet-stream'],
  ])('%s -> %s', (path, expected) => {
    expect(inferContentType(path)).toBe(expected);
  });
});
