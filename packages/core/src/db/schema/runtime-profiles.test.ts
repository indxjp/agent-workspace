/**
 * The missing pins (W3-CP-06-B4). This file's sibling — `runtime-profiles.ts` — and
 * `packages/core/src/schemas.ts` both used to say that a test "pins the three lists equal":
 * `packages/runtime/src/driver.ts`'s `RuntimeDriverId` (spec §14.2), this file's
 * `runtimeProfileDrivers`, and `schemas.ts`'s `runtimeDriverIds`. Before round 2, no such file
 * existed. Round 2 added it — and it is not three copies, it is FOUR: a fourth, independently
 * hand-typed value list is compiled straight into `migrations/0002_w3_runtime_profiles.sql`'s
 * `runtime_profiles_driver_valid` CHECK constraint by `drizzle-kit generate`, committed once, and
 * never regenerated or diffed by anything in CI (`.github/workflows/ci.yml` has no drizzle-drift
 * step; `tenancy.test.ts` compares only the SET OF TABLE NAMES between `migrations/` and this
 * directory, never a constraint body). That fourth copy is the one an operator's real database
 * actually enforces, and round 2's gate below did not touch it — a driver added to the spec and to
 * every TypeScript copy still died as a `23514` at a driver task's integration, exactly the outcome
 * B4 says must not happen. Round 3 adds the fourth pin, in the second `describe` below.
 *
 * `packages/core` may add no dependency on `packages/runtime` this level (ADR-0041), and
 * `RuntimeDriverId` is a `type`, not a `const` — there is no runtime value to import even if the
 * dependency existed. So the first gate does what `network-policy.test.ts` (a sibling task's own
 * spec-transcription gate, `apps/web/server/runtimes/network-policy.test.ts`) already does for
 * §15.2: it reads `docs/spec.md` at test time, extracts §14.2's fenced ` ```ts ` block with the
 * TypeScript compiler (ADR-0030 — a construct is read by a parser, not matched by regex), and pins
 * both of this package's hand-written copies to the spec's own union. That is the ground truth
 * `packages/runtime/src/driver.ts` itself is transcribed from (its own header: "spec §14.2 ...
 * verbatim"), so a driver added to the spec and not to either of THIS package's two copies fails
 * here, at the same moment `packages/runtime/src/spec-transcription.test.ts` would catch it being
 * added to `driver.ts` and not the spec — the two gates meet at the spec, not at each other,
 * because this package cannot import the other one to meet it there directly. The second gate
 * pins the committed migration SQL directly to `runtimeProfileDrivers` — not to the spec, because
 * the migration is a generated artifact of THIS file's schema, not of the spec — which closes the
 * loop transitively: spec -> `runtimeProfileDrivers` (first gate) -> migration CHECK (second
 * gate). A driver added everywhere in TypeScript and left out of a hand-edited or forgotten
 * migration now fails at `pnpm test`, not at a driver task's integration.
 *
 * Watched failing on a tree it ought to reject (ADR-0029): add `"fly-machines"` to §14.2's
 * `RuntimeDriverId` union in `docs/spec.md`, `packages/runtime/src/driver.ts`,
 * `runtimeDriverIds` and `runtimeProfileDrivers` — every place round 2's own gate recognised —
 * leaving `migrations/0002_w3_runtime_profiles.sql` untouched: the first `describe` below stays
 * green (all four TypeScript-visible copies still agree) and the second `describe` fails, naming
 * the migration as short one member. See this task's PR report for the pasted transcript.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { runtimeDriverIds } from '../../schemas.js';
import { runtimeProfileDrivers } from './runtime-profiles.js';

const SPEC_PATH = path.resolve(import.meta.dirname, '../../../../../docs/spec.md');
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../../../../migrations');
const SPEC_HEADING = '## 14.2 The runtime driver interface';
const UNION_NAME = 'RuntimeDriverId';

/** The markdown section from `heading` up to (not including) the next `## ` heading. */
function sectionUnder(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const startIndex = lines.findIndex((line) => line.trimEnd().startsWith(heading));
  if (startIndex === -1) {
    throw new Error(`docs/spec.md has no heading starting with ${JSON.stringify(heading)}.`);
  }
  const rest = lines.slice(startIndex + 1);
  const endOffset = rest.findIndex((line) => /^#{1,6}\s/u.test(line));
  return (endOffset === -1 ? rest : rest.slice(0, endOffset)).join('\n');
}

/** The first ` ```ts ` fenced block in `section`, or a refusal naming the heading (ADR-0015). */
function firstFencedTsBlock(section: string, heading: string): string {
  const match = /```ts\r?\n([\s\S]*?)```/u.exec(section);
  if (match?.[1] === undefined) {
    throw new Error(`No \`\`\`ts fenced block found under ${JSON.stringify(heading)}.`);
  }
  return match[1];
}

/**
 * Parse `source` (a spec fenced block) and return the string-literal members of the union type
 * alias named `unionName`. Refuses — never silently skips — a union member that is not a bare
 * string literal, and refuses if the alias is absent (ADR-0015 and ADR-0031: an absent or
 * malformed answer fails, it is not treated as "nothing to check").
 */
function specStringUnion(source: string, unionName: string, where: string): readonly string[] {
  const sourceFile = ts.createSourceFile('spec-14-2.ts', source, ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== unionName) continue;
    const { type } = statement;
    if (!ts.isUnionTypeNode(type)) {
      throw new Error(`${where}'s ${unionName} is not a union type; this gate cannot run.`);
    }
    return type.types.map((member) => {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
        throw new Error(
          `${where}'s ${unionName} has a union member that is not a bare string literal: ` +
            `${normalizeText(member.getText(sourceFile))}.`,
        );
      }
      return member.literal.text;
    });
  }
  throw new Error(`${where} declares no ${unionName} type alias; this gate cannot run.`);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

