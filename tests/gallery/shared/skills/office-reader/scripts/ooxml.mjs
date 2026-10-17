#!/usr/bin/env node
/* global Buffer, process */ // The root ESLint config declares no environment globals.
// Read (and, for test fixtures, write) .xlsx and .docx files with Node alone.
//
// An Office file is a zip of XML parts. This reads the zip's central directory, inflates the parts
// it needs with node:zlib, and pulls cells and paragraphs out of the XML with patterns narrow
// enough for the parts Excel and Word write. It is the script the office-reader skill runs inside
// a run's sandbox: the runtime image has Node, and a skill cannot bring npm packages with it.
//
//   node ooxml.mjs xlsx <file>   → { sheets: [{ name, rows, merges, cells }] }
//   node ooxml.mjs docx <file>   → { paragraphs: [{ style, text }] }
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

// ---------- zip ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The entries of a zip archive, by name, inflated. Supports stored and deflated entries. */
export function readZip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buffer.readUInt16LE(end + 10);
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
    entries.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** A deflated zip archive of `entries` ({ name, data: string | Buffer }), in order. */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
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

function encode(value) {
  return String(value).replace(
    /[&<>"]/gu,
    (char) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[char]};`,
  );
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

/** 26 → 'AA'. */
export function columnLetters(index) {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
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

/**
 * An .xlsx file of `sheets` ({ name, rows, merges? }) with shared strings, as Excel writes them.
 * For fixtures: it writes values and merges, no styles.
 */
export function writeXlsx({ sheets }) {
  const strings = [];
  const stringIndex = new Map();
  const shared = (value) => {
    if (!stringIndex.has(value)) {
      stringIndex.set(value, strings.length);
      strings.push(value);
    }
    return stringIndex.get(value);
  };
  const sheetParts = sheets.map((sheet, index) => {
    const rows = sheet.rows
      .map((row, rowIndex) => {
        const cells = row
          .map((value, column) => {
            if (value === null || value === undefined || value === '') return '';
            const ref = `${columnLetters(column)}${rowIndex + 1}`;
            return typeof value === 'number'
              ? `<c r="${ref}"><v>${value}</v></c>`
              : `<c r="${ref}" t="s"><v>${shared(String(value))}</v></c>`;
          })
          .join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
      })
      .join('');
    const merges = sheet.merges?.length
      ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
      : '';
    return {
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData>${merges}</worksheet>`,
    };
  });
  const ns = 'http://schemas.openxmlformats.org';
  return writeZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${encode(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${ns}/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    },
    ...sheetParts,
    {
      name: 'xl/sharedStrings.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${ns}/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((value) => `<si><t xml:space="preserve">${encode(value)}</t></si>`).join('')}</sst>`,
    },
  ]);
}

// ---------- docx ----------

/** The paragraphs of a .docx file's body, each with its paragraph style (or null) and its text. */
export function readDocx(buffer) {
  const xml = readZip(buffer).get('word/document.xml')?.toString('utf8');
  if (xml === undefined) throw new Error('not a .docx file (no word/document.xml)');
  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/gu)]
    .map((match) => {
      const inner = match[1] ?? '';
      const style = /<w:pStyle\b[^>]*>/u.exec(inner);
      return { style: style ? attribute(style[0], 'w:val') : null, text: textOf(inner, 'w:t') };
    })
    .filter((paragraph) => paragraph.text.trim() !== '');
  return { paragraphs };
}

/** A .docx file of `paragraphs` ({ style?, text }). For fixtures: text and paragraph styles only. */
export function writeDocx({ paragraphs }) {
  const ns = 'http://schemas.openxmlformats.org';
  const body = paragraphs
    .map(({ style, text }) => {
      const properties = style ? `<w:pPr><w:pStyle w:val="${encode(style)}"/></w:pPr>` : '';
      return `<w:p>${properties}<w:r><w:t xml:space="preserve">${encode(text)}</w:t></w:r></w:p>`;
    })
    .join('');
  return writeZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${ns}/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
  ]);
}

// ---------- command line ----------

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [kind, file] = process.argv.slice(2);
  if ((kind !== 'xlsx' && kind !== 'docx') || file === undefined) {
    process.stderr.write('usage: node ooxml.mjs xlsx|docx <file>\n');
    process.exit(2);
  }
  const buffer = readFileSync(file);
  process.stdout.write(
    `${JSON.stringify(kind === 'xlsx' ? readXlsx(buffer) : readDocx(buffer), null, 2)}\n`,
  );
}
