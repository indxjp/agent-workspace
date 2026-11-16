import {
  blockCommentEnd,
  quotedTokenEnd,
  dollarQuotedEnd,
} from './tenancy-sql-tokens.test-support.js';

/**
 * A `CREATE TABLE` / `DROP TABLE` statement head and the text up to its column list or the end of
 * the statement. Both are anchored at the start of a STATEMENT (see {@link migrationStatements}),
 * not searched for anywhere in the file, because they are one branch of
 * {@link classifyStatement} rather than a scan that decides which statements participate.
 * The identifier is deliberately NOT matched here: {@link tableNamesIn} classifies what the head
 * names, so a name written in a form this file cannot read is a hard failure rather than a
 * statement that quietly contributes nothing (ADR-0027 decision 3).
 */
const CREATE_TABLE_HEAD =
  /^CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMPORARY|TEMP|UNLOGGED)\s+)?TABLE\b(?:\s+IF\s+NOT\s+EXISTS\b)?([^(;]*)/iu;

const DROP_TABLE_HEAD = /^DROP\s+TABLE\b(?:\s+IF\s+EXISTS\b)?([^(;]*)/iu;

/** The `ALTER TABLE [IF EXISTS] [ONLY] <name>` head, and everything after it: the action. */
const ALTER_TABLE_HEAD =
  /^ALTER\s+TABLE\b(?:\s+IF\s+EXISTS\b)?(?:\s+ONLY\b)?\s+("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*(?:\s*\.\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*))?)\s+([\s\S]+)$/iu;

/** `ALTER TABLE <old> RENAME TO <new>` — the action that renames the table itself. */
const ALTER_TABLE_RENAME_TO = /^RENAME\s+TO\s+([\s\S]+)$/iu;

/** A statement that starts `CREATE SCHEMA`, whatever follows the header. */
const CREATE_SCHEMA_HEAD = /^CREATE\s+SCHEMA\b/iu;

/** Procedural statements whose dollar-quoted bodies must be inspected, not exempted by their head. */
const CREATE_FUNCTION_HEAD = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/iu;

const DO_HEAD = /^DO\b/iu;

/**
 * A `CREATE SCHEMA` whose text ENDS with its header: `[IF NOT EXISTS]`, an optional schema name,
 * an optional `AUTHORIZATION <role>`, and nothing after them.
 *
 * PostgreSQL's `CREATE SCHEMA` takes an optional schema-element list after that header, and
 * `CREATE TABLE` is one of the element forms the list accepts, so
 * `CREATE SCHEMA "s" CREATE TABLE "t" ("c" text)` is ONE statement that creates a table. Reading
 * that list means implementing a second statement grammar with no terminators in it, which this
 * file does not do; {@link classifyStatement} refuses the statement instead, so the element list is
 * a hard failure rather than a table nothing here can see.
 */
const CREATE_SCHEMA_WITHOUT_ELEMENTS =
  /^CREATE\s+SCHEMA\b(?:\s+IF\s+NOT\s+EXISTS\b)?(?:\s+(?!AUTHORIZATION\b)(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*))?(?:\s+AUTHORIZATION\s+(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*))?\s*$/iu;

/** A double-quoted PostgreSQL identifier, which keeps its case verbatim. */
const QUOTED_IDENTIFIER = /^"([^"]+)"$/u;

/** An unquoted PostgreSQL identifier, which the server folds to lower case. */
const UNQUOTED_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/u;

/**
 * The table name a single `CREATE TABLE` / `DROP TABLE` operand names, quoted or not, with an
 * optional schema qualifier.
 *
 * @throws naming the text if it is not one. `CREATE TABLE x AS SELECT …`, a name this reader
 * cannot split, or an operand that is not an identifier at all all land here, and the whole
 * point of the `else` is that they stop the gate instead of shrinking its derived set.
 */
function tableIdentifier(operand: string, context: string): string {
  const trimmed = operand.trim();
  const segments = trimmed.split('.');
  const name = segments[segments.length - 1];
  if (segments.length > 2 || name === undefined) {
    throw new Error(
      `${context}: cannot read \`${trimmed}\` as a table identifier, so the set of tables the ` +
        'migrations create cannot be derived.',
    );
  }
  const quoted = QUOTED_IDENTIFIER.exec(name);
  if (quoted?.[1] !== undefined) return quoted[1];
  if (UNQUOTED_IDENTIFIER.test(name)) return name.toLowerCase();
  throw new Error(
    `${context}: \`${trimmed}\` is neither a quoted nor an unquoted table identifier, so the ` +
      'set of tables the migrations create cannot be derived.',
  );
}

/**
 * Every table one statement head names. `DROP TABLE "a", "b" CASCADE` names two; a `CREATE TABLE`
 * head names one, and this rejects it by the same rule if it does not.
 */
function tableNamesIn(head: string, context: string): string[] {
  // The drop action, when present, applies to the whole operand list rather than to a name.
  const operands = head.replace(/\s+(?:CASCADE|RESTRICT)\s*$/iu, '').split(',');
  return operands.map((operand) => tableIdentifier(operand, context));
}

/** A statement, collapsed and clipped, short enough to name in an error message. */
function excerpt(statement: string): string {
  const collapsed = statement.replace(/\s+/gu, ' ').trim();
  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 117)}…`;
}

/**
 * Every SQL statement one committed migration file contains, comments removed.
 *
 * This is the piece that stops the migration cross-check from being a scan. The set of statements
 * comes from splitting the whole file on its top-level `;`, so EVERY statement in the file reaches
 * {@link classifyStatement} and gets a verdict; nothing is selected in by matching a keyword.
 * Splitting has to understand what a top-level `;` is, so string literals, quoted identifiers,
 * dollar-quoted blocks and both comment forms are consumed as units — and an unterminated one
 * throws rather than swallowing the rest of the file into a single unreadable statement.
 *
 * The trailing text after the last `;` is returned as a statement too: PostgreSQL accepts a final
 * statement without its terminator, and dropping it here would be exactly the silent narrowing
 * this function exists to remove.
 */
function migrationStatements(sqlText: string, context: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;
  const finish = (): void => {
    const trimmed = current.trim();
    if (trimmed !== '') statements.push(trimmed);
    current = '';
  };
  while (index < sqlText.length) {
    const character = sqlText[index] ?? '';
    if (sqlText.startsWith('--', index)) {
      const newline = sqlText.indexOf('\n', index);
      index = newline === -1 ? sqlText.length : newline;
      current += ' ';
      continue;
    }
    if (sqlText.startsWith('/*', index)) {
      index = blockCommentEnd(
        sqlText,
        index,
        `${context}: an unterminated /* block comment; this gate cannot read it.`,
      );
      current += ' ';
      continue;
    }
    if (character === "'" || character === '"') {
      const cursor = quotedTokenEnd(
        sqlText,
        index,
        () =>
          new Error(
            `${context}: an unterminated ${character === "'" ? 'string literal' : 'quoted identifier'} ` +
              'that starts near ' +
              `\`${excerpt(sqlText.slice(index, index + 60))}\`; this gate cannot read it.`,
          ),
      );
      current += sqlText.slice(index, cursor);
      index = cursor;
      continue;
    }
    if (character === '$') {
      const end = dollarQuotedEnd(
        sqlText,
        index,
        (marker) =>
          new Error(
            `${context}: an unterminated ${marker} dollar-quoted block; this gate cannot read it.`,
          ),
      );
      if (end !== null) {
        current += sqlText.slice(index, end);
        index = end;
        continue;
      }
    }
    if (character === ';') {
      finish();
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }
  finish();
  return statements;
}

/**
 * The dollar-quoted executable body of a `CREATE FUNCTION` or `DO` statement.
 *
 * Refusing other forms is deliberate. Treating a procedural statement as table-set-neutral merely
 * because its outer head says FUNCTION/DO lets table DDL hide in the body and defeats the complete
 * migration inventory below.
 */