describe('§14.2 driver catalogue — pinned to docs/spec.md, not just to each other', () => {
  it('this package’s two driver-id copies both equal §14.2’s union, read from docs/spec.md', () => {
    const specText = readFileSync(SPEC_PATH, 'utf8');
    const block = firstFencedTsBlock(sectionUnder(specText, SPEC_HEADING), SPEC_HEADING);
    const specDrivers = specStringUnion(block, UNION_NAME, 'docs/spec.md §14.2');

    // Sanity: the spec itself must name at least one driver, or this gate is vacuously green.
    expect(specDrivers.length).toBeGreaterThan(0);

    expect([...runtimeDriverIds].sort()).toEqual([...specDrivers].sort());
    expect([...runtimeProfileDrivers].sort()).toEqual([...specDrivers].sort());
  });
});

// ── The fourth copy: the committed migration's own CHECK constraint (W3-CP-06-B4, round 3) ────

/** Every `*.sql` migration file, oldest first — the numeric filename prefix is the ordering. */
function migrationFilesOldestFirst(migrationsDir: string): readonly string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/**
 * Split a `CHECK (... in (...))` value list — `"'a', 'b', 'c'"` — into its string values.
 * Refuses (does not skip) anything that is not a single-quoted literal, so a hand-edited
 * constraint this gate cannot parse is a failure, never a silently-empty list (ADR-0015).
 */
function parseQuotedValueList(rawList: string, where: string): readonly string[] {
  return rawList.split(',').map((raw) => {
    const trimmed = raw.trim();
    const literal = /^'([^']*)'$/u.exec(trimmed);
    if (literal?.[1] === undefined) {
      throw new Error(
        `${where}: cannot parse ${JSON.stringify(trimmed)} as a single-quoted value.`,
      );
    }
    return literal[1];
  });
}

/**
 * The `runtime_profiles_driver_valid` CHECK constraint's value list, read in migration and
 * statement order. A later migration may drop and redefine the constraint. Every mention must be
 * understood as one of those operations; an unfamiliar spelling is refused instead of falling
 * back to stale SQL. This is a deliberately narrow parser, not a claim to model PostgreSQL.
 */
