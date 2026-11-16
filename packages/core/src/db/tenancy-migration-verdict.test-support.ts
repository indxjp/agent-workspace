import {
  CREATE_TABLE_HEAD,
  tableNamesIn,
  DROP_TABLE_HEAD,
  ALTER_TABLE_HEAD,
  ALTER_TABLE_RENAME_TO,
  tableIdentifier,
  excerpt,
  CREATE_SCHEMA_HEAD,
  CREATE_SCHEMA_WITHOUT_ELEMENTS,
  CREATE_FUNCTION_HEAD,
  DO_HEAD,
  assertProceduralBodyLeavesTableSetAlone,
} from './tenancy-migration-sql.test-support.js';

/**
 * The verdict {@link classifyStatement} gives one migration statement. Every statement gets one;
 * there is no fifth outcome and no way to contribute nothing without saying so.
 */
type StatementVerdict =
  | { readonly kind: 'creates-tables'; readonly names: readonly string[] }
  | { readonly kind: 'drops-tables'; readonly names: readonly string[] }
  | { readonly kind: 'renames-a-table'; readonly from: string; readonly to: string }
  | { readonly kind: 'leaves-the-table-set-alone'; readonly why: string };

/**
 * Statement forms that provably cannot change WHICH tables exist, each with the reason it cannot.
 *
 * This is a classifier's positive cases, not a list of members: a statement matching none of them
 * — and none of the table forms above — is rejected by name, so adding a form here is a deliberate
 * edit that has to state why the form is harmless to the inventory.
 *
 * `CREATE SCHEMA` is deliberately absent: whether it creates a table depends on what follows its
 * header, so it is classified by its own branch in {@link classifyStatement} rather than by a
 * pattern that would answer for every form of it at once. `CREATE EXTENSION` is absent for a
 * reason it does not share: an extension's script can itself run `CREATE TABLE`, and nothing here
 * reads an extension's contents, so no entry could state truthfully that the form creates no
 * table.
 */
const TABLE_SET_NEUTRAL: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/iu, why: 'creates an index, not a table' },
  { pattern: /^DROP\s+INDEX\b/iu, why: 'drops an index, not a table' },
  { pattern: /^ALTER\s+INDEX\b/iu, why: 'alters an index, not a table' },
  { pattern: /^(?:CREATE|ALTER|DROP)\s+TYPE\b/iu, why: 'a type, which is not a table' },
  { pattern: /^(?:CREATE|ALTER|DROP)\s+SEQUENCE\b/iu, why: 'a sequence, which is not a table' },
  {
    pattern: /^CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\b/iu,
    why: 'attaches a trigger to an existing table; it creates no table',
  },
  { pattern: /^COMMENT\s+ON\b/iu, why: 'attaches a comment; it creates and drops nothing' },
  {
    pattern: /^(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\b/iu,
    why: 'changes rows, not the set of tables',
  },
];

/**
 * `ALTER TABLE` actions that change a table's SHAPE rather than the set of tables, with reasons.
 *
 * `RENAME TO` is deliberately absent — it is handled above as its own verdict, because it does
 * change the set. `SET SCHEMA` is deliberately absent too: it moves the table, and this reader
 * strips schema qualifiers, so it would be read as a no-op when it is not one.
 */
