// The storage claims the operator pages make, held to the code they describe (the storage design,
// §04): the `AW_STORAGE_URL` schemes the configuration page lists are exactly the ones
// `parseStorageUrl` accepts, the data-plane page's signed-link table matches each backend's
// `capabilities`, and its size-limit table matches the limits defined once in the code.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStorageUrl } from '@indx-workspace/contracts/storage-url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { STORAGE_LIMITS } from '../fitness/storage-limits.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIGURATION_PAGE = 'docs/sdk/site/getting-started/configuration.mdx';
const DATA_PLANE_PAGE = 'docs/sdk/site/concepts/data-plane.mdx';

const text = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

/** The cells of every table row under `heading`, up to the next heading of the same or a higher level. */
function tableUnder(page: string, heading: string): string[][] {
  const lines = page.split('\n');
  const start = lines.indexOf(heading);
  if (start === -1) return [];
  const level = /^#+/u.exec(heading)?.[0].length ?? 0;
  const end = lines.findIndex(
    (line, index) =>
      index > start && /^#+ /u.test(line) && (/^#+/u.exec(line)?.[0].length ?? 0) <= level,
  );
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .filter((line) => line.startsWith('|') && !/^\|\s*-/u.test(line))
    .slice(1)
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
}

/** `` `s3://` `` → `s3`; anything else → `null`. */
const schemeOf = (cell: string | undefined): string | null =>
  /^`([a-z][a-z0-9+.-]*):\/\/`$/u.exec(cell ?? '')?.[1] ?? null;

/** The text of a backtick span that fills the whole cell. */
const codeOf = (cell: string | undefined): string | null =>
  /^`([^`]+)`$/u.exec(cell ?? '')?.[1] ?? null;

/**
 * The schemes `parseStorageUrl` accepts, found by asking it: a scheme it does not serve gets its one
 * fixed scheme refusal, and every other answer (accepted, or refused for a later reason) means the
 * scheme itself was accepted. The candidates are the schemes its own refusal names, the ones the
 * page lists, and the near misses an operator might try.
 */
function acceptedSchemes(documented: readonly string[]): string[] {
  const refusal = parseStorageUrl('not-a-storage-scheme://probe');
  if (refusal.ok) throw new Error('parseStorageUrl accepted a made-up scheme');
  const named = /one of (.+)$/u.exec(refusal.reason)?.[1]?.split(/,\s*/u) ?? [];
  const nearMisses = [
    'http',
    'https',
    'gs',
    'az',
    'azure',
    'abfs',
    'wasb',
    'minio',
    'r2',
    'memory',
  ];
  const candidates = new Set([...named, ...documented, ...nearMisses]);
  return [...candidates]
    .filter((scheme) => {
      const answer = parseStorageUrl(`${scheme}://probe/area`);
      return answer.ok || answer.reason !== refusal.reason;
    })
    .sort();
}

describe('the configuration page', () => {
  const rows = tableUnder(text(CONFIGURATION_PAGE), '## Tell the server where files live');

  it('configuration page lists exactly the accepted AW_STORAGE_URL schemes', () => {
    const documented = rows.map((row) => schemeOf(row[0])).filter((s): s is string => s !== null);
    expect(documented.length, `${CONFIGURATION_PAGE} has a scheme table`).toBeGreaterThan(0);
    expect([...documented].sort()).toEqual(acceptedSchemes(documented));
  });

  it('gives an example for each scheme that parses to that scheme', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const example = codeOf(row[2]) ?? '';
      const answer = parseStorageUrl(example);
      expect(answer, `${row[0]}: ${example}`).toMatchObject({ ok: true });
      expect(example.startsWith(`${schemeOf(row[0]) ?? '?'}://`), example).toBe(true);
    }
  });
});

const BACKEND_FILES: Readonly<Record<string, string>> = {
  file: 'packages/core/src/storage/local-fs-store.ts',
  s3: 'packages/core/src/storage/s3-store.ts',
  gcs: 'packages/core/src/storage/gcs-store.ts',
  azblob: 'packages/core/src/storage/azure-blob-store.ts',
};

type Capability = 'sign' | 'boundLengthSign';

/**
 * Whether the backend's `capabilities` literal can set `name`: `false` only when it is the literal
 * `false`. A condition (`sign !== undefined`) means the store signs when its credential can.
 */
function capability(file: string, name: Capability): boolean {
  const source = ts.createSourceFile(file, text(file), ts.ScriptTarget.Latest, true);
  const found: boolean[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === 'capabilities' &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText(source) === name) {
          found.push(property.initializer.kind !== ts.SyntaxKind.FalseKeyword);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found.length !== 1) throw new Error(`${file}: expected one capabilities.${name}`);
  return found[0] === true;
}

const yesOrNo = (cell: string | undefined): boolean | null =>
  /^yes\b/iu.test(cell ?? '') ? true : /^no\b/iu.test(cell ?? '') ? false : null;

describe('the data-plane page', () => {
  const page = text(DATA_PLANE_PAGE);

  it('says which stores sign links as their capabilities do', () => {
    const rows = tableUnder(page, '### Which stores sign links');
    const documented = rows.map((row) => schemeOf(row[0]));
    expect([...documented].sort()).toEqual(Object.keys(BACKEND_FILES).sort());
    for (const row of rows) {
      const file = BACKEND_FILES[schemeOf(row[0]) ?? ''] ?? '';
      expect(yesOrNo(row[1]), `${row[0]} signs links`).toBe(capability(file, 'sign'));
      expect(yesOrNo(row[2]), `${row[0]} binds the size`).toBe(capability(file, 'boundLengthSign'));
    }
  });

  it('lists each size limit with the value it is defined as', () => {
    const rows = tableUnder(page, '### Size limits');
    const documented = Object.fromEntries(
      rows.map((row) => {
        const size = /^(\d+) (MiB|GiB)\b/u.exec(row[1] ?? '');
        const bytes = size === null ? null : Number(size[1]) * 1024 ** (size[2] === 'GiB' ? 3 : 2);
        return [codeOf(row[2]) ?? row[2] ?? '', bytes];
      }),
    );
    expect(documented).toEqual(
      Object.fromEntries(STORAGE_LIMITS.map((limit) => [limit.name, limit.bytes])),
    );
  });
});