function proceduralBody(statement: string, context: string): string {
  const markerMatch = CREATE_FUNCTION_HEAD.test(statement)
    ? /\bAS\s+(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/iu.exec(statement)
    : /^DO\b(?:\s+LANGUAGE\s+(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*))?\s+(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/iu.exec(
        statement,
      );
  if (markerMatch === null) {
    throw new Error(
      `${context}: \`${excerpt(statement)}\` has no dollar-quoted procedural body this gate can inspect.`,
    );
  }
  const marker = markerMatch[1];
  if (marker === undefined) {
    throw new Error(`${context}: cannot identify the procedural body's dollar-quote marker.`);
  }
  const bodyStart = markerMatch.index + markerMatch[0].length;
  const bodyEnd = statement.lastIndexOf(marker);
  if (bodyEnd < bodyStart) {
    throw new Error(`${context}: \`${excerpt(statement)}\` has an unterminated ${marker} body.`);
  }
  return statement.slice(bodyStart, bodyEnd);
}

/**
 * Remove comments, literal data, and quoted identifiers while preserving executable keywords.
 * This makes body inspection structural rather than a raw keyword scan: an exception message or
 * comment may mention `CREATE TABLE`, but an executable occurrence remains visible.
 */
function executableBodyText(body: string, context: string): string {
  let executable = '';
  let index = 0;
  while (index < body.length) {
    const character = body[index] ?? '';
    if (body.startsWith('--', index)) {
      const newline = body.indexOf('\n', index);
      index = newline === -1 ? body.length : newline;
      executable += ' ';
      continue;
    }
    if (body.startsWith('/*', index)) {
      index = blockCommentEnd(body, index, `${context}: unterminated comment in procedural body.`);
      executable += ' ';
      continue;
    }
    if (character === "'") {
      index = quotedTokenEnd(
        body,
        index,
        () => new Error(`${context}: unterminated string in procedural body.`),
      );
      executable += ' ';
      continue;
    }
    if (character === '$') {
      const end = dollarQuotedEnd(
        body,
        index,
        (marker) => new Error(`${context}: unterminated ${marker} literal in procedural body.`),
      );
      if (end !== null) {
        executable += ' ';
        index = end;
        continue;
      }
    }
    if (character === '"') {
      index = quotedTokenEnd(
        body,
        index,
        () => new Error(`${context}: unterminated quoted identifier in procedural body.`),
      );
      executable += ' ';
      continue;
    }
    executable += character;
    index += 1;
  }
  return executable;
}

const PROCEDURAL_TABLE_SET_DDL: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    name: 'dynamic SQL (EXECUTE)',
    // Literal contents are intentionally stripped before this check, so trying to interpret one
    // quoted command would still miss format(), concatenation, and a command read from a variable.
    // Reject the execution primitive itself: this static inventory cannot prove what it will run.
    pattern: /\bEXECUTE\b/iu,
  },
  {
    name: 'CREATE TABLE',
    pattern: /\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMPORARY|TEMP|UNLOGGED)\s+)?TABLE\b/iu,
  },
  { name: 'DROP TABLE', pattern: /\bDROP\s+TABLE\b/iu },
  {
    name: 'ALTER TABLE RENAME TO',
    pattern: /\bALTER\s+TABLE\b[^;]*?\bRENAME\s+TO\b/iu,
  },
];

function assertProceduralBodyLeavesTableSetAlone(statement: string, context: string): void {
  const executable = executableBodyText(proceduralBody(statement, context), context);
  for (const ddl of PROCEDURAL_TABLE_SET_DDL) {
    if (ddl.pattern.test(executable)) {
      throw new Error(
        `${context}: \`${excerpt(statement)}\` contains executable ${ddl.name} inside its ` +
          'procedural body, so it cannot be classified as table-set-neutral.',
      );
    }
  }
}
export {
  migrationStatements,
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
};
