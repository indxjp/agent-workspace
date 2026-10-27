#!/usr/bin/env node
/* global process, TextDecoder */ // The root ESLint config declares no environment globals.
// Read the text of an ASCII DXF drawing with Node alone.
//
//   node dxf.mjs <file> [out.json]   → { version, codepage, layers, blocks, counts, texts, inserts, lines, circles }
//
// With `out.json` the same JSON is written to that file (its folder is created) and only
// `{ "written": "<out.json>" }` is printed, so a large drawing need not pass through the model.
//
// `texts` holds the words on the drawing: TEXT, MTEXT (formatting codes removed), ATTRIB and
// ATTDEF values, and the text and measurement of DIMENSION entities. Geometry is summarised as
// `counts` of each entity type, plus the coordinates of the two primitives a part drawing is made
// of: `lines` (LINE) and `circles` (CIRCLE). Every other shape is only counted. A binary DXF, a
// code page this reader does not know, and a file that is not a DXF are refused by name.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A drawing is read whole and split into lines, so a file past this is refused by name. */
export const DXF_MAX_FILE_BYTES = 32 * 1024 * 1024;

function refuseLargeFile(size) {
  if (size > DXF_MAX_FILE_BYTES)
    throw new DxfRefusal(
      'file_too_large',
      `the file is ${size} bytes; at most ${DXF_MAX_FILE_BYTES} are read`,
    );
}

/** Why a file was refused; `code` is the name an agent reports. */
export class DxfRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DxfRefusal';
    this.code = code;
  }
}

function pairsOf(text) {
  const lines = text.split(/\r?\n/u);
  const pairs = [];
  for (let at = 0; at + 1 < lines.length; at += 2) {
    const code = Number((lines[at] ?? '').trim());
    if (!Number.isInteger(code)) throw new DxfRefusal('not_a_dxf', 'the file is not an ASCII DXF');
    pairs.push([code, lines[at + 1] ?? '']);
  }
  return pairs;
}

function headerVariable(pairs, name) {
  const at = pairs.findIndex(([code, value]) => code === 9 && value.trim() === name);
  return at < 0 ? undefined : pairs[at + 1]?.[1]?.trim();
}

/** The TextDecoder label for a `$DWGCODEPAGE` name, or null when this reader has no table for it. */
function codepageLabel(codepage) {
  if (codepage === undefined || /^(?:ASCII|UNDEFINED)$/iu.test(codepage)) return 'windows-1252';
  const ansi = /^ANSI_(\d+)$/iu.exec(codepage);
  if (!ansi) return null;
  const number = Number(ansi[1]);
  const named = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 874: 'windows-874' };
  if (named[number] !== undefined) return named[number];
  return number >= 1250 && number <= 1258 ? `windows-${number}` : null;
}

function decode(buffer) {
  refuseLargeFile(buffer.length);
  if (buffer.subarray(0, 18).toString('latin1') === 'AutoCAD Binary DXF')
    throw new DxfRefusal('binary_dxf', 'a binary DXF; export an ASCII DXF instead');
  // Header names are ASCII, so the version and code page can be read before the text is decoded.
  const header = pairsOf(buffer.toString('latin1'));
  const version = headerVariable(header, '$ACADVER');
  const codepage = headerVariable(header, '$DWGCODEPAGE');
  // From AutoCAD 2007 (AC1021) a DXF is UTF-8 whatever the code page says.
  const unicode = version !== undefined && version >= 'AC1021';
  const label = unicode ? 'utf-8' : codepageLabel(codepage);
  if (label === null)
    throw new DxfRefusal(
      'unsupported_codepage',
      `the code page ${codepage ?? ''} is not supported`,
    );
  try {
    return { text: new TextDecoder(label).decode(buffer), version, codepage };
  } catch {
    throw new DxfRefusal(
      'unsupported_codepage',
      `the code page ${codepage ?? ''} is not supported`,
    );
  }
}

const SPECIAL = { c: '⌀', d: '°', p: '±' };

/** TEXT and ATTRIB values: `\U+XXXX` escapes and `%%c`-style symbols. */
function plain(value) {
  return value
    .replace(/\\U\+([0-9A-Fa-f]{4})/gu, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/%%([cdpCDP])/gu, (_, symbol) => SPECIAL[symbol.toLowerCase()] ?? '')
    .replace(/%%[uoUO]/gu, '');
}

/** MTEXT: fonts, colours, heights and the like are dropped; `\P` is a line break. */
function mtext(value) {
  return plain(value)
    .replace(
      /\\([\\{}])|\\P|\\~|\\S([^;]*);|\\[fFcCHhWwQqTtAa][^;]*;|\\[LlOoKk]|[{}]/gu,
      (match, escaped, stacked) => {
        if (escaped !== undefined) return escaped;
        if (match === '\\P') return '\n';
        if (match === '\\~') return ' ';
        return stacked ?? '';
      },
    )
    .trim();
}

