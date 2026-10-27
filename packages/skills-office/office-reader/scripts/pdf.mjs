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

function literalString(s, start) {
  let depth = 0;
  let out = '';
  let i = start;
  for (; i < s.length; i += 1) {
    const c = s[i] ?? '';
    if (c === '\\') {
      i += 1;
      const next = s[i] ?? '';
      const octal = /^[0-7]{1,3}/u.exec(s.slice(i, i + 3));
      if (octal) {
        out += String.fromCharCode(parseInt(octal[0], 8) & 0xff);
        i += octal[0].length - 1;
      } else if (next === '\r') {
        if (s[i + 1] === '\n') i += 1;
      } else if (next !== '\n') out += ESCAPES[next] ?? next;
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

/**
 * One PDF object starting at `start`: a number, `/Name` (kept with its slash), `{ string }`,
 * `{ ref }`, an array, a dictionary (no prototype) or a boolean or null.
 */
function parseValue(s, start) {
  const i = skipSpace(s, start);
  const c = s[i] ?? '';
  if (c === '<' && s[i + 1] === '<') {
    const dict = Object.create(null);
    let at = skipSpace(s, i + 2);
    while (!(s[at] === '>' && s[at + 1] === '>')) {
      if (s[at] !== '/') throw new Error('dictionary key is not a name');
      const [key, afterKey] = parseValue(s, at);
      const [value, afterValue] = parseValue(s, afterKey);
      dict[key.slice(1)] = value;
      at = skipSpace(s, afterValue);
    }
    return [dict, at + 2];
  }
  if (c === '[') {
    const items = [];
    let at = skipSpace(s, i + 1);
    while (s[at] !== ']') {
      const [item, after] = parseValue(s, at);
      items.push(item);
      at = skipSpace(s, after);
    }
    return [items, at + 1];
  }
  if (c === '(') return literalString(s, i);
  if (c === '<') return hexString(s, i);
  if (c === '/') {
    KEYWORD.lastIndex = i + 1;
    const name = KEYWORD.exec(s)?.[0] ?? '';
    const decoded = name.replace(/#([0-9a-f]{2})/giu, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    return [`/${decoded}`, i + 1 + name.length];
  }
  NUMBER.lastIndex = i;
  const number = NUMBER.exec(s);
  if (number) {
    const after = i + number[0].length;
    if (/^\d+$/u.test(number[0])) {
      REFERENCE.lastIndex = after;
      const ref = REFERENCE.exec(s);
      // `12 0 R` is a reference only when a generation number and R follow the object number.
      if (ref) return [{ ref: Number(number[0]) }, after + ref[0].length];
    }
    return [Number(number[0]), after];
  }
  KEYWORD.lastIndex = i;
  const word = KEYWORD.exec(s)?.[0];
  if (word === 'true') return [true, i + 4];
  if (word === 'false') return [false, i + 5];
  if (word === 'null') return [null, i + 4];
  throw new Error(`unexpected ${JSON.stringify(word ?? c)}`);
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
      if (!isDict(object.value) || object.value.Type !== '/ObjStm' || object.stream === null)
        continue;
      try {
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
      } catch (error) {
        if (error instanceof PdfRefusal) throw error;
        // An object stream that cannot be opened leaves its objects missing; the pages that
        // needed them come out unreadable.
      }
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
      else {
        if (found.length >= PDF_LIMITS.pages)
          throw new PdfRefusal(
            'too_many_pages',
            `the PDF has more than ${PDF_LIMITS.pages} pages; it is not read`,
          );
        found.push({ dict, resources });
      }
    };
    if (catalog) walk(catalog.value.Pages, undefined, 0);
    else
      for (const object of this.objects.values())
        if (isDict(object.value) && object.value.Type === '/Page') {
          if (found.length >= PDF_LIMITS.pages)
            throw new PdfRefusal(
              'too_many_pages',
              `the PDF has more than ${PDF_LIMITS.pages} pages; it is not read`,
            );
          found.push({ dict: object.value, resources: object.value.Resources });
        }
    return found;
  }
}

// ---------- fonts ----------

const utf16 = (hex) =>
  hex.length <= 2
    ? String.fromCharCode(parseInt(hex, 16))
    : (hex.match(/.{1,4}/gu) ?? []).map((unit) => String.fromCharCode(parseInt(unit, 16))).join('');

const HEX = '[0-9A-Fa-f]';

/** The code → text map of a ToUnicode CMap, and the byte width of its codes (0 if not stated). */
function parseCMap(text) {
  const map = new Map();
  const space = new RegExp(`begincodespacerange\\s*<(${HEX}+)>`, 'u').exec(text);
  const width = space ? (space[1] ?? '').length / 2 : 0;
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/gu))
    for (const pair of (block[1] ?? '').matchAll(new RegExp(`<(${HEX}+)>\\s*<(${HEX}*)>`, 'gu')))
      map.set(parseInt(pair[1] ?? '', 16), utf16(pair[2] ?? ''));
  const range = new RegExp(`<(${HEX}+)>\\s*<(${HEX}+)>\\s*(<${HEX}*>|\\[[^\\]]*\\])`, 'gu');
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/gu)) {
    for (const entry of (block[1] ?? '').matchAll(range)) {
      const low = parseInt(entry[1] ?? '', 16);
      const high = Math.min(parseInt(entry[2] ?? '', 16), low + 0xffff);
      const target = entry[3] ?? '';
      const list = target.startsWith('[')
        ? [...target.matchAll(new RegExp(`<(${HEX}*)>`, 'gu'))].map((one) => utf16(one[1] ?? ''))
        : null;
      const base = list ? '' : utf16(target.slice(1, -1));
      for (let code = low; code <= high; code += 1) {
        const text16 = list
          ? (list[code - low] ?? '')
          : base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + code - low);
        map.set(code, text16);
      }
    }
  }
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
      const toUnicode = document.objectOf(dict.ToUnicode);
      let cmap = null;
      if (toUnicode?.stream) {
        try {
          cmap = parseCMap(document.streamData(toUnicode).toString('latin1'));
        } catch (error) {
          if (error instanceof PdfRefusal) throw error;
          cmap = null;
        }
      }
      font = { composite, cmap };
      this.fonts.set(dict, font);
    }
    return font;
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
    let font = null;
    let operands = [];
    let lastTm = null;
    let at = 0;
    while (true) {
      at = skipSpace(content, at);
      if (at >= content.length) break;
      if (/[-+.\d/(<[]/u.test(content[at] ?? '')) {
        const [value, next] = parseValue(content, at);
        operands.push(value);
        at = next;
        continue;
      }
      KEYWORD.lastIndex = at;
      const operator = KEYWORD.exec(content)?.[0];
      if (operator === undefined) {
        at += 1;
        continue;
      }
      at += operator.length;
      const [first, second, , , tmX, tmY] = operands;
      switch (operator) {
        case 'BT':
          this.parts.push('\n');
          lastTm = null;
          break;
        case 'Tf':
          font = typeof first === 'string' ? this.font(resources, first) : null;
          break;
        case 'Tj':
          if (first?.string !== undefined) this.show(font, first.string);
          break;
        case 'TJ':
          for (const item of Array.isArray(first) ? first : []) {
            if (item?.string !== undefined) this.show(font, item.string);
            else if (typeof item === 'number' && item < -200) this.parts.push(' ');
          }
          break;
        case "'":
        case '"': {
          this.parts.push('\n');
          const shown = operator === '"' ? operands[2] : first;
          if (shown?.string !== undefined) this.show(font, shown.string);
          break;
        }
        case 'Td':
        case 'TD':
          if (Number(second) !== 0) this.parts.push('\n');
          else if (Number(first) !== 0) this.parts.push(' ');
          break;
        case 'T*':
          this.parts.push('\n');
          break;
        case 'Tm':
          if (lastTm !== null)
            this.parts.push(tmY === lastTm.y ? (tmX === lastTm.x ? '' : ' ') : '\n');
          lastTm = { x: tmX, y: tmY };
          break;
        case 'Do':
          if (typeof first === 'string' && depth < 8) this.form(resources, first, depth);
          break;
        case 'BI': {
          const end = content.slice(at).search(/\sEI(?=\s|$)/u);
          at = end < 0 ? content.length : at + end + 3;
          break;
        }
        default:
          break;
      }
      operands = [];
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
