import { describe, expect, it } from 'vitest';

import { BLUEPRINT_PACKAGE_KEYWORD, readBlueprintArchive } from './blueprint-archive.js';
import {
  MANIFEST,
  PACKAGE,
  base,
  encoder,
  refusal,
  tar,
} from './blueprint-archive.test-support.js';

describe('readBlueprintArchive', () => {
  it('returns the listed files with the package/ prefix stripped, parts then migrations', () => {
    const archive = readBlueprintArchive(tar(base()));
    expect(archive.packageName).toBe('@acme/helpdesk-blueprint');
    expect(archive.packageVersion).toBe('1.2.0');
    expect(archive.manifest.name).toBe('helpdesk');
    expect(archive.files).toEqual([
      { path: 'resources/ticket.ts', contents: 'export default {};\n' },
      {
        path: 'migrations/0000_create_tickets.sql',
        contents: 'CREATE TABLE "{{appSchema}}"."tickets" ();\n',
      },
    ]);
  });
});

describe('readBlueprintArchive: pax extended headers', () => {
  it('reads a long path from a pax extended header', () => {
    const long = `app/${'a'.repeat(120)}/page.tsx`;
    const manifest = { ...MANIFEST, parts: [...MANIFEST.parts, { path: long, kind: 'page' }] };
    const record = ` path=package/${long}\n`;
    const length = record.length + String(record.length + 3).length;
    const entries = base(
      [
        { name: 'PaxHeader/page', type: 'x', body: `${String(length)}${record}` },
        { name: 'package/app/truncated', body: 'export default 1;\n' },
      ],
      manifest,
    );
    expect(readBlueprintArchive(tar(entries)).files.map((file) => file.path)).toContain(long);
  });

  it('reads a non-ASCII path from a pax header, whose record length counts bytes', () => {
    const long = `app/${'ä'.repeat(70)}/ページ.tsx`;
    const manifest = { ...MANIFEST, parts: [...MANIFEST.parts, { path: long, kind: 'page' }] };
    const record = ` path=package/${long}\n`;
    const bytes = encoder.encode(record).length;
    const length = bytes + String(bytes + 3).length;
    const entries = base(
      [
        { name: 'PaxHeader/page', type: 'x', body: encoder.encode(`${String(length)}${record}`) },
        { name: 'package/app/truncated', body: 'export default 1;\n' },
      ],
      manifest,
    );
    expect(readBlueprintArchive(tar(entries)).files.map((file) => file.path)).toContain(long);
  });

  it.each([
    ['a ../ segment', { name: 'package/../evil.ts', body: 'x' }, 'not a plain relative path'],
    ['an absolute path', { name: '/etc/passwd', body: 'x' }, 'not a plain relative path'],
    ['a backslash', { name: 'package\\evil.ts', body: 'x' }, 'not a plain relative path'],
    [
      'a symbolic link',
      { name: 'package/resources/link.ts', type: '2', link: '/etc/passwd' },
      'not a regular file',
    ],
    [
      'a hard link',
      { name: 'package/resources/hard.ts', type: '1', link: 'package/package.json' },
      'not a regular file',
    ],
    ['a device', { name: 'package/dev', type: '3' }, 'not a regular file'],
    ['a file outside package/', { name: 'other/file.ts', body: 'x' }, 'is outside package/'],
    ['an unlisted file', { name: 'package/.env', body: 'TOKEN=1' }, 'is not a part'],
  ] as const)('refuses %s', (_label, entry, message) => {
    expect(refusal(tar(base([entry])))).toContain(message);
  });
});

describe('readBlueprintArchive: what the package must hold', () => {
  it('refuses a listed part that is missing', () => {
    const entries = base().filter((entry) => entry.name !== 'package/resources/ticket.ts');
    expect(refusal(tar(entries))).toContain('resources/ticket.ts: is listed but missing');
  });

  it('refuses a binary part', () => {
    const entries = base().map((entry) =>
      entry.name === 'package/resources/ticket.ts'
        ? { ...entry, body: new Uint8Array([0xff, 0xfe, 0x00]) }
        : entry,
    );
    expect(refusal(tar(entries))).toContain('is not a text file');
  });

  it('refuses a package.json without the blueprint keyword, and a version mismatch', () => {
    const noKeyword = base().map((entry) =>
      entry.name === 'package/package.json'
        ? { ...entry, body: JSON.stringify({ ...PACKAGE, keywords: [] }) }
        : entry,
    );
    expect(refusal(tar(noKeyword))).toContain(`must list the keyword ${BLUEPRINT_PACKAGE_KEYWORD}`);
    const skewed = base([], { ...MANIFEST, version: '1.3.0' });
    expect(refusal(tar(skewed))).toContain('is 1.3.0, but package.json says 1.2.0');
  });

  it('refuses more than the file limit, and a corrupt header', () => {
    const many = Array.from({ length: 205 }, (_, index) => ({
      name: `package/README${String(index)}.md`,
      body: 'x',
    }));
    expect(refusal(tar(base(many)))).toContain('holds more than 200 files');
    const corrupt = tar(base());
    corrupt[600] = (corrupt[600] ?? 0) ^ 0xff;
    expect(refusal(corrupt)).toContain('is not a tar archive');
  });
});