const ALTER_TABLE_SHAPE_ONLY: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /^ADD\b/iu, why: 'adds a column or a constraint to a table that already exists' },
  { pattern: /^DROP\b/iu, why: 'drops a column or a constraint, not the table' },
  { pattern: /^ALTER\b/iu, why: 'alters a column of a table that already exists' },
  { pattern: /^RENAME\s+(?:COLUMN\s+)?[^\s]+\s+TO\b/iu, why: 'renames a column, not the table' },
  { pattern: /^RENAME\s+CONSTRAINT\b/iu, why: 'renames a constraint, not the table' },
  { pattern: /^VALIDATE\s+CONSTRAINT\b/iu, why: 'validates a constraint on an existing table' },
  { pattern: /^(?:ENABLE|DISABLE)\b/iu, why: 'toggles a trigger or row-level security' },
  { pattern: /^OWNER\s+TO\b/iu, why: 'changes the owner; the table keeps its name' },
  { pattern: /^CLUSTER\s+ON\b/iu, why: 'sets the clustering index' },
  {
    pattern: /^SET\s+(?:\(|WITHOUT\b|LOGGED\b|UNLOGGED\b|TABLESPACE\b)/iu,
    why: 'sets a storage property',
  },
  { pattern: /^RESET\s*\(/iu, why: 'resets a storage property' },
];

/**
 * Give one migration statement a verdict.
 *
 * @throws naming the statement if it fits none of the four verdicts. That `else` is the whole
 * point: before it existed, this file found `CREATE TABLE` and `DROP TABLE` by scanning the
 * migration text and every other statement contributed nothing in silence, so
 * `ALTER TABLE "skills" RENAME TO "abilities"` — a statement `drizzle-kit` itself emits for a
 * table rename — left the derived set naming `skills` while the deployed database held
 * `abilities`, and the cross-check below passed.
 */
function classifyStatement(statement: string, context: string): StatementVerdict {
  const created = CREATE_TABLE_HEAD.exec(statement);
  if (created?.[1] !== undefined) {
    return {
      kind: 'creates-tables',
      names: tableNamesIn(created[1], `${context}, CREATE TABLE${created[1]}`),
    };
  }
  const dropped = DROP_TABLE_HEAD.exec(statement);
  if (dropped?.[1] !== undefined) {
    return {
      kind: 'drops-tables',
      names: tableNamesIn(dropped[1], `${context}, DROP TABLE${dropped[1]}`),
    };
  }
  const altered = ALTER_TABLE_HEAD.exec(statement);
  if (altered?.[1] !== undefined && altered[2] !== undefined)
    return classifyTableAlteration(altered[1], altered[2].trim(), statement, context);
  if (CREATE_SCHEMA_HEAD.test(statement)) {
    if (CREATE_SCHEMA_WITHOUT_ELEMENTS.test(statement)) {
      return {
        kind: 'leaves-the-table-set-alone',
        why: 'creates a schema and stops at its header, so the statement itself creates no table',
      };
    }
    throw new Error(
      `${context}: \`${excerpt(statement)}\` is a CREATE SCHEMA that does not end at its header, ` +
        'so this gate reads it as carrying a schema-element list. PostgreSQL lets that list ' +
        'contain CREATE TABLE, which would create a table inside a statement this reader does ' +
        'not parse. Write each element as its own statement after the CREATE SCHEMA.',
    );
  }
  if (CREATE_FUNCTION_HEAD.test(statement) || DO_HEAD.test(statement)) {
    assertProceduralBodyLeavesTableSetAlone(statement, context);
    return {
      kind: 'leaves-the-table-set-alone',
      why: 'its complete procedural body contains neither static table-set DDL nor dynamic SQL',
    };
  }
  for (const { pattern, why } of TABLE_SET_NEUTRAL) {
    if (pattern.test(statement)) return { kind: 'leaves-the-table-set-alone', why };
  }
  throw new Error(
    `${context}: \`${excerpt(statement)}\` is a statement this gate cannot classify. It will ` +
      'not assume the statement leaves the set of tables unchanged, because a table this reader ' +
      'cannot see is invisible to the migration cross-check. Either express it as a form this ' +
      'classifier reads, or add it to TABLE_SET_NEUTRAL with the reason it changes no table.',
  );
}
export { classifyStatement };

function classifyTableAlteration(
  subject: string,
  action: string,
  statement: string,
  context: string,
): StatementVerdict {
  const renamed = ALTER_TABLE_RENAME_TO.exec(action);
  if (renamed?.[1] !== undefined) {
    return {
      kind: 'renames-a-table',
      from: tableIdentifier(subject, `${context}, ${excerpt(statement)}`),
      to: tableIdentifier(renamed[1], `${context}, ${excerpt(statement)}`),
    };
  }
  for (const { pattern, why } of ALTER_TABLE_SHAPE_ONLY) {
    if (pattern.test(action)) return { kind: 'leaves-the-table-set-alone', why };
  }
  throw new Error(
    `${context}: \`${excerpt(statement)}\` is an ALTER TABLE whose action this gate cannot ` +
      'place. It will not assume the action leaves the set of tables unchanged; add the action ' +
      'to ALTER_TABLE_SHAPE_ONLY with the reason it cannot create, drop or rename a table.',
  );
}
