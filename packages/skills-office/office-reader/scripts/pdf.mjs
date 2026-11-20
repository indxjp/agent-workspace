#!/usr/bin/env node
/* global Buffer, process */ // The root ESLint config declares no environment globals.
// Read the text of a PDF with Node alone.
//
// It scans the file for `N G obj` bodies (so a damaged or missing cross-reference table does not
// matter), unpacks `/ObjStm` object streams, walks the page tree, and runs each page's content
// stream for the text operators, mapping character codes through `/ToUnicode` CMaps (what makes
// Japanese Identity-H fonts readable). It is the script the office-reader skill runs inside a
// run's sandbox, where Node is all there is.
//
//   node pdf.mjs <file>   → { pages: [{ number, text, unreadable? }] }
//
// A page with no text is `""` (an image-only scan: there is no OCR). `unreadable: true` marks a
// page that has text this script cannot decode (a filter other than Flate, or a composite font with
// no ToUnicode map). A password-protected file is refused, with no text, as `encrypted_pdf`. A file
// that is too big to read safely is refused as `file_too_large`, `too_many_objects`,
// `too_many_pages`, `page_tree_too_deep`, `stream_too_large` or `inflated_too_large` (see
// PDF_LIMITS).
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { constants, inflateSync } from 'node:zlib';

/** Why a file was refused; `code` is the name an agent reports. */
export class PdfRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PdfRefusal';
    this.code = code;
  }
}

/**
 * What one file may cost. A PDF comes from outside, and a few kilobytes of Flate can inflate to
 * gigabytes, so the file, the object and page counts, and what streams inflate to are all capped.
 */
export const PDF_LIMITS = Object.freeze({
  fileBytes: 50 * 1024 * 1024,
  objects: 100_000,
  pages: 2_000,
  pageTreeDepth: 64,
  streamBytes: 64 * 1024 * 1024,
  inflatedBytes: 256 * 1024 * 1024,
});

/** A feature this reader does not implement; the page that needs it is reported unreadable. */
class Unsupported extends Error {}

// ---------- objects ----------

const SPACE = /[\0\t\n\f\r ]/u;

function skipSpace(s, start) {
  let i = start;
  while (i < s.length) {
    if (SPACE.test(s[i] ?? '')) i += 1;
    else if (s[i] === '%') while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i += 1;
    else break;
  }
  return i;
}

const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

/** The text a backslash escape stands for, and the index of the last character it consumed. */
function readEscape(s, at) {
  const next = s[at] ?? '';
  const octal = /^[0-7]{1,3}/u.exec(s.slice(at, at + 3));
  if (octal) return [String.fromCharCode(parseInt(octal[0], 8) & 0xff), at + octal[0].length - 1];
  if (next === '\r') return ['', s[at + 1] === '\n' ? at + 1 : at];
  if (next === '\n') return ['', at];
  return [ESCAPES[next] ?? next, at];
}

function literalString(s, start) {
  let depth = 0;
  let out = '';
  for (let i = start; i < s.length; i += 1) {
    const c = s[i] ?? '';
    if (c === '\\') {
      const [text, last] = readEscape(s, i + 1);
      out += text;
      i = last;
    } else if (c === '(') {
      depth += 1;
      if (depth > 1) out += c;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return [{ string: out }, i + 1];
      out += c;
    } else out += c;
  }
  throw new Error('unterminated string');
}

function hexString(s, start) {
  const end = s.indexOf('>', start);
  if (end < 0) throw new Error('unterminated hex string');
  let hex = s.slice(start + 1, end).replace(/\s/gu, '');
  if (hex.length % 2 === 1) hex += '0';
  return [{ string: Buffer.from(hex, 'hex').toString('latin1') }, end + 1];
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)/uy;
const REFERENCE = /\s+(\d+)\s+R(?![\w])/uy;
const KEYWORD = /[^\s()<>[\]{}/%]+/uy;

