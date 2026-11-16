import { expect } from 'vitest';

import { BLUEPRINT_PACKAGE_KEYWORD, readBlueprintArchive } from './blueprint-archive.js';
import { ProjectRenderError } from './errors.js';

/** One tar entry: its full name, its type flag, its bytes and (for a link) its target. */
export interface Entry {
  readonly name: string;
  readonly type?: string;
  readonly body?: string | Uint8Array;
  readonly link?: string;
}

export const encoder = new TextEncoder();

function put(header: Uint8Array, offset: number, text: string): void {
  header.set(encoder.encode(text), offset);
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** A ustar archive, as `npm pack` writes one (its gunzipped bytes). */
export function tar(entries: readonly Entry[]): Uint8Array {
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

export const MANIFEST = {
  name: 'helpdesk',
  version: '1.2.0',
  appKit: '^0.9.0',
  parts: [{ path: 'resources/ticket.ts', kind: 'resource' }],
  slots: { connectors: [], secrets: [], agents: [] },
  migrations: ['migrations/0000_create_tickets.sql'],
};

export const PACKAGE = {
  name: '@acme/helpdesk-blueprint',
  version: '1.2.0',
  keywords: [BLUEPRINT_PACKAGE_KEYWORD],
};

export function base(extra: readonly Entry[] = [], manifest: object = MANIFEST): Entry[] {
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

export function refusal(bytes: Uint8Array): string {
  try {
    readBlueprintArchive(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectRenderError);
    return (error as ProjectRenderError).message;
  }
  throw new Error('expected a refusal');
}
