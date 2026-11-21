// The office-writer model: what a .docx, .pptx or .xlsx is written from, and its validation.
//
// The model comes from an agent, so it is checked where it is read. A run's sandbox has Node and no
// npm packages, so the check is written by hand instead of with zod (ADR-0167 D3). Every issue is
// reported at once, each with the JSON path it is at, so the agent can repair the model in one step.

/** What one model may hold (ADR-0167 D4). Each is refused by name, never truncated. */
export const OFFICE_WRITER_LIMITS = Object.freeze({
  modelBytes: 8 * 1024 * 1024,
  textLength: 32_767,
  blocks: 5_000,
  listItems: 1_000,
  tableRows: 1_000,
  tableColumns: 32,
  slides: 200,
  bullets: 20,
  slideTableRows: 15,
  slideTableColumns: 8,
  sheets: 64,
  sheetColumns: 16_384,
  cells: 1_000_000,
  reportedIssues: 50,
});

export const OFFICE_FORMATS = Object.freeze(['docx', 'pptx', 'xlsx']);

/** Why nothing was written; `code` is the name an agent reports. */
export class OfficeWriterRefusal extends Error {
  constructor(code, message, issues = []) {
    super(message);
    this.name = 'OfficeWriterRefusal';
    this.code = code;
    this.issues = issues;
  }