const first = (pairs, code) => pairs.find(([c]) => c === code)?.[1];
const number = (pairs, code) => {
  const value = first(pairs, code);
  return value === undefined ? undefined : Number(value);
};

/** The fields that are there: a coordinate the entity left out stays out of the JSON. */
const present = (fields) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

function entityText(type, pairs) {
  if (type === 'MTEXT')
    return mtext(
      pairs
        .filter(([code]) => code === 3)
        .map(([, value]) => value)
        .join('') + (first(pairs, 1) ?? ''),
    );
  if (type === 'TEXT' || type === 'ATTRIB' || type === 'ATTDEF' || type === 'DIMENSION')
    return plain(first(pairs, 1) ?? '').trim();
  return undefined;
}

/**
 * The text and structure of an ASCII DXF.
 *
 * @param {Buffer} buffer
 * @throws {DxfRefusal} `binary_dxf`, `unsupported_codepage`, `not_a_dxf` or `file_too_large`.
 */
export function readDxf(buffer) {
  const { text, version, codepage } = decode(buffer);
  const pairs = pairsOf(text);
  const start = pairs.findIndex(([code]) => code !== 999);
  if (pairs[start]?.[0] !== 0 || pairs[start]?.[1].trim() !== 'SECTION')
    throw new DxfRefusal('not_a_dxf', 'the file is not an ASCII DXF');

  const records = [];
  for (const pair of pairs.slice(start)) {
    if (pair[0] === 0) records.push({ type: pair[1].trim(), pairs: [] });
    else records.at(-1)?.pairs.push(pair);
  }

  const layers = [];
  const blocks = [];
  const counts = {};
  const texts = [];
  const inserts = [];
  const lines = [];
  const circles = [];
  let section = null;
  let block;
  for (const { type, pairs: body } of records) {
    if (type === 'SECTION') {
      section = first(body, 2)?.trim() ?? null;
      continue;
    }
    if (type === 'ENDSEC') section = null;
    else if (section === 'TABLES' && type === 'LAYER') layers.push(first(body, 2) ?? '');
    else if (section === 'BLOCKS' && type === 'BLOCK') {
      block = first(body, 2) ?? '';
      blocks.push(block);
    } else if (section === 'BLOCKS' && type === 'ENDBLK') block = undefined;
    else if (section === 'ENTITIES' || section === 'BLOCKS') {
      counts[type] = (counts[type] ?? 0) + 1;
      const layer = first(body, 8);
      const where = { ...(block === undefined ? {} : { block }), ...(layer ? { layer } : {}) };
      const [x, y] = [number(body, 10), number(body, 20)];
      const at = { ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) };
      const size = number(body, 40);
      const value = entityText(type, body);
      if (type === 'INSERT') inserts.push({ name: first(body, 2) ?? '', ...where, ...at });
      if (type === 'LINE')
        lines.push({
          ...where,
          ...present({ x1: x, y1: y, x2: number(body, 11), y2: number(body, 21) }),
        });
      if (type === 'CIRCLE') circles.push({ ...where, ...at, ...present({ r: size }) });
      if (value !== undefined) {
        const measurement = type === 'DIMENSION' ? number(body, 42) : undefined;
        if (value !== '' || measurement !== undefined)
          texts.push({
            type,
            ...where,
            ...(type === 'ATTRIB' || type === 'ATTDEF' ? { tag: first(body, 2) ?? '' } : {}),
            text: value,
            ...(measurement === undefined ? {} : { measurement }),
            ...(type === 'DIMENSION' ? {} : present({ height: size })),
            ...at,
          });
      }
    }
  }
  return {
    version: version ?? null,
    codepage: codepage ?? null,
    layers,
    blocks,
    counts,
    texts,
    inserts,
    lines,
    circles,
  };
}

// ---------- command line ----------

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [file, output] = process.argv.slice(2);
  if (file === undefined || process.argv.length > 4) {
    process.stderr.write('usage: node dxf.mjs <file> [out.json]\n');
    process.exit(2);
  }
  try {
    refuseLargeFile(statSync(file).size);
    const json = `${JSON.stringify(readDxf(readFileSync(file)), null, 2)}\n`;
    if (output === undefined) {
      process.stdout.write(json);
    } else {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, json);
      process.stdout.write(`${JSON.stringify({ written: output })}\n`);
    }
  } catch (error) {
    if (!(error instanceof DxfRefusal)) throw error;
    process.stderr.write(`${JSON.stringify({ error: error.code, message: error.message })}\n`);
    process.exit(1);
  }
}
