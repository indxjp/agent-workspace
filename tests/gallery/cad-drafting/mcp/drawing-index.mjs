/* global process */ // The root ESLint config declares no environment globals.
// drawing-index: the past-drawing search behind the cad-drafting agent, as an MCP server.
//
// It reads every ASCII DXF in the drawing store with the dxf-draft skill's own parser, so the
// index and the agent agree on what a drawing says, and serves two tools:
//
//   search_drawings { query?, material?, width?, height?, limit? }
//       → { candidates: [...], unreadable: [...] } ranked by title-block text, size closeness and
//         material, each with the differences from what was asked
//   read_drawing    { drawingNo } → the drawing's summary: title block, outline size, holes
//
// DWG is a closed binary format and a scanned drawing is an image; neither can be read without a
// converter the platform does not have (it stores files as bytes). Such files are listed as
// `unreadable`, so the designer knows they exist and were not searched, instead of vanishing.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createIndex, normalise } from '../../shared/jp-search.mjs';
import { limit, refuse, serveTools, text } from '../../shared/mcp-server.mjs';
import { summarise } from '../skills/dxf-draft/scripts/dxf.mjs';

const DRAWINGS_DIR =
  process.env.DRAWINGS_DIR ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'drawings');

const UNREADABLE = new Set(['.dwg', '.pdf', '.tif', '.tiff', '.png', '.jpg', '.jpeg']);

function loadDrawings(dir) {
  const drawings = [];
  const unreadable = [];
  for (const name of readdirSync(dir).sort()) {
    const extension = path.extname(name).toLowerCase();
    if (UNREADABLE.has(extension)) unreadable.push(name);
    if (extension !== '.dxf') continue;
    const summary = summarise(readFileSync(path.join(dir, name), 'utf8'));
    drawings.push({ ...summary, file: name });
  }
  return { drawings, unreadable };
}

const { drawings, unreadable } = loadDrawings(DRAWINGS_DIR);
const byNo = new Map(drawings.map((drawing) => [drawing.drawingNo, drawing]));
const index = createIndex(
  drawings.map((drawing) => ({
    id: drawing.drawingNo,
    title: drawing.partName ?? '',
    text: [drawing.drawingNo, drawing.material, drawing.thickness, ...drawing.notes].join(' '),
  })),
);

/** An optional positive number argument, or a refusal naming it. */
function size(args, key) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    refuse(`${key} must be a positive number in mm`);
  }
  return value;
}

const signed = (value) => (value > 0 ? `+${String(value)}` : String(value));

function differences(drawing, wanted) {
  const found = [];
  for (const [key, label] of [
    ['width', '幅'],
    ['height', '高さ'],
  ]) {
    const asked = wanted[key];
    if (asked !== undefined && asked !== drawing[key]) {
      found.push(
        `${label} ${String(drawing[key])} → ${String(asked)} (${signed(Number((asked - drawing[key]).toFixed(3)))})`,
      );
    }
  }
  if (
    wanted.material !== undefined &&
    normalise(wanted.material) !== normalise(drawing.material ?? '')
  ) {
    found.push(`材質 ${String(drawing.material)} → ${wanted.material}`);
  }
  if (!drawing.rectangular) found.push('外形が矩形でない（伸縮での流用不可、手で作図）');
  return found;
}

function search(args) {
  const query =
    typeof args.query === 'string' && args.query.trim() !== '' ? args.query.trim() : undefined;
  const material =
    typeof args.material === 'string' && args.material.trim() !== ''
      ? args.material.trim()
      : undefined;
  const wanted = { width: size(args, 'width'), height: size(args, 'height'), material };
  if (
    query === undefined &&
    material === undefined &&
    wanted.width === undefined &&
    wanted.height === undefined
  ) {
    refuse('give at least one of query, material, width, height');
  }
  // When the designer names the part, the title block must match it: a plate is not a bracket.
  const textHits =
    query === undefined
      ? null
      : new Map(index.search(query, { limit: drawings.length }).map((hit) => [hit.id, hit.score]));
  const best = textHits === null ? 1 : Math.max(...textHits.values(), 1e-9);

  const ranked = [];
  for (const drawing of drawings) {
    if (textHits !== null && !textHits.has(drawing.drawingNo)) continue;
    const parts = [];
    if (textHits !== null) parts.push([0.4, (textHits.get(drawing.drawingNo) ?? 0) / best]);
    const gaps = ['width', 'height']
      .filter((key) => wanted[key] !== undefined)
      .map((key) => Math.abs(drawing[key] - wanted[key]) / wanted[key]);
    if (gaps.length > 0)
      parts.push([0.4, Math.max(0, 1 - gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length)]);
    if (material !== undefined)
      parts.push([0.2, normalise(material) === normalise(drawing.material ?? '') ? 1 : 0]);
    const weight = parts.reduce((sum, [w]) => sum + w, 0);
    const score = parts.reduce((sum, [w, value]) => sum + w * value, 0) / weight;
    ranked.push({
      drawingNo: drawing.drawingNo,
      partName: drawing.partName,
      material: drawing.material,
      thickness: drawing.thickness,
      width: drawing.width,
      height: drawing.height,
      holes: drawing.holes.length,
      holeDiameters: [...new Set(drawing.holes.map((hole) => hole.diameter))],
      rectangular: drawing.rectangular,
      status: drawing.status,
      score: Number(score.toFixed(3)),
      differences: differences(drawing, wanted),
    });
  }
  ranked.sort(
    (left, right) => right.score - left.score || left.drawingNo.localeCompare(right.drawingNo),
  );
  return { candidates: ranked.slice(0, limit(args, 'limit', 3, 10)), unreadable };
}

serveTools({
  name: 'drawing-index',
  tools: [
    {
      name: 'search_drawings',
      description:
        '過去図面を探す。query（品名・注記の語句）、material（材質）、width/height（外形 mm）の少なくとも1つを渡す。表題欄の一致と外形寸法の近さで順位付けし、要求との差分（differences）を添えて返す。unreadable は読めなかった DWG・画像図面。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          material: { type: 'string' },
          width: { type: 'number', exclusiveMinimum: 0 },
          height: { type: 'number', exclusiveMinimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
      handler: search,
    },
    {
      name: 'read_drawing',
      description:
        '図番の図面を読む。表題欄、外形の幅と高さ（mm）、穴（外形左下からの位置と直径）、注記を返す。作図の元にする図面は必ずこれで読む。',
      inputSchema: {
        type: 'object',
        properties: { drawingNo: { type: 'string' } },
        required: ['drawingNo'],
      },
      handler: (args) => {
        const drawingNo = text(args, 'drawingNo');
        const drawing = byNo.get(drawingNo);
        if (drawing !== undefined) return drawing;
        const binary = unreadable.find((name) => path.parse(name).name === drawingNo);
        if (binary !== undefined) {
          refuse(
            `${binary} は DWG・画像形式で、この環境では読めません。CAD で DXF に書き出してから登録してください`,
          );
        }
        refuse(`no drawing ${drawingNo}; call search_drawings first`);
      },
    },
  ],
});
