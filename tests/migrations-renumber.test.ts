import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { checkMigrations, lintSql, mergeSnapshots } from '../scripts/migrations.mjs';

const script = fileURLToPath(new URL('../scripts/migrations.mjs', import.meta.url));

interface Entry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function snapshot(id: string, prevId: string, tables: Record<string, unknown>): string {
  return JSON.stringify({ id, prevId, version: '7', dialect: 'postgresql', tables }, null, 2);
}

async function readJournal(root: string): Promise<Entry[]> {
  const raw = await readFile(path.join(root, 'migrations', 'meta', '_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: Entry[] }).entries;
}

/** Append one migration the way `drizzle-kit generate` does: SQL, journal entry, snapshot. */
async function addMigration(
  root: string,
  name: string,
  when: number,
  tables: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(root, 'migrations');
  const entries = await readJournal(root);
  const idx = entries.length;
  const tag = `${String(idx).padStart(4, '0')}_${name}`;
  const prev = JSON.parse(
    await readFile(
      path.join(dir, 'meta', `${String(idx - 1).padStart(4, '0')}_snapshot.json`),
      'utf8',
    ),
  ) as { id: string };
  entries.push({ idx, version: '7', when, tag, breakpoints: true });
  await writeFile(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }, null, 2),
  );
  await writeFile(path.join(dir, `${tag}.sql`), `CREATE TABLE "${name}" ();\n`);
  await writeFile(
    path.join(dir, 'meta', `${String(idx).padStart(4, '0')}_snapshot.json`),
    snapshot(`id-${name}`, prev.id, tables),
  );
}

/** A repository whose main holds 0000_base; `a` and `b` each add migration 0001 from it. */
async function twoBranches(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'aw-renumber-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'core.autocrlf', 'false');
  await mkdir(path.join(root, 'migrations', 'meta'), { recursive: true });
  await writeFile(
    path.join(root, 'migrations', 'meta', '_journal.json'),
    JSON.stringify(
      {
        version: '7',
        dialect: 'postgresql',
        entries: [{ idx: 0, version: '7', when: 1000, tag: '0000_base', breakpoints: true }],
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(root, 'migrations', '0000_base.sql'), 'CREATE TABLE "base" ();\n');
  await writeFile(
    path.join(root, 'migrations', 'meta', '0000_snapshot.json'),
    snapshot('id-base', '00000000-0000-0000-0000-000000000000', { 'public.base': {} }),
  );
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');

  git(root, 'checkout', '-q', '-b', 'a');
  // Branch `a` generated later than `b`, so main's newest `when` ends up AFTER b's.
  await addMigration(root, 'a', 3000, { 'public.base': {}, 'public.a': {} });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'a');

  git(root, 'checkout', '-q', '-b', 'b', 'main');
  await addMigration(root, 'b', 2000, { 'public.base': {}, 'public.b': {} });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'b');

  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--ff-only', 'a');
  git(root, 'checkout', '-q', 'b');
  return root;
}