  /** What the command prints on stderr. */
  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.issues.length > 0 ? { issues: this.issues } : {}),
    };
  }
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const at = (path, key) => (typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`);

/** False for a character XML 1.0 cannot carry: most C0 controls, a lone surrogate, U+FFFE/U+FFFF. */
function xmlSafe(text) {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
    if ((code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) return false;
  }
  return true;
}

/** Collects issues while walking a model. Each check returns whether the value passed. */
class Checker {
  issues = [];

  fail(path, message) {
    this.issues.push({ path, message });
    return false;
  }

  /** An object with exactly the `required` keys and any of the `optional` ones. */
  fields(value, path, required, optional) {
    if (!isRecord(value)) return this.fail(path, 'must be an object');
    const known = new Set([...required, ...optional]);
    let ok = true;
    for (const key of Object.keys(value))
      if (!known.has(key)) ok = this.fail(at(path, key), 'is not a field of this object');
    for (const key of required)
      if (!Object.hasOwn(value, key)) ok = this.fail(at(path, key), 'is required');
    return ok;
  }

  /** A string; empty only when `allowEmpty`. */
  text(value, path, allowEmpty) {
    if (typeof value !== 'string') return this.fail(path, 'must be a string');
    if (!allowEmpty && value.trim() === '') return this.fail(path, 'must not be empty');
    if (value.length > OFFICE_WRITER_LIMITS.textLength)
      return this.fail(path, `is longer than ${OFFICE_WRITER_LIMITS.textLength} characters`);
    if (!xmlSafe(value)) return this.fail(path, 'holds a control character an Office file cannot');
    return true;
  }

  number(value, path) {
    if (typeof value !== 'number' || !Number.isFinite(value))
      return this.fail(path, 'must be a finite number');
    return true;
  }

  /** An array of 1..max items, each checked by `each`; past `max` the items are not walked. */
  list(value, path, max, each) {
    if (!Array.isArray(value)) return this.fail(path, 'must be an array');
    if (value.length === 0) return this.fail(path, 'must not be empty');
    if (value.length > max) return this.fail(path, `holds more than ${max} items`);
    let ok = true;
    value.forEach((item, index) => {
      if (!each(item, at(path, index))) ok = false;
    });
    return ok;
  }

  /** A table cell of a Word or slide table: text (may be empty) or a number. */
  tableCell(value, path) {
    return typeof value === 'number' ? this.number(value, path) : this.text(value, path, true);
  }

  /**
   * `{ header?, rows }` (and the `also` keys), every row as wide as the header, or as the first row
   * when there is none, and at most `columns` wide.
   */
  table(value, path, rows, columns, also) {
    if (!this.fields(value, path, [...also, 'rows'], ['header'])) return false;
    const width = (value.header ?? value.rows?.[0])?.length;
    const sized = (cells, cellsPath, each) =>
      this.list(cells, cellsPath, columns, each) &&
      (cells.length === width ||
        this.fail(cellsPath, `must have ${width} cells, as many as the header or the first row`));
    const header =
      value.header === undefined ||
      sized(value.header, at(path, 'header'), (cell, cellPath) => this.text(cell, cellPath, false));
    const body = this.list(value.rows, at(path, 'rows'), rows, (row, rowPath) =>
      sized(row, rowPath, (cell, cellPath) => this.tableCell(cell, cellPath)),
    );
    return header && body;
  }
}

// ---------- docx ----------

function block(check, value, path) {
  const type = isRecord(value) ? value.type : undefined;
  const { tableRows, tableColumns, listItems } = OFFICE_WRITER_LIMITS;
  switch (type) {
    case 'heading':
      return (
        check.fields(value, path, ['type', 'level', 'text'], []) &&
        ((Number.isInteger(value.level) && value.level >= 1 && value.level <= 6) ||
          check.fail(at(path, 'level'), 'must be an integer from 1 to 6')) &&
        check.text(value.text, at(path, 'text'), false)
      );
    case 'paragraph':
      return (
        check.fields(value, path, ['type', 'text'], []) &&
        check.text(value.text, at(path, 'text'), true)
      );
    case 'list':
      return (
        check.fields(value, path, ['type', 'items'], ['ordered']) &&
        (value.ordered === undefined ||
          typeof value.ordered === 'boolean' ||
          check.fail(at(path, 'ordered'), 'must be true or false')) &&
        check.list(value.items, at(path, 'items'), listItems, (item, itemPath) =>
          check.text(item, itemPath, false),
        )
      );
    case 'table':
      return check.table(value, path, tableRows, tableColumns, ['type']);
    default:
      return check.fail(at(path, 'type'), 'must be "heading", "paragraph", "list" or "table"');
  }
}

function docx(check, model) {
  return (
    check.fields(model, '$', ['format', 'blocks'], ['title']) &&
    (model.title === undefined || check.text(model.title, '$.title', false)) &&
    check.list(model.blocks, '$.blocks', OFFICE_WRITER_LIMITS.blocks, (value, path) =>
      block(check, value, path),
    )
  );
}

// ---------- pptx ----------

function slide(check, value, path) {
  const { bullets, slideTableRows, slideTableColumns } = OFFICE_WRITER_LIMITS;
  return (
    check.fields(value, path, ['title'], ['bullets', 'table']) &&
    check.text(value.title, at(path, 'title'), false) &&
    (value.bullets === undefined ||
      check.list(value.bullets, at(path, 'bullets'), bullets, (item, itemPath) =>
        check.text(item, itemPath, false),
      )) &&
    (value.table === undefined ||
      check.table(value.table, at(path, 'table'), slideTableRows, slideTableColumns, []))
  );
}

function pptx(check, model) {
  return (
    check.fields(model, '$', ['format', 'slides'], []) &&
    check.list(model.slides, '$.slides', OFFICE_WRITER_LIMITS.slides, (value, path) =>
      slide(check, value, path),
    )
  );
}

// ---------- xlsx ----------

/** True for `YYYY-MM-DD` naming a real day from 1900-03-01 (Excel's 1900 leap-year bug ends there). */
function isDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (match === null || text < '1900-03-01') return false;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return day.toISOString().slice(0, 10) === text;
}

function cell(check, value, path) {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return check.number(value, path);
  if (typeof value === 'string') return check.text(value, path, true);
  return (
    check.fields(value, path, ['date'], []) &&
    ((typeof value.date === 'string' && isDate(value.date)) ||
      check.fail(at(path, 'date'), 'must be a day written YYYY-MM-DD, from 1900-03-01'))
  );
}

const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\\t\n\r]/u;

function sheetName(check, value, path, seen) {
  if (!check.text(value, path, false)) return false;
  if (value.length > 31) return check.fail(path, 'is longer than 31 characters');
  if (SHEET_NAME_FORBIDDEN.test(value) || value.startsWith("'") || value.endsWith("'"))
    return check.fail(
      path,
      "must not hold [ ] : * ? / \\, a tab or a line break, or start or end with '",
    );
  const key = value.toLowerCase();
  // Excel keeps "History" for its change-tracking sheet, in any case.
  if (key === 'history') return check.fail(path, 'is a name Excel reserves');
  if (seen.has(key)) return check.fail(path, 'names another sheet too (names ignore case)');
  seen.add(key);
  return true;
}

function xlsx(check, model) {
  const { sheets, sheetColumns, cells } = OFFICE_WRITER_LIMITS;
  const seen = new Set();
  let count = 0;
  const row = (value, path) =>
    check.list(value, path, sheetColumns, (item, itemPath) => {
      count += 1;
      return cell(check, item, itemPath);
    });
  return (
    check.fields(model, '$', ['format', 'sheets'], []) &&
    check.list(model.sheets, '$.sheets', sheets, (value, path) => {
      if (!check.fields(value, path, ['name', 'rows'], ['header'])) return false;
      const name = sheetName(check, value.name, at(path, 'name'), seen);
      const header = value.header === undefined || row(value.header, at(path, 'header'));
      const rows = check.list(value.rows, at(path, 'rows'), cells, row);
      return name && header && rows;
    }) &&
    (count <= cells || check.fail('$.sheets', `holds more than ${cells} cells`))
  );
}

// ---------- the model ----------

const FORMATS = { docx, pptx, xlsx };

/**
 * The model, checked. `format` names the file it is written to.
 *
 * @throws {OfficeWriterRefusal} `invalid_model`, with every issue found (the first
 *   `OFFICE_WRITER_LIMITS.reportedIssues`).
 */
export function parseModel(value) {
  const check = new Checker();
  const format = isRecord(value) ? value.format : undefined;
  if (OFFICE_FORMATS.includes(format)) FORMATS[format](check, value);
  else check.fail('$.format', 'must be "docx", "pptx" or "xlsx"');
  const { issues } = check;
  if (issues.length > 0)
    throw new OfficeWriterRefusal(
      'invalid_model',
      `the model has ${issues.length} issue${issues.length === 1 ? '' : 's'}; the first is ${issues[0].path} ${issues[0].message}`,
      issues.slice(0, OFFICE_WRITER_LIMITS.reportedIssues),
    );
  return value;
}
