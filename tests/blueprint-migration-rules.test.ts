/**
 * ADR-0166 D8: the SDK's copy of the expand-only migration rules, `destructiveMigrations`, stays
 * equal to the repository lint behind `pnpm migrations:lint` (`lintSql`), which a package cannot
 * import. The one intended difference is that a blueprint gets no `-- safe:` exception, so the
 * statements compared here carry none.
 */
import { destructiveMigrations } from '@indx-workspace/sdk/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { lintSql } from '../scripts/migrations.mjs';

/** Statements each rule refuses, and near misses each rule must let through. */
const STATEMENTS = [
  'CREATE TABLE "a" ("id" text PRIMARY KEY);',
  'ALTER TABLE "a" ADD COLUMN "b" text;',
  'ALTER TABLE "a" DROP COLUMN "b";',
  'DROP TABLE "a";',
  'DROP INDEX "a_b_idx";',
  'ALTER TABLE "a" ALTER COLUMN "b" DROP DEFAULT;',
  'ALTER TABLE "a" ALTER COLUMN "b" DROP NOT NULL;',
  'ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;',
  'ALTER TABLE "a" ALTER COLUMN "b" SET DEFAULT 0;',
  'ALTER TABLE "a" ALTER COLUMN "b" TYPE integer;',
  'ALTER TABLE "a" ALTER COLUMN "b" SET DATA TYPE bigint;',
  'ALTER TABLE "a" RENAME COLUMN "b" TO "c";',
  'ALTER TABLE "a" RENAME TO "b";',
  'ALTER TABLE "a" ADD CONSTRAINT "c" CHECK ("b" > 0);',
  'ALTER TABLE "a" ADD CONSTRAINT "c" CHECK ("b" > 0) NOT VALID;',
  'ALTER TABLE "a" ADD CHECK ("b" <> \'\');',
  'CREATE TABLE "c" ("id" text, CONSTRAINT "k" CHECK ("id" <> \'\'));',
  'CREATE INDEX "a_b_idx" ON "a" ("b");',
  '-- DROP TABLE "a";\nCREATE TABLE "d" ("id" text);',
  'drop table "lower";',
];

function sdkFindings(sql: string): string[] {
  return destructiveMigrations('migrations/0000_x.sql', sql).map(
    (finding) => `${finding.rule}: ${finding.statement}`,
  );
}

describe('the blueprint migration guard matches pnpm migrations:lint', () => {
  it.each(STATEMENTS)('agrees on %s', (sql) => {
    expect(sdkFindings(sql)).toEqual(lintSql(sql));
  });

  it('agrees on any migration built from those statements', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...STATEMENTS), { maxLength: 6 }), (statements) => {
        const sql = statements.join('\n--> statement-breakpoint\n');
        expect(sdkFindings(sql)).toEqual(lintSql(sql));
      }),
    );
  });
});