function parseDictionary(s, start) {
  const dict = Object.create(null);
  let at = skipSpace(s, start);
  while (!(s[at] === '>' && s[at + 1] === '>')) {
    if (s[at] !== '/') throw new Error('dictionary key is not a name');
    const [key, afterKey] = parseValue(s, at);
    const [value, afterValue] = parseValue(s, afterKey);
    dict[key.slice(1)] = value;
    at = skipSpace(s, afterValue);
  }
  return [dict, at + 2];
}

function parseArray(s, start) {
  const items = [];
  let at = skipSpace(s, start);
  while (s[at] !== ']') {
    const [item, after] = parseValue(s, at);
    items.push(item);
    at = skipSpace(s, after);
  }
  return [items, at + 1];
}

function parseName(s, start) {
  KEYWORD.lastIndex = start + 1;
  const name = KEYWORD.exec(s)?.[0] ?? '';
  const decoded = name.replace(/#([0-9a-f]{2})/giu, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return [`/${decoded}`, start + 1 + name.length];
}

/** A number, or an `N G R` reference when a generation number and R follow an integer. */
function parseNumberOrReference(s, start, number) {
  const after = start + number.length;
  if (/^\d+$/u.test(number)) {
    REFERENCE.lastIndex = after;
    const ref = REFERENCE.exec(s);
    if (ref) return [{ ref: Number(number) }, after + ref[0].length];
  }
  return [Number(number), after];
}

const KEYWORD_VALUES = new Map([
  ['true', true],
  ['false', false],
  ['null', null],
]);

function parseKeyword(s, start, c) {
  KEYWORD.lastIndex = start;
  const word = KEYWORD.exec(s)?.[0];
  if (word !== undefined && KEYWORD_VALUES.has(word))
    return [KEYWORD_VALUES.get(word), start + word.length];
  throw new Error(`unexpected ${JSON.stringify(word ?? c)}`);
}

/**
 * One PDF object starting at `start`: a number, `/Name` (kept with its slash), `{ string }`,
 * `{ ref }`, an array, a dictionary (no prototype) or a boolean or null.
 */
function parseValue(s, start) {
  const i = skipSpace(s, start);
  const c = s[i] ?? '';
  if (c === '<' && s[i + 1] === '<') return parseDictionary(s, i + 2);
  if (c === '[') return parseArray(s, i + 1);
  if (c === '(') return literalString(s, i);
  if (c === '<') return hexString(s, i);
  if (c === '/') return parseName(s, i);
  NUMBER.lastIndex = i;
  const number = NUMBER.exec(s);
  if (number) return parseNumberOrReference(s, i, number[0]);
  return parseKeyword(s, i, c);
}

const isDict = (value) =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !('ref' in value) &&
  !('string' in value);

class Document {
  constructor(buffer, limits) {
    this.limits = limits;
    this.objects = new Map();
    this.inflated = 0;
    const s = buffer.toString('latin1');
    const objectHeader = /(\d+)\s+(\d+)\s+obj\b/gu;
    for (let match = objectHeader.exec(s); match; match = objectHeader.exec(s)) {
      let value;
      let at;
      try {
        [value, at] = parseValue(s, objectHeader.lastIndex);
      } catch {
        continue;
      }
      const object = { value, stream: null };
      at = skipSpace(s, at);
      if (isDict(value) && s.startsWith('stream', at)) {
        let begin = at + 6;
        if (s[begin] === '\r') begin += 1;
        if (s[begin] === '\n') begin += 1;
        const end = s.indexOf('endstream', begin);
        if (end >= 0) {
          object.stream = buffer.subarray(begin, end);
          objectHeader.lastIndex = end;
        }
      }
      this.add(Number(match[1]), object);
    }
    this.refuseEncrypted(s);
    this.unpackObjectStreams();
  }

  add(number, object) {
    this.objects.set(number, object);
    if (this.objects.size > PDF_LIMITS.objects)
      throw new PdfRefusal(
        'too_many_objects',
        `the PDF holds more than ${PDF_LIMITS.objects} objects; it is not read`,
      );
  }

  // The `/Encrypt` entry sits in a classic trailer or, with cross-reference streams, in the dictionary
  // of the `/XRef` stream. It is checked before any stream is read.
  refuseEncrypted(s) {
    const dictionaries = [...this.objects.values()]
      .map((object) => object.value)
      .filter((value) => isDict(value) && value.Type === '/XRef');
    for (const trailer of s.matchAll(/trailer\s*/gu)) {
      try {
        dictionaries.push(parseValue(s, trailer.index + trailer[0].length)[0]);
      } catch {
        // A trailer this reader cannot parse is not evidence of encryption.
      }
    }
    if (dictionaries.some((dict) => isDict(dict) && (dict.Encrypt ?? null) !== null))
      throw new PdfRefusal('encrypted_pdf', 'the PDF is password-protected; it cannot be read');
  }

  unpackObjectStreams() {
    for (const object of [...this.objects.values()]) {
      const isObjectStream =
        isDict(object.value) && object.value.Type === '/ObjStm' && object.stream !== null;
      if (!isObjectStream) continue;
      try {
        this.unpackObjectStream(object);
      } catch (error) {
        if (error instanceof PdfRefusal) throw error;
        // An object stream that cannot be opened leaves its objects missing; the pages that
        // needed them come out unreadable.
      }
    }
  }

  unpackObjectStream(object) {
    const text = this.streamData(object).toString('latin1');
    const first = Number(this.deref(object.value.First));
    const header = text.slice(0, first).trim().split(/\s+/u).map(Number);
    const count = Math.min(Number(this.deref(object.value.N)), header.length / 2);
    for (let index = 0; index < count; index += 1) {
      const number = header[index * 2];
      const offset = header[index * 2 + 1];
      if (number === undefined || offset === undefined || this.objects.has(number)) continue;
      this.add(number, { value: parseValue(text, first + offset)[0], stream: null });
    }
  }

  deref(value) {
    let current = value;
    for (let hops = 0; hops < 32 && current && typeof current === 'object' && 'ref' in current;) {
      current = this.objects.get(current.ref)?.value;
      hops += 1;
    }
    return current;
  }

  /** The object a value refers to, with its raw stream, or null. */
  objectOf(value) {
    return value && typeof value === 'object' && 'ref' in value
      ? (this.objects.get(value.ref) ?? null)
      : null;
  }

  inflate(data) {
    const limit = Math.max(
      1,
      Math.min(this.limits.streamBytes, this.limits.inflatedBytes - this.inflated),
    );
    let out;
    try {
      out = inflateSync(data, { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: limit });
    } catch (error) {
      if (error?.code !== 'ERR_BUFFER_TOO_LARGE') throw error;
      throw limit < this.limits.streamBytes
        ? new PdfRefusal(
            'inflated_too_large',
            `the streams inflate to more than ${this.limits.inflatedBytes} bytes in all`,
          )
        : new PdfRefusal(
            'stream_too_large',
            `a stream inflates to more than ${this.limits.streamBytes} bytes`,
          );
    }
    this.inflated += out.length;
    return out;
  }

  streamData(object) {
    const filter = this.deref(object.value.Filter);
    const filters = Array.isArray(filter) ? filter.map((f) => this.deref(f)) : [filter];
    let data = object.stream;
    for (const name of filters) {
      if (name === undefined || name === null) continue;
      if (name !== '/FlateDecode' && name !== '/Fl') throw new Unsupported(`filter ${name}`);
      data = this.inflate(data);
    }
    const parameters = this.deref(object.value.DecodeParms);
    if (isDict(parameters) && Number(this.deref(parameters.Predictor) ?? 1) > 1)
      throw new Unsupported('predictor');
    return data;
  }

  pages() {
    const catalog = [...this.objects.values()].find(
      (object) => isDict(object.value) && object.value.Type === '/Catalog',
    );
    const found = [];
    const addPage = (page) => {
      if (found.length >= PDF_LIMITS.pages)
        throw new PdfRefusal(
          'too_many_pages',
          `the PDF has more than ${PDF_LIMITS.pages} pages; it is not read`,
        );
      found.push(page);
    };
    if (catalog) this.walkPageTree(catalog.value.Pages, addPage);
    else
      for (const object of this.objects.values())
        if (isDict(object.value) && object.value.Type === '/Page')
          addPage({ dict: object.value, resources: object.value.Resources });
    return found;
  }

  walkPageTree(root, addPage) {
    const seen = new Set();
    const walk = (node, inherited, depth) => {
      const dict = this.deref(node);
      if (!isDict(dict) || seen.has(dict)) return;
      if (depth > PDF_LIMITS.pageTreeDepth)
        throw new PdfRefusal(
          'page_tree_too_deep',
          `the PDF page tree is nested more than ${PDF_LIMITS.pageTreeDepth} levels; it is not read`,
        );
      seen.add(dict);
      const resources = dict.Resources ?? inherited;
      const kids = this.deref(dict.Kids);
      if (Array.isArray(kids)) for (const kid of kids) walk(kid, resources, depth + 1);
      else addPage({ dict, resources });
    };
    walk(root, undefined, 0);
  }
}

// ---------- fonts ----------

const utf16 = (hex) =>
  hex.length <= 2
    ? String.fromCharCode(parseInt(hex, 16))
    : (hex.match(/.{1,4}/gu) ?? []).map((unit) => String.fromCharCode(parseInt(unit, 16))).join('');

const HEX = '[0-9A-Fa-f]';

function addCharMappings(map, text) {
  const pair = new RegExp(`<(${HEX}+)>\\s*<(${HEX}*)>`, 'gu');
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/gu))
    for (const entry of (block[1] ?? '').matchAll(pair))
      map.set(parseInt(entry[1] ?? '', 16), utf16(entry[2] ?? ''));
}

