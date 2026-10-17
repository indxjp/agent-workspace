/* global process */ // The root ESLint config declares no environment globals.
// dxf-draft: read an ASCII DXF (R12 style) into a JSON summary, and write a draft derived from it.
// Plain Node, no dependency, so it runs inside a run's sandbox with `runCommands: true`.
//
//   node dxf.mjs summary <drawing.dxf>                       → summary JSON on stdout
//   node dxf.mjs draft <base.dxf> <changes.json> <out.dxf>   → writes out.dxf, summary + changeSet on stdout
//
// The drawing conventions it reads (layer names are the company's CAD standard, not DXF's):
//   OUTLINE  LINE entities forming the part's outer edge
//   HOLE     CIRCLE entities, the mounting holes
//   TITLE    TEXT entities "<項目> <値>" making the title block (図番, 品名, 材質, 板厚, …)
//   NOTE     TEXT entities, drawing notes, copied unchanged into a draft
// Anything else is kept in a draft as written and counted in the summary, never dropped silently.
//
// A draft changes only what the change set names. It refuses, instead of guessing, when the base
// outline is not a plain rectangle (stretching a notch would change dimensions nobody asked for),
// or when a hole would leave the outline or overlap another hole.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export class DraftRefused extends Error {
  constructor(problems) {
    super(`draft refused: ${problems.join('; ')}`);
    this.name = 'DraftRefused';
    this.problems = problems;
  }
}

const TITLE_KEYS = ['図番', '品名', '材質', '板厚', '尺度', '作成', '検図', '状態', '派生元'];
const EPSILON = 1e-6;

/** Group code / value pairs, tolerant of CRLF and indented codes. */
function pairsOf(text) {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const pairs = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number(lines[index].trim());
    if (!Number.isInteger(code)) {
      throw new Error(`line ${String(index + 1)}: expected a group code, got "${lines[index]}"`);
    }
    pairs.push([code, lines[index + 1]]);
  }
  return pairs;
}

/** Parse the HEADER variables and the ENTITIES section; other sections are skipped. */
export function parseDxf(text) {
  const pairs = pairsOf(text);
  const header = {};
  const entities = [];
  let section = null;
  let current = null;
  let variable = null;
  for (let index = 0; index < pairs.length; index += 1) {
    const [code, value] = pairs[index];
    if (code === 0 && value === 'SECTION') {
      section = pairs[index + 1]?.[1] ?? null;
      index += 1;
      continue;
    }
    if (code === 0 && (value === 'ENDSEC' || value === 'EOF')) {
      if (current) entities.push(current);
      current = null;
      section = null;
      continue;
    }
    if (section === 'HEADER') {
      if (code === 9) variable = value;
      else if (variable !== null) header[variable] = value.trim();
      continue;
    }
    if (section !== 'ENTITIES') continue;
    if (code === 0) {
      if (current) entities.push(current);
      current = { type: value.trim(), groups: [] };
      continue;
    }
    current?.groups.push([code, value]);
  }
  if (section !== null) throw new Error(`section ${section} is not closed with ENDSEC`);
  return { header, entities: entities.map(toEntity) };
}

function toEntity({ type, groups }) {
  const first = (code) => groups.find(([groupCode]) => groupCode === code)?.[1];
  const number = (code) => {
    const value = first(code);
    return value === undefined ? undefined : Number(value);
  };
  const layer = first(8)?.trim() ?? '0';
  if (type === 'LINE') {
    return { type, layer, x1: number(10), y1: number(20), x2: number(11), y2: number(21) };
  }
  if (type === 'CIRCLE') return { type, layer, x: number(10), y: number(20), r: number(40) };
  if (type === 'TEXT') {
    return { type, layer, x: number(10), y: number(20), height: number(40), text: first(1) ?? '' };
  }
  return { type, layer, groups };
}

const round = (value) => Math.round(value / EPSILON) * EPSILON;
const clean = (value) => Number(round(value).toFixed(6));

