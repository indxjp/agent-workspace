/* global Buffer */ // The root ESLint config declares no environment globals.
// Read .xlsx files with Node alone: a copy of the reading half of the built-in office-reader skill's
// `ooxml.mjs` (zip limits, zip reader, `readXlsx`). The `run_skill_script` tool starts one script of
// one skill, so `consolidate.mjs` cannot take office-reader's JSON from a pipe or reach into another
// skill's directory; it reads the workbooks itself. `excel-consolidation.test.ts` pins this copy to
// the original on every workbook the use case ships, so a change in the original shows up there.
import { inflateRawSync } from 'node:zlib';

// ---------- zip ----------

/**
 * What one file may cost. An Office file comes from outside, and a few kilobytes of zip can inflate
 * to gigabytes, so the archive, the entry count and what every entry inflates to are all capped.
 */
export const OOXML_LIMITS = Object.freeze({
  fileBytes: 50 * 1024 * 1024,
  entries: 2_000,
  entryBytes: 64 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
});

/** Why a file was refused; `code` is the name an agent reports. */
export class OoxmlRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OoxmlRefusal';
    this.code = code;
  }
}

function refuseLargeFile(size) {
  if (size > OOXML_LIMITS.fileBytes)
    throw new OoxmlRefusal(
      'archive_too_large',
      `the file is ${size} bytes; at most ${OOXML_LIMITS.fileBytes} are read`,
    );
}

function inflateEntry(name, data, remaining) {
  const limit = Math.max(1, Math.min(OOXML_LIMITS.entryBytes, remaining));
  try {
    return inflateRawSync(data, { maxOutputLength: limit });
  } catch (error) {
    if (error?.code !== 'ERR_BUFFER_TOO_LARGE') throw error;
    throw limit < OOXML_LIMITS.entryBytes
      ? new OoxmlRefusal(
          'archive_too_large',
          `the archive inflates to more than ${OOXML_LIMITS.totalBytes} bytes`,
        )
      : new OoxmlRefusal(
          'entry_too_large',
          `${name} inflates to more than ${OOXML_LIMITS.entryBytes} bytes`,
        );
  }
}

/**
 * The entries of a zip archive, by name, inflated. Supports stored and deflated entries.
 *
 * @throws {OoxmlRefusal} `archive_too_large`, `too_many_entries`, `entry_too_large` or
 *   `corrupt_archive`.
 */
export function readZip(buffer) {
  refuseLargeFile(buffer.length);
  try {
    return readEntries(buffer);
  } catch (error) {
    if (error instanceof OoxmlRefusal) throw error;
    throw new OoxmlRefusal('corrupt_archive', 'not a zip file (the archive could not be read)');
  }
}

function readEntries(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buffer.readUInt16LE(end + 10);
  if (count > OOXML_LIMITS.entries)
    throw new OoxmlRefusal(
      'too_many_entries',
      `the archive lists ${count} entries; at most ${OOXML_LIMITS.entries} are read`,
    );
  let total = 0;
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`${name}: unsupported compression ${method}`);
    const content =
      method === 0 ? Buffer.from(data) : inflateEntry(name, data, OOXML_LIMITS.totalBytes - total);
    total += content.length;
    if (total > OOXML_LIMITS.totalBytes)
      throw new OoxmlRefusal(
        'archive_too_large',
        `the archive holds more than ${OOXML_LIMITS.totalBytes} bytes`,
      );
    entries.set(name, content);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ---------- xml ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity];
    const code = entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return String.fromCodePoint(code);
  });
}

function attribute(tag, name) {
  const match = new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(tag);
  return match ? decode(match[1]) : null;
}

/** The concatenated text of every <t> (or <w:t>) element inside `xml`. */
function textOf(xml, tag = 't') {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'gu'))]
    .map((match) => decode(match[1]))
    .join('');
}

// ---------- xlsx ----------

/** 'AA' → 26 (0-based). */
export function columnIndex(letters) {
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function splitRef(ref) {
  const match = /^([A-Z]+)(\d+)$/u.exec(ref);
  if (!match) throw new Error(`not a cell reference: ${ref}`);
  return { column: columnIndex(match[1]), row: Number(match[2]) - 1 };
}

/**
 * Every sheet of an .xlsx file: `cells` keyed by reference as written, `merges` as ranges, and
 * `rows`, a dense 2-D array in which each merged range repeats its top-left value — what a person
 * sees on screen, and what folding a multi-row header needs.
 */
export function readXlsx(buffer) {
  const zip = readZip(buffer);
  const part = (name) => zip.get(name)?.toString('utf8') ?? '';
  const shared = [...part('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/gu)].map((match) =>
    textOf(match[1]),
  );
  const targets = new Map(
    [...part('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/gu)].map((match) => [
      attribute(match[0], 'Id'),
      attribute(match[0], 'Target'),
    ]),
  );
  const sheets = [...part('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/gu)].map((match) => {
    const target = targets.get(attribute(match[0], 'r:id')) ?? '';
    const xml = part(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    const cells = {};
    let width = 0;
    let height = 0;
    for (const cell of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const ref = attribute(` ${cell[1]}`, 'r');
      if (ref === null) continue;
      const type = attribute(` ${cell[1]}`, 't');
      const inner = cell[2] ?? '';
      const raw = /<v>([^<]*)<\/v>/u.exec(inner)?.[1];
      let value = null;
      if (type === 's') value = shared[Number(raw)] ?? null;
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'str') value = raw === undefined ? null : decode(raw);
      else if (type === 'b') value = raw === '1';
      else if (raw !== undefined) value = Number(raw);
      if (value === null || value === '') continue;
      cells[ref] = value;
      const { column, row } = splitRef(ref);
      width = Math.max(width, column + 1);
      height = Math.max(height, row + 1);
    }
    const merges = [...xml.matchAll(/<mergeCell\b[^>]*>/gu)].map((merge) =>
      attribute(merge[0], 'ref'),
    );
    const rows = Array.from({ length: height }, () => Array.from({ length: width }, () => null));
    for (const [ref, value] of Object.entries(cells)) {
      const { column, row } = splitRef(ref);
      rows[row][column] = value;
    }
    for (const range of merges) {
      const [from, to] = range.split(':').map(splitRef);
      const value = rows[from.row]?.[from.column] ?? null;
      for (let row = from.row; row <= to.row && row < height; row += 1) {
        for (let column = from.column; column <= to.column && column < width; column += 1)
          rows[row][column] = value;
      }
    }
    return { name: attribute(match[0], 'name'), rows, merges, cells };
  });
  return { sheets };
}
