import { describe, expect, it } from 'vitest';

import { BLUEPRINT_PACKAGE_KEYWORD, readBlueprintArchive } from './blueprint-archive.js';
import { ProjectRenderError } from './errors.js';

/** One tar entry: its full name, its type flag, its bytes and (for a link) its target. */
interface Entry {
  readonly name: string;
  readonly type?: string;
  readonly body?: string | Uint8Array;
  readonly link?: string;
}

const encoder = new TextEncoder();

function put(header: Uint8Array, offset: number, text: string): void {
  header.set(encoder.encode(text), offset);
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** A ustar archive, as `npm pack` writes one (its gunzipped bytes). */
function tar(entries: readonly Entry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const body =
      typeof entry.body === 'string'
        ? encoder.encode(entry.body)
        : (entry.body ?? new Uint8Array());
    const header = new Uint8Array(512);
    put(header, 0, entry.name);
    put(header, 100, octal(0o644, 8));
    put(header, 108, octal(0, 8));
    put(header, 116, octal(0, 8));
    put(header, 124, octal(body.length, 12));
    put(header, 136, octal(0, 12));
    put(header, 148, '        ');
    put(header, 156, entry.type ?? '0');
    if (entry.link !== undefined) put(header, 157, entry.link);
    put(header, 257, 'ustar\u000000');
    const sum = header.reduce((total, byte) => total + byte, 0);
    put(header, 148, `${sum.toString(8).padStart(6, '0')}\0 `);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

const MANIFEST = {
  name: 'helpdesk',
  version: '1.2.0',
  appKit: '^0.9.0',
  parts: [{ path: 'resources/ticket.ts', kind: 'resource' }],
  slots: { connectors: [], secrets: [], agents: [] },
  migrations: ['migrations/0000_create_tickets.sql'],
};

const PACKAGE = {
  name: '@acme/helpdesk-blueprint',
  version: '1.2.0',
  keywords: [BLUEPRINT_PACKAGE_KEYWORD],
};

function base(extra: readonly Entry[] = [], manifest: object = MANIFEST): Entry[] {
  return [
    { name: 'package', type: '5' },
    { name: 'package/package.json', body: JSON.stringify(PACKAGE) },
    { name: 'package/blueprint.json', body: JSON.stringify(manifest) },
    { name: 'package/README.md', body: '# Helpdesk\n' },
    { name: 'package/resources/ticket.ts', body: 'export default {};\n' },
    {
      name: 'package/migrations/0000_create_tickets.sql',
      body: 'CREATE TABLE "{{appSchema}}"."tickets" ();\n',
    },
    ...extra,
  ];
}

function refusal(bytes: Uint8Array): string {
  try {
    readBlueprintArchive(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectRenderError);
    return (error as ProjectRenderError).message;
  }
  throw new Error('expected a refusal');
}

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
