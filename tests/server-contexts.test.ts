import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * The server's bounded contexts (refactoring plan part 04, step 1): every folder in
 * `apps/web/server/` belongs to exactly one context, the shared kernel or the composition root, and
 * the table in `docs/architecture.md` ("Server contexts") says the same as the data.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const SERVER = 'apps/web/server/';
const DATA = `${SERVER}contexts.json`;
const DOC = 'docs/architecture.md';
const START = '<!-- server-contexts:start -->';
const END = '<!-- server-contexts:end -->';

const folders = z.array(z.string().min(1)).min(1);
const ContextMap = z
  .object({
    $comment: z.string(),
    sharedKernel: folders,
    compositionRoot: z.string().min(1),
    contexts: z
      .array(
        z
          .object({
            name: z.string().min(1),
            /** Part 04, step 7: the one file other contexts import this context through. */
            entry: z
              .string()
              .regex(/^[a-z0-9-]+\/index\.ts$/u)
              .optional(),
            folders,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
type ContextMap = z.infer<typeof ContextMap>;

/** Rows in reading order: the shared kernel, the contexts upstream first, the composition root. */
function rowsOf(map: ContextMap): Array<{ name: string; folders: readonly string[] }> {
  return [
    { name: 'shared kernel', folders: map.sharedKernel },
    ...map.contexts,
    { name: 'composition root', folders: [map.compositionRoot] },
  ];
}

/** Folder → the entries that list it; a folder listed twice shows up with two names. */
function owners(map: ContextMap): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const row of rowsOf(map)) {
    for (const folder of row.folders) found.set(folder, [...(found.get(folder) ?? []), row.name]);
  }
  return found;
}

/** The table rows between the markers, as `name → folders`, in the order written. */
function tableRows(doc: string): Array<{ name: string; folders: string[] }> {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < start) throw new Error(`${DOC} has no ${START} … ${END} block`);
  return doc
    .slice(start + START.length, end)
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2)
    .map((line) => {
      const [name = '', cells = ''] = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      return { name, folders: [...cells.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '') };
    });
}

function serverFolders(): string[] {
  const files = execFileSync('git', ['ls-files', '-z', '--', SERVER], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file !== '');
  const dirs = new Set<string>();
  for (const file of files) {
    const rest = file.slice(SERVER.length);
    const slash = rest.indexOf('/');
    if (slash > 0) dirs.add(rest.slice(0, slash));
  }
  return [...dirs].sort();
}

const map = ContextMap.parse(JSON.parse(readFileSync(root + DATA, 'utf8')));

describe('server contexts (refactoring part 04)', () => {
  it('puts every server folder in exactly one entry', () => {
    const listed = owners(map);
    const twice = [...listed]
      .filter(([, names]) => names.length > 1)
      .map(([f, n]) => `${f}: ${n.join(', ')}`);
    expect(twice, 'folders listed in more than one entry').toEqual([]);
    const missing = serverFolders().filter((folder) => !listed.has(folder));
    expect(missing, `server folders missing from ${DATA}`).toEqual([]);
  });

  it('lists no folder that does not exist', () => {
    const real = new Set(serverFolders());
    expect([...owners(map).keys()].filter((folder) => !real.has(folder))).toEqual([]);
  });

  it('matches the table in docs/architecture.md, row by row and in order', () => {
    const doc = readFileSync(root + DOC, 'utf8');
    expect(tableRows(doc)).toEqual(
      rowsOf(map).map((row) => ({ name: row.name, folders: [...row.folders] })),
    );
  });

  it('gives each entry as an index.ts in one of its own folders, and the file exists', () => {
    const files = new Set(
      execFileSync('git', ['ls-files', '-z', '--', SERVER], { cwd: root, encoding: 'utf8' })
        .split('\0')
        .filter((file) => file !== ''),
    );
    const wrong = map.contexts
      .filter((c) => c.entry !== undefined)
      .filter((c) => {
        const folder = c.entry?.split('/')[0] ?? '';
        return !c.folders.includes(folder) || !files.has(`${SERVER}${c.entry}`);
      })
      .map((c) => `${c.name}: ${c.entry}`);
    expect(wrong).toEqual([]);
    expect(map.contexts.find((c) => c.name === 'identity')?.entry).toBe('identity/index.ts');
    expect(map.contexts.find((c) => c.name === 'evaluations')?.entry).toBe('evaluations/index.ts');
    expect(map.contexts.find((c) => c.name === 'secrets')?.entry).toBe('secrets/index.ts');
    expect(map.contexts.find((c) => c.name === 'agents')?.entry).toBe('agents/index.ts');
    expect(map.contexts.find((c) => c.name === 'execution')?.entry).toBe('execution/index.ts');
    expect(map.contexts.find((c) => c.name === 'integrations')?.entry).toBe(
      'integrations/index.ts',
    );
    expect(map.contexts.find((c) => c.name === 'storage and sharing')?.entry).toBe(
      'storage-and-sharing/index.ts',
    );
  });

  it('catches a duplicate, a missing folder and a table that drifted (fixtures)', () => {
    const duplicate: ContextMap = { ...map, sharedKernel: [...map.sharedKernel, 'runs'] };
    expect(owners(duplicate).get('runs')).toEqual(['shared kernel', 'execution']);

    const doc = [
      START,
      '',
      '| Context | Folders |',
      '| - | - |',
      '| identity | `auth`, `rbac` |',
      '',
      END,
    ].join('\n');
    expect(tableRows(doc)).toEqual([{ name: 'identity', folders: ['auth', 'rbac'] }]);
    expect(() => tableRows('no markers')).toThrow(/no <!-- server-contexts:start -->/);
  });
});