/** The texts a `bfrange` target gives its codes: an array of texts, or a base text counted up. */
function rangeTarget(target) {
  if (target.startsWith('[')) {
    const list = [...target.matchAll(new RegExp(`<(${HEX}*)>`, 'gu'))].map((one) =>
      utf16(one[1] ?? ''),
    );
    return (offset) => list[offset] ?? '';
  }
  const base = utf16(target.slice(1, -1));
  const stem = base.slice(0, -1);
  const lastCode = base.charCodeAt(base.length - 1);
  return (offset) => stem + String.fromCharCode(lastCode + offset);
}

function addRangeMappings(map, text) {
  const range = new RegExp(`<(${HEX}+)>\\s*<(${HEX}+)>\\s*(<${HEX}*>|\\[[^\\]]*\\])`, 'gu');
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/gu)) {
    for (const entry of (block[1] ?? '').matchAll(range)) {
      const low = parseInt(entry[1] ?? '', 16);
      const high = Math.min(parseInt(entry[2] ?? '', 16), low + 0xffff);
      const textAt = rangeTarget(entry[3] ?? '');
      for (let code = low; code <= high; code += 1) map.set(code, textAt(code - low));
    }
  }
}

/** The code → text map of a ToUnicode CMap, and the byte width of its codes (0 if not stated). */
function parseCMap(text) {
  const map = new Map();
  const space = new RegExp(`begincodespacerange\\s*<(${HEX}+)>`, 'u').exec(text);
  const width = space ? (space[1] ?? '').length / 2 : 0;
  addCharMappings(map, text);
  addRangeMappings(map, text);
  return { map, width };
}