function renumber(root: string, ...args: string[]): string {
  return execFileSync(process.execPath, [script, 'renumber', '--onto', 'main', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('pnpm migrations:renumber', () => {
  it('moves the branch migration after the one main landed, mid-merge', async () => {
    const root = await twoBranches();
    // The collision: both branches wrote 0001 and appended to the same journal array.
    expect(() => git(root, 'merge', '-q', 'main')).toThrow();

    renumber(root);

    const entries = await readJournal(root);
    expect(entries.map((entry) => [entry.idx, entry.tag])).toEqual([
      [0, '0000_base'],
      [1, '0001_a'],
      [2, '0002_b'],
    ]);
    // b was generated at 2000, before main's 3000: it must still sort after it.
    expect(entries.map((entry) => entry.when)).toEqual([1000, 3000, 3001]);
    const dir = path.join(root, 'migrations');
    expect((await readdir(dir)).filter((file) => file.endsWith('.sql')).toSorted()).toEqual([
      '0000_base.sql',
      '0001_a.sql',
      '0002_b.sql',
    ]);
    // Main's migration is byte-for-byte main's; the branch's SQL is unchanged (same hash).
    expect(await readFile(path.join(dir, '0001_a.sql'), 'utf8')).toBe('CREATE TABLE "a" ();\n');
    expect(await readFile(path.join(dir, '0002_b.sql'), 'utf8')).toBe('CREATE TABLE "b" ();\n');
    const moved = JSON.parse(
      await readFile(path.join(dir, 'meta', '0002_snapshot.json'), 'utf8'),
    ) as { id: string; prevId: string; tables: Record<string, unknown> };
    expect(moved.id).toBe('id-b');
    expect(moved.prevId).toBe('id-a');
    // The snapshot carries both branches' schema, so the next `db:generate` diffs correctly.
    expect(Object.keys(moved.tables).toSorted()).toEqual(['public.a', 'public.b', 'public.base']);
    expect(checkMigrations(dir)).toEqual([]);

    git(root, 'add', '-A');
    git(root, 'commit', '-q', '--no-edit');
    // Re-running after the merge commit is a no-op.
    renumber(root);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('is a no-op when main has not moved', async () => {
    const root = await twoBranches();
    git(root, 'checkout', '-q', 'a');
    renumber(root);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });
});

describe('checkMigrations', () => {
  it('names pnpm migrations:renumber when a hand-merged journal collides', async () => {
    const root = await twoBranches();
    expect(() => git(root, 'merge', '-q', 'main')).toThrow();
    // A hand resolution that keeps both entries but renumbers nothing.
    const dir = path.join(root, 'migrations');
    await writeFile(
      path.join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [
          { idx: 0, version: '7', when: 1000, tag: '0000_base', breakpoints: true },
          { idx: 1, version: '7', when: 3000, tag: '0001_a', breakpoints: true },
          { idx: 1, version: '7', when: 2000, tag: '0001_b', breakpoints: true },
        ],
      }),
    );
    const problems = checkMigrations(dir);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('entry 2 has idx 1'),
        expect.stringContaining('0001_b'),
      ]),
    );
    const run = (): string =>
      execFileSync(process.execPath, [script, 'check'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    expect(run).toThrow(/pnpm migrations:renumber/);
  });

  it('accepts the repository migrations', () => {
    const dir = fileURLToPath(new URL('../migrations', import.meta.url));
    expect(checkMigrations(dir)).toEqual([]);
  });
});

describe('mergeSnapshots', () => {
  it('refuses a column both sides changed differently', () => {
    const base = { tables: { t: { columns: { c: { type: 'text' } } } } };
    expect(() =>
      mergeSnapshots(
        base,
        { tables: { t: { columns: { c: { type: 'integer' } } } } },
        { tables: { t: { columns: { c: { type: 'uuid' } } } } },
      ),
    ).toThrow(/tables\.t\.columns\.c\.type/);
  });

  it('keeps a deletion on one side and an addition on the other', () => {
    const base = { tables: { gone: {}, kept: {} } };
    expect(
      mergeSnapshots(base, { tables: { kept: {} } }, { tables: { gone: {}, kept: {}, added: {} } }),
    ).toEqual({ tables: { kept: {}, added: {} } });
  });
});

describe('mergeSnapshots column order', () => {
  it('puts main’s new column where main has it and keeps the branch’s own order', () => {
    const cols = (...names: string[]) => ({
      tables: { t: { columns: Object.fromEntries(names.map((n) => [n, { type: 'text' }])) } },
    });
    const merged = mergeSnapshots(
      cols('id', 'status', 'created_at'),
      cols('id', 'status', 'created_at', 'branch_col'),
      cols('id', 'file_grants', 'status', 'created_at'),
    ) as ReturnType<typeof cols>;
    expect(Object.keys(merged.tables.t.columns)).toEqual([
      'id',
      'file_grants',
      'status',
      'created_at',
      'branch_col',
    ]);
  });
});

describe('lintSql', () => {
  const bad = [
    'ALTER TABLE "a" DROP COLUMN "b";',
    'DROP TABLE "a";',
    'ALTER TABLE "a" DROP CONSTRAINT "c";',
    'DROP INDEX "i";',
    'ALTER TABLE "a" RENAME COLUMN "b" TO "c";',
    'ALTER TABLE "a" RENAME TO "z";',
    'ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;',
    'ALTER TABLE "a" ALTER COLUMN "b" SET DATA TYPE integer;',
    'ALTER TABLE "a" ALTER COLUMN "b" TYPE integer;',
  ];

  it.each(bad)('rejects %s', (sql) => {
    expect(lintSql(sql)).not.toEqual([]);
  });

  it.each(bad)('accepts %s with a safe marker in its statement', (sql) => {
    expect(lintSql(`-- safe: table is empty in every environment\n${sql}`)).toEqual([]);
  });

  it('marker covers only its own statement', () => {
    const sql = `-- safe: ok\nDROP TABLE "a";\n--> statement-breakpoint\nDROP TABLE "b";`;
    expect(lintSql(sql)).toHaveLength(1);
  });

  it('rejects a marker without a reason and ignores commented-out DDL', () => {
    expect(lintSql('-- safe:\nDROP TABLE "a";')).not.toEqual([]);
    expect(lintSql('-- DROP TABLE "a";\nCREATE TABLE "b" ("id" text);')).toEqual([]);
  });

  it('allows additive and loosening DDL', () => {
    const ok = [
      'CREATE TABLE "a" ("id" text);',
      'ALTER TABLE "a" ADD COLUMN "b" text;',
      'ALTER TABLE "a" ALTER COLUMN "b" DROP NOT NULL;',
      'ALTER TABLE "a" ALTER COLUMN "b" SET DEFAULT 1;',
      'CREATE INDEX "i" ON "a" ("b");',
    ];
    for (const sql of ok) expect(lintSql(sql)).toEqual([]);
  });
});

describe('migrations lint (CLI)', () => {
  it('fails on an unjustified DROP added after the base and passes with the marker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mig-lint-'));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@t');
    git(root, 'config', 'user.name', 't');
    await mkdir(path.join(root, 'migrations'));
    await writeFile(path.join(root, 'migrations', '0000_old.sql'), 'DROP TABLE "legacy";\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    const lint = () =>
      spawnSync('node', [script, 'lint', '--base', 'main'], { cwd: root, encoding: 'utf8' });
    const add = async (sql: string) => {
      await writeFile(path.join(root, 'migrations', '0001_new.sql'), sql);
      git(root, 'checkout', '-q', '-B', 'work');
      git(root, 'add', '.');
      git(root, 'commit', '-q', '-m', 'new', '--allow-empty');
    };
    const noRef = spawnSync('node', [script, 'lint'], { cwd: root, encoding: 'utf8' });
    expect(noRef.status).toBe(0);
    expect(noRef.stdout).toContain('skipping');
    const badBase = spawnSync('node', [script, 'lint', '--base', 'nope'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(badBase.status).not.toBe(0);
    await add('ALTER TABLE "a" DROP COLUMN "b";\n');
    const failed = lint();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('0001_new.sql');
    await add('-- safe: column unused since 0.3\nALTER TABLE "a" DROP COLUMN "b";\n');
    expect(lint().status).toBe(0);
  }, 30_000);
});