function driverCheckConstraintFromMigrations(migrationsDir: string): readonly string[] {
  const constraintNamePattern = /runtime_profiles_driver_valid/giu;
  const operationPattern =
    /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"runtime_profiles_driver_valid"|(?:CONSTRAINT\s+)?"runtime_profiles_driver_valid"\s+CHECK\s*\(\s*(?:"runtime_profiles"\.)?"driver"\s+in\s+\(([^)]*)\)\s*\)/giu;
  let found: { readonly file: string; readonly values: readonly string[] } | null = null;
  for (const file of migrationFilesOldestFirst(migrationsDir)) {
    const text = readFileSync(path.join(migrationsDir, file), 'utf8');
    const mentions = [...text.matchAll(constraintNamePattern)];
    if (mentions.length === 0) continue;

    const operations = [...text.matchAll(operationPattern)];
    if (operations.length !== mentions.length) {
      throw new Error(
        `${file} mentions runtime_profiles_driver_valid ${String(mentions.length)} time(s), ` +
          `but this gate can parse only ${String(operations.length)} operation(s).`,
      );
    }

    for (const operation of operations) {
      const rawValues = operation[1];
      found =
        rawValues === undefined
          ? null
          : {
              file,
              values: parseQuotedValueList(
                rawValues,
                `${file}'s runtime_profiles_driver_valid CHECK`,
              ),
            };
    }
  }
  if (found === null) {
    throw new Error(
      `No file in ${migrationsDir} defines the runtime_profiles_driver_valid CHECK constraint; ` +
        'this gate cannot run.',
    );
  }
  return found.values;
}

describe('§14.2 driver catalogue — the migration CHECK an operator’s database actually enforces (W3-CP-06-B4)', () => {
  it('migrations/*.sql’s runtime_profiles_driver_valid CHECK equals this file’s runtimeProfileDrivers', () => {
    const migrationDrivers = driverCheckConstraintFromMigrations(MIGRATIONS_DIR);

    // Sanity: the constraint itself must name at least one driver, or this gate is vacuously
    // green (the same shape as the spec-emptiness check in the describe block above).
    expect(migrationDrivers.length).toBeGreaterThan(0);

    expect([...migrationDrivers].sort()).toEqual([...runtimeProfileDrivers].sort());
  });

  it('uses the final constraint operation within a migration, including an unqualified driver column', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'w3-cp-06-migrations-'));
    try {
      writeFileSync(
        path.join(directory, '0001.sql'),
        'CONSTRAINT "runtime_profiles_driver_valid" CHECK ("runtime_profiles"."driver" in (\'stale\'));',
      );
      writeFileSync(
        path.join(directory, '0002.sql'),
        'ALTER TABLE "runtime_profiles" DROP CONSTRAINT "runtime_profiles_driver_valid";\n' +
          'ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_driver_valid" CHECK ("driver" in (\'local\', \'docker\'));',
      );
      expect(driverCheckConstraintFromMigrations(directory)).toEqual(['local', 'docker']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a final DROP with no replacement instead of accepting a stale definition', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'w3-cp-06-migrations-'));
    try {
      writeFileSync(
        path.join(directory, '0001.sql'),
        'CONSTRAINT "runtime_profiles_driver_valid" CHECK ("runtime_profiles"."driver" in (\'local\'));',
      );
      writeFileSync(
        path.join(directory, '0002.sql'),
        'ALTER TABLE "runtime_profiles" DROP CONSTRAINT "runtime_profiles_driver_valid";',
      );
      expect(() => driverCheckConstraintFromMigrations(directory)).toThrow(/cannot run/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a constraint mention whose SQL shape the narrow parser does not understand', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'w3-cp-06-migrations-'));
    try {
      writeFileSync(
        path.join(directory, '0001.sql'),
        'CONSTRAINT "runtime_profiles_driver_valid" CHECK (length("driver") > 0);',
      );
      expect(() => driverCheckConstraintFromMigrations(directory)).toThrow(/can parse only 0/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
