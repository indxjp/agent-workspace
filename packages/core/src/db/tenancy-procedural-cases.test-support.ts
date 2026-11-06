import { describe, expect, it } from 'vitest';
import { classifyStatement } from './tenancy-migration-verdict.test-support.js';
export function defineProceduralCases(): void {
  describe('migration table inventory — procedural body inspection', () => {
    it.each([
      {
        name: 'CREATE TABLE in a function',
        sql: `CREATE FUNCTION "public"."unsafe_create"() RETURNS void LANGUAGE plpgsql AS $body$
        BEGIN
          CREATE TABLE "hidden" ("id" uuid);
        END
      $body$`,
        expected: 'CREATE TABLE',
      },
      {
        name: 'DROP TABLE in a DO block',
        sql: `DO $body$
        BEGIN
          DROP TABLE "existing";
        END
      $body$`,
        expected: 'DROP TABLE',
      },
      {
        name: 'ALTER TABLE RENAME TO in a DO block',
        sql: `DO $body$
        BEGIN
          ALTER TABLE "before" RENAME TO "after";
        END
      $body$`,
        expected: 'ALTER TABLE RENAME TO',
      },
      {
        name: 'dynamic SQL whose literal creates a table',
        sql: `DO $body$
        BEGIN
          EXECUTE 'CREATE TABLE "hidden_dynamic" ("id" uuid)';
        END
      $body$`,
        expected: 'dynamic SQL (EXECUTE)',
      },
      {
        name: 'dynamic SQL assembled without a visible DDL literal',
        sql: `DO $body$
        DECLARE
          command text;
        BEGIN
          command := current_setting('app.migration_command');
          EXECUTE command;
        END
      $body$`,
        expected: 'dynamic SQL (EXECUTE)',
      },
    ])('rejects $name', ({ sql, expected }) => {
      expect(() => classifyStatement(sql, 'procedural-regression.sql')).toThrow(expected);
    });

    it('does not treat comments or literal error text as executable table DDL', () => {
      const verdict = classifyStatement(
        `CREATE FUNCTION "public"."safe_notice"() RETURNS trigger
       LANGUAGE plpgsql
       SET search_path = pg_catalog
       AS $body$
       BEGIN
         -- CREATE TABLE "comment_only" ("id" uuid);
         /* DROP TABLE "comment_only"; */
         RAISE EXCEPTION 'ALTER TABLE old RENAME TO new';
         PERFORM "CREATE TABLE";
         RETURN NEW;
       END
       $body$`,
        'procedural-regression.sql',
      );
      expect(verdict.kind).toBe('leaves-the-table-set-alone');
    });
  });
}