function boundsOf(lines) {
  const xs = lines.flatMap((line) => [line.x1, line.x2]);
  const ys = lines.flatMap((line) => [line.y1, line.y2]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/** True when the outline is exactly the four edges of its bounding box. */
function isRectangle(lines, bounds) {
  if (lines.length !== 4) return false;
  const key = (x1, y1, x2, y2) =>
    [`${clean(x1)},${clean(y1)}`, `${clean(x2)},${clean(y2)}`].sort().join('|');
  const { minX, minY, maxX, maxY } = bounds;
  const expected = new Set([
    key(minX, minY, maxX, minY),
    key(maxX, minY, maxX, maxY),
    key(maxX, maxY, minX, maxY),
    key(minX, maxY, minX, minY),
  ]);
  return lines.every((line) => expected.delete(key(line.x1, line.y1, line.x2, line.y2)));
}

function splitTitle(text) {
  const match = /^(\S+)[\s\u3000]+(.*)$/u.exec(text.trim());
  return match ? [match[1], match[2].trim()] : [text.trim(), ''];
}

/**
 * The summary an agent and a backend read: the title block, the outline's size from its lower-left
 * corner, and the holes as diameters at positions measured from that corner.
 */
export function summarise(text) {
  const { header, entities } = parseDxf(text);
  const outline = entities.filter((entity) => entity.type === 'LINE' && entity.layer === 'OUTLINE');
  if (outline.length === 0)
    throw new Error('no LINE entities on layer OUTLINE; not a part drawing');
  const bounds = boundsOf(outline);
  const title = {};
  const notes = [];
  for (const entity of entities) {
    if (entity.type !== 'TEXT') continue;
    if (entity.layer === 'TITLE') {
      const [key, value] = splitTitle(entity.text);
      title[key] = value;
    } else if (entity.layer === 'NOTE') notes.push(entity.text);
  }
  const holes = entities
    .filter((entity) => entity.type === 'CIRCLE' && entity.layer === 'HOLE')
    .map((circle) => ({
      x: clean(circle.x - bounds.minX),
      y: clean(circle.y - bounds.minY),
      diameter: clean(circle.r * 2),
    }));
  const known = new Set(['LINE', 'CIRCLE', 'TEXT']);
  return {
    version: header.$ACADVER ?? null,
    drawingNo: title['図番'] ?? null,
    partName: title['品名'] ?? null,
    material: title['材質'] ?? null,
    thickness: title['板厚'] ?? null,
    status: title['状態'] ?? null,
    derivedFrom: title['派生元'] ?? null,
    title,
    origin: { x: clean(bounds.minX), y: clean(bounds.minY) },
    width: clean(bounds.maxX - bounds.minX),
    height: clean(bounds.maxY - bounds.minY),
    rectangular: isRectangle(outline, bounds),
    holes,
    notes,
    entityCount: entities.length,
    unreadEntities: entities
      .filter((entity) => !known.has(entity.type))
      .map((entity) => entity.type),
  };
}

/** Problems with a set of holes in a `width` × `height` rectangle; empty when all is well. */
export function holeProblems(width, height, holes) {
  const problems = [];
  holes.forEach((hole, index) => {
    const label = `穴${String(index + 1)} (${String(hole.x)}, ${String(hole.y)}) φ${String(hole.diameter)}`;
    if (![hole.x, hole.y, hole.diameter].every(Number.isFinite) || hole.diameter <= 0) {
      problems.push(`${label}: 位置と直径は正の数で指定してください`);
      return;
    }
    const r = hole.diameter / 2;
    if (
      hole.x - r < -EPSILON ||
      hole.y - r < -EPSILON ||
      hole.x + r > width + EPSILON ||
      hole.y + r > height + EPSILON
    ) {
      problems.push(`${label}: 外形 ${String(width)}×${String(height)} からはみ出します`);
    }
    holes.slice(0, index).forEach((other, otherIndex) => {
      const distance = Math.hypot(hole.x - other.x, hole.y - other.y);
      if (distance < r + other.diameter / 2 - EPSILON) {
        problems.push(`${label}: 穴${String(otherIndex + 1)} と重なります`);
      }
    });
  });
  return problems;
}

/** 板厚 as drawings write it: t2.0, t1.6. */
const thicknessText = (value) => (Number.isInteger(value) ? value.toFixed(1) : String(value));

const holeText = (hole) => `(${String(hole.x)},${String(hole.y)})φ${String(hole.diameter)}`;
const sameHole = (a, b) => a.x === b.x && a.y === b.y && a.diameter === b.diameter;

/**
 * What a draft changed and what it kept, from the base's and the draft's summaries, in the words a
 * reply lists: `changes` as `高さ 80 → 90`, `kept` as `幅 140（元図のまま）`. The model copies these
 * lines instead of diffing the two drawings itself, so a value the request merely repeats is
 * reported as kept, never as a change.
 */
export function describeChanges(base, next) {
  const changes = [];
  const kept = [];
  const fields = [
    ['幅', base.width, next.width],
    ['高さ', base.height, next.height],
    ['材質', base.material, next.material],
    ['板厚', base.thickness, next.thickness],
    ['品名', base.partName, next.partName],
  ];
  for (const [label, before, after] of fields) {
    if (before === null && after === null) continue;
    if (before === null) changes.push(`${label} ${String(after)} を追加`);
    else if (before === after) kept.push(`${label} ${String(after)}（元図のまま）`);
    else changes.push(`${label} ${String(before)} → ${String(after)}`);
  }
  const removed = base.holes.filter((hole) => !next.holes.some((other) => sameHole(hole, other)));
  const added = next.holes.filter((hole) => !base.holes.some((other) => sameHole(hole, other)));
  // A moved hole pairs with the nearest unused added hole, one on the same x or y line first, so
  // the order the change set lists its holes in never crosses the lines.
  const unused = [...added];
  const closer = (hole, a, b) => {
    const alignedA = a.x === hole.x || a.y === hole.y;
    const alignedB = b.x === hole.x || b.y === hole.y;
    if (alignedA !== alignedB) return alignedA;
    return Math.hypot(a.x - hole.x, a.y - hole.y) < Math.hypot(b.x - hole.x, b.y - hole.y);
  };
  removed.forEach((hole) => {
    const replacement = unused.reduce(
      (best, other) => (best === undefined || closer(hole, other, best) ? other : best),
      undefined,
    );
    if (replacement === undefined) {
      changes.push(`穴 ${holeText(hole)} を削除`);
      return;
    }
    unused.splice(unused.indexOf(replacement), 1);
    changes.push(`穴 ${holeText(hole)} → ${holeText(replacement)}`);
  });
  unused.forEach((hole) => changes.push(`穴 ${holeText(hole)} を追加`));
  const same = base.holes.filter((hole) => next.holes.some((other) => sameHole(hole, other)));
  if (same.length > 0) kept.push(`穴 ${same.map(holeText).join(' ')}（元図のまま）`);
  return { changes, kept };
}

const DRAWING_NO = /^[A-Z]{2,4}-\d{4}$/u;

/**
 * Derive a draft from `baseText`. `changes`: `{ base, drawingNo, width, height, material?,
 * thickness?, partName?, holes?: [{ x, y, diameter }], drafter?, date? }`, positions from the
 * outline's lower-left corner. Holes left out keep the base's holes where they are.
 *
 * @throws {DraftRefused} with every problem found, never a partial draft.
 */
export function draft(baseText, changes) {
  const base = summarise(baseText);
  const problems = [];
  if (typeof changes.base === 'string' && /[/\\]|\.dxf$/iu.test(changes.base)) {
    problems.push(`base must be the drawing number "${String(base.drawingNo)}", not a file path`);
  } else if (changes.base !== base.drawingNo) {
    problems.push(`base ${String(changes.base)} is not this drawing (${String(base.drawingNo)})`);
  }
  if (typeof changes.drawingNo !== 'string' || !DRAWING_NO.test(changes.drawingNo)) {
    problems.push('drawingNo must look like BRK-1101');
  } else if (changes.drawingNo === base.drawingNo) {
    problems.push('drawingNo must be new; a draft never overwrites its base');
  }
  for (const key of ['width', 'height']) {
    if (!Number.isFinite(changes[key]) || changes[key] <= 0)
      problems.push(`${key} must be a positive number`);
  }
  if (
    changes.thickness !== undefined &&
    !(Number.isFinite(changes.thickness) && changes.thickness > 0)
  ) {
    problems.push('thickness must be a positive number');
  }
  if (!base.rectangular) {
    problems.push(
      `${String(base.drawingNo)} の外形は矩形ではありません。伸縮すると指示のない寸法が変わるため、手で作図してください`,
    );
  }
  const holes = changes.holes ?? base.holes;
  if (problems.length === 0) problems.push(...holeProblems(changes.width, changes.height, holes));
  if (problems.length > 0) throw new DraftRefused(problems);

  const { header, entities } = parseDxf(baseText);
  const { x: ox, y: oy } = base.origin;
  const W = clean(changes.width);
  const H = clean(changes.height);
  const outline = [
    [ox, oy, ox + W, oy],
    [ox + W, oy, ox + W, oy + H],
    [ox + W, oy + H, ox, oy + H],
    [ox, oy + H, ox, oy],
  ].map(([x1, y1, x2, y2]) => ({ type: 'LINE', layer: 'OUTLINE', x1, y1, x2, y2 }));
  const circles = holes.map((hole) => ({
    type: 'CIRCLE',
    layer: 'HOLE',
    x: ox + hole.x,
    y: oy + hole.y,
    r: hole.diameter / 2,
  }));

  const values = {
    ...base.title,
    図番: changes.drawingNo,
    ...(changes.partName === undefined ? {} : { 品名: changes.partName }),
    ...(changes.material === undefined ? {} : { 材質: changes.material }),
    ...(changes.thickness === undefined ? {} : { 板厚: `t${thicknessText(changes.thickness)}` }),
    作成: [changes.date, changes.drafter].filter(Boolean).join(' ') || '未記入',
    検図: '未',
    状態: '未検図',
    派生元: base.drawingNo,
  };
  const titleTexts = entities.filter(
    (entity) => entity.type === 'TEXT' && entity.layer === 'TITLE',
  );
  const written = new Set();
  const title = titleTexts.map((entity) => {
    const [key] = splitTitle(entity.text);
    written.add(key);
    return { ...entity, text: `${key} ${values[key]}` };
  });
  const last = titleTexts.at(-1) ?? { x: ox, y: oy - 10, height: 3.5 };
  const lineHeight = (last.height ?? 3.5) * 2;
  for (const key of TITLE_KEYS.filter((name) => !written.has(name) && values[name] !== undefined)) {
    const y = (title.at(-1)?.y ?? last.y) - lineHeight;
    title.push({
      type: 'TEXT',
      layer: 'TITLE',
      x: last.x,
      y,
      height: last.height ?? 3.5,
      text: `${key} ${values[key]}`,
    });
  }

  const kept = entities.filter(
    (entity) =>
      !(entity.type === 'LINE' && entity.layer === 'OUTLINE') &&
      !(entity.type === 'CIRCLE' && entity.layer === 'HOLE') &&
      !(entity.type === 'TEXT' && entity.layer === 'TITLE'),
  );
  const note = {
    type: 'TEXT',
    layer: 'NOTE',
    x: ox,
    y: oy + H + 10,
    height: 5,
    text: `未検図 ${String(base.drawingNo)} から派生した下書き。出図前に設計者が検図すること`,
  };
  const dxf = writeDxf({ header, entities: [...outline, ...circles, ...kept, ...title, note] });
  const summary = summarise(dxf);
  return {
    dxf,
    summary,
    changeSet: minimalChangeSet(base, changes),
    ...describeChanges(base, summary),
  };
}

/**
 * The change set as a reply shows it: `base`, `drawingNo`, `width`, `height`, and only the other
 * fields whose value differs from the base. The model pastes this instead of writing its own, so a
 * value the request merely repeats never shows up as a change.
 */
function minimalChangeSet(base, changes) {
  const holeSet = (holes) => holes.map(holeText).sort().join(' ');
  const sameHoles = changes.holes === undefined || holeSet(changes.holes) === holeSet(base.holes);
  const differs = (value, baseValue) => value !== undefined && value !== baseValue;
  return {
    base: changes.base,
    drawingNo: changes.drawingNo,
    width: changes.width,
    height: changes.height,
    ...(differs(changes.material, base.material) ? { material: changes.material } : {}),
    ...(changes.thickness !== undefined && `t${thicknessText(changes.thickness)}` !== base.thickness
      ? { thickness: changes.thickness }
      : {}),
    ...(differs(changes.partName, base.partName) ? { partName: changes.partName } : {}),
    ...(sameHoles ? {} : { holes: changes.holes }),
    ...(changes.drafter === undefined ? {} : { drafter: changes.drafter }),
    ...(changes.date === undefined ? {} : { date: changes.date }),
  };
}

/** DXF writes reals with a decimal point. */
function real(value) {
  const number = clean(value);
  return Number.isInteger(number) ? `${String(number)}.0` : String(number);
}

/** Write an ASCII DXF with a HEADER, a LAYER table and the entities. */
export function writeDxf({ header = {}, entities }) {
  const out = [];
  const pair = (code, value) => out.push(String(code).padStart(3, ' '), String(value));
  pair(0, 'SECTION');
  pair(2, 'HEADER');
  // Only $ACADVER is carried: AC1009 is R12. Text is written as UTF-8 (see SKILL.md on Shift_JIS).
  pair(9, '$ACADVER');
  pair(1, header.$ACADVER ?? 'AC1009');
  pair(0, 'ENDSEC');
  const layers = [...new Set(entities.map((entity) => entity.layer))];
  pair(0, 'SECTION');
  pair(2, 'TABLES');
  pair(0, 'TABLE');
  pair(2, 'LAYER');
  pair(70, layers.length);
  for (const layer of layers) {
    pair(0, 'LAYER');
    pair(2, layer);
    pair(70, 0);
    pair(62, 7);
    pair(6, 'CONTINUOUS');
  }
  pair(0, 'ENDTAB');
  pair(0, 'ENDSEC');
  pair(0, 'SECTION');
  pair(2, 'ENTITIES');
  for (const entity of entities) {
    pair(0, entity.type);
    pair(8, entity.layer);
    if (entity.type === 'LINE') {
      pair(10, real(entity.x1));
      pair(20, real(entity.y1));
      pair(30, '0.0');
      pair(11, real(entity.x2));
      pair(21, real(entity.y2));
      pair(31, '0.0');
    } else if (entity.type === 'CIRCLE') {
      pair(10, real(entity.x));
      pair(20, real(entity.y));
      pair(30, '0.0');
      pair(40, real(entity.r));
    } else if (entity.type === 'TEXT') {
      pair(10, real(entity.x));
      pair(20, real(entity.y));
      pair(30, '0.0');
      pair(40, real(entity.height ?? 3.5));
      pair(1, entity.text);
    } else {
      for (const [code, value] of entity.groups) pair(code, value);
    }
  }
  pair(0, 'ENDSEC');
  pair(0, 'EOF');
  return `${out.join('\n')}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'summary' && args.length === 1) {
      process.stdout.write(
        `${JSON.stringify(summarise(readFileSync(args[0], 'utf8')), null, 2)}\n`,
      );
    } else if (command === 'draft' && args.length === 3) {
      const changes = JSON.parse(readFileSync(args[1], 'utf8'));
      const result = draft(readFileSync(args[0], 'utf8'), changes);
      writeFileSync(args[2], result.dxf);
      const { summary, changeSet, changes: changed, kept } = result;
      process.stdout.write(
        `${JSON.stringify({ ...summary, changeSet, changes: changed, kept }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(
        'usage: node dxf.mjs summary <file.dxf> | draft <base.dxf> <changes.json> <out.dxf>\n',
      );
      process.exit(2);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