// ---------- text ----------

function pageContent(document, page) {
  const contents = document.deref(page.dict.Contents);
  const parts = Array.isArray(contents) ? contents : [page.dict.Contents];
  return parts
    .map((part) => document.objectOf(part))
    .filter((object) => object !== null && object.stream !== null)
    .map((object) => document.streamData(object).toString('latin1'))
    .join('\n');
}

const MAX_FORM_DEPTH = 8;

const OPERAND_START = /[-+.\d/(<[]/u;

const showString = (reader, state, value) => {
  if (value?.string !== undefined) reader.show(state.font, value.string);
};

/** What each text operator does to the reader and the running state of one content stream. */
const TEXT_OPERATORS = new Map([
  [
    'BT',
    (reader, state) => {
      reader.parts.push('\n');
      state.lastTm = null;
    },
  ],
  [
    'Tf',
    (reader, state) => {
      const [name] = state.operands;
      state.font = typeof name === 'string' ? reader.font(state.resources, name) : null;
    },
  ],
  ['Tj', (reader, state) => showString(reader, state, state.operands[0])],
  [
    'TJ',
    (reader, state) => {
      const [items] = state.operands;
      for (const item of Array.isArray(items) ? items : []) {
        if (item?.string !== undefined) showString(reader, state, item);
        else if (typeof item === 'number' && item < -200) reader.parts.push(' ');
      }
    },
  ],
  [
    "'",
    (reader, state, operator) => {
      reader.parts.push('\n');
      showString(reader, state, state.operands[operator === '"' ? 2 : 0]);
    },
  ],
  [
    'Td',
    (reader, state) => {
      const [x, y] = state.operands;
      if (Number(y) !== 0) reader.parts.push('\n');
      else if (Number(x) !== 0) reader.parts.push(' ');
    },
  ],
  ['T*', (reader) => reader.parts.push('\n')],
  [
    'Tm',
    (reader, state) => {
      const [, , , , x, y] = state.operands;
      const { lastTm } = state;
      if (lastTm !== null) reader.parts.push(y === lastTm.y ? (x === lastTm.x ? '' : ' ') : '\n');
      state.lastTm = { x, y };
    },
  ],
  [
    'Do',
    (reader, state) => {
      const [name] = state.operands;
      if (typeof name === 'string' && state.depth < MAX_FORM_DEPTH)
        reader.form(state.resources, name, state.depth);
    },
  ],
  [
    'BI',
    (_reader, state) => {
      const end = state.content.slice(state.at).search(/\sEI(?=\s|$)/u);
      state.at = end < 0 ? state.content.length : state.at + end + 3;
    },
  ],
]);
TEXT_OPERATORS.set('"', TEXT_OPERATORS.get("'"));
TEXT_OPERATORS.set('TD', TEXT_OPERATORS.get('Td'));

class TextReader {
  constructor(document) {
    this.document = document;
    this.fonts = new Map();
    this.parts = [];
    this.unreadable = false;
  }

  font(resources, name) {
    const { document } = this;
    const fonts = document.deref(document.deref(resources)?.Font);
    const reference = isDict(fonts) ? fonts[name.slice(1)] : undefined;
    const dict = document.deref(reference);
    if (!isDict(dict)) return null;
    let font = this.fonts.get(dict);
    if (font === undefined) {
      const composite = document.deref(dict.Subtype) === '/Type0';
      font = { composite, cmap: this.toUnicodeMap(dict) };
      this.fonts.set(dict, font);
    }
    return font;
  }

  toUnicodeMap(fontDict) {
    const { document } = this;
    const toUnicode = document.objectOf(fontDict.ToUnicode);
    if (!toUnicode?.stream) return null;
    try {
      return parseCMap(document.streamData(toUnicode).toString('latin1'));
    } catch (error) {
      if (error instanceof PdfRefusal) throw error;
      return null;
    }
  }

  show(font, string) {
    if (font?.cmap) {
      const width = font.cmap.width || (font.composite ? 2 : 1);
      for (let at = 0; at < string.length; at += width) {
        let code = 0;
        for (let byte = 0; byte < width; byte += 1)
          code = code * 256 + (string.charCodeAt(at + byte) || 0);
        this.parts.push(font.cmap.map.get(code) ?? '');
      }
    } else if (font?.composite) {
      this.unreadable = true;
    } else this.parts.push(string);
  }

  run(content, resources, depth) {
    const state = { content, resources, depth, at: 0, operands: [], font: null, lastTm: null };
    while (true) {
      state.at = skipSpace(content, state.at);
      if (state.at >= content.length) break;
      if (OPERAND_START.test(content[state.at] ?? '')) {
        const [value, next] = parseValue(content, state.at);
        state.operands.push(value);
        state.at = next;
        continue;
      }
      KEYWORD.lastIndex = state.at;
      const operator = KEYWORD.exec(content)?.[0];
      if (operator === undefined) {
        state.at += 1;
        continue;
      }
      state.at += operator.length;
      TEXT_OPERATORS.get(operator)?.(this, state, operator);
      state.operands = [];
    }
  }

  form(resources, name, depth) {
    const { document } = this;
    const xobjects = document.deref(document.deref(resources)?.XObject);
    const object = isDict(xobjects) ? document.objectOf(xobjects[name.slice(1)]) : null;
    if (
      !object?.stream ||
      !isDict(object.value) ||
      document.deref(object.value.Subtype) !== '/Form'
    )
      return;
    this.run(
      document.streamData(object).toString('latin1'),
      object.value.Resources ?? resources,
      depth + 1,
    );
  }
}

function tidy(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

function refuseLargeFile(size) {
  if (size > PDF_LIMITS.fileBytes)
    throw new PdfRefusal(
      'file_too_large',
      `the file is ${size} bytes; at most ${PDF_LIMITS.fileBytes} are read`,
    );
}

/**
 * The text of every page of a PDF, in page order.
 *
 * @param {Buffer} buffer
 * @param {{ streamBytes: number, inflatedBytes: number }} [limits] the inflate caps; tests pass small ones
 * @returns {{ pages: { number: number, text: string, unreadable?: true }[] }}
 * @throws {PdfRefusal} `not_a_pdf`, `encrypted_pdf`, `corrupt_pdf`, or a size limit: `file_too_large`,
 *   `too_many_objects`, `too_many_pages`, `page_tree_too_deep`, `stream_too_large` or
 *   `inflated_too_large`.
 */
export function readPdf(buffer, limits = PDF_LIMITS) {
  refuseLargeFile(buffer.length);
  if (!buffer.subarray(0, 1024).toString('latin1').includes('%PDF-'))
    throw new PdfRefusal('not_a_pdf', 'the file does not start with %PDF-');
  let document;
  try {
    document = new Document(buffer, limits);
  } catch (error) {
    if (error instanceof PdfRefusal) throw error;
    throw new PdfRefusal('corrupt_pdf', 'the PDF structure could not be read');
  }
  const found = document.pages();
  if (found.length === 0) throw new PdfRefusal('corrupt_pdf', 'the PDF has no readable page tree');
  const pages = found.map((page, index) => {
    const reader = new TextReader(document);
    try {
      reader.run(pageContent(document, page), page.resources, 0);
    } catch (error) {
      if (error instanceof PdfRefusal) throw error;
      reader.unreadable = true;
    }
    const text = tidy(reader.parts.join(''));
    return { number: index + 1, text, ...(reader.unreadable ? { unreadable: true } : {}) };
  });
  return { pages };
}

// ---------- command line ----------

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  if (file === undefined || process.argv.length !== 3) {
    process.stderr.write('usage: node pdf.mjs <file>\n');
    process.exit(2);
  }
  try {
    refuseLargeFile(statSync(file).size);
    process.stdout.write(`${JSON.stringify(readPdf(readFileSync(file)), null, 2)}\n`);
  } catch (error) {
    if (!(error instanceof PdfRefusal)) throw error;
    process.stderr.write(`${JSON.stringify({ error: error.code, message: error.message })}\n`);
    process.exit(1);
  }
}
