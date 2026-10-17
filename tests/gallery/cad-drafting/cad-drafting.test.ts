/**
 * Use case 2, the CAD drawing agent: the definition passes the contract, the drawing index finds
 * similar past drawings, the dxf-draft skill writes a draft whose geometry is exactly the request,
 * and the design desk's backend refuses a draft that invents a dimension or loses a hole.
 */
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startMcpServer, type McpSession } from '../harness/mcp-client.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import { scriptedWorkspace, type ScriptContext } from '../harness/scripted-workspace.ts';
import { draftFrom, findCandidates, type Candidate, type Requirements } from './backend/draft.ts';
import {
  describeChanges,
  draft,
  summarise,
  type ChangeSet,
  type DrawingSummary,
} from './skills/dxf-draft/scripts/dxf.mjs';
import agentDefinition from './agents/cad-drafting.ts';
import surfaceDefinition from './surfaces/design-desk.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DRAWINGS = path.join(DIR, 'data', 'drawings');
const SCRIPT = path.join(DIR, 'skills', 'dxf-draft', 'scripts', 'dxf.mjs');
const CONNECTOR_ID = '6b1c1f0e-0000-4000-8000-000000000002';
const run = promisify(execFile);

const REQUIREMENTS: Requirements = {
  partName: 'ブラケット',
  width: 140,
  height: 90,
  material: 'SUS304',
  thickness: 2.0,
  holes: {
    diameter: 9,
    positions: [
      { x: 15, y: 15 },
      { x: 125, y: 15 },
      { x: 15, y: 75 },
      { x: 125, y: 75 },
    ],
  },
  drawingNo: 'BRK-1101',
  drafter: '高橋',
  date: '2026-10-04',
};

interface SearchResult {
  readonly candidates: readonly Candidate[];
  readonly unreadable: readonly string[];
}

let index: McpSession;
let project: GalleryProject;
let work: string;

beforeAll(async () => {
  index = await startMcpServer(path.join(DIR, 'mcp', 'drawing-index.mjs'));
  project = await loadGalleryProject(DIR, {
    'agents/cad-drafting.ts': agentDefinition,
    'surfaces/design-desk.ts': surfaceDefinition,
  });
  work = await mkdtemp(path.join(tmpdir(), 'cad-drafting-'));
});
afterAll(() => {
  index.close();
});

const readDrawing = (drawingNo: string): Promise<string> =>
  readFile(path.join(DRAWINGS, `${drawingNo}.dxf`), 'utf8');

/** The change set a model following `agents/cad-drafting.md` writes: only what the request changes. */
function changeSetFor(requirements: Requirements, base: DrawingSummary): ChangeSet {
  return {
    base: base.drawingNo ?? '',
    drawingNo: requirements.drawingNo,
    width: requirements.width,
    height: requirements.height,
    ...(requirements.partName === base.partName ? {} : { partName: requirements.partName }),
    ...(requirements.material === base.material ? {} : { material: requirements.material }),
    ...(`t${requirements.thickness.toFixed(1)}` === base.thickness
      ? {}
      : { thickness: requirements.thickness }),
    ...(requirements.holes === undefined
      ? {}
      : {
          holes: requirements.holes.positions.map(({ x, y }) => ({
            x,
            y,
            diameter: requirements.holes?.diameter ?? 0,
          })),
        }),
  };
}

const answerWith = (changeSet: ChangeSet): string =>
  [
    `${changeSet.base} から高さと穴位置を変更しました。`,
    '```json',
    JSON.stringify(changeSet, null, 2),
    '```',
    '未検図です。出図前に検図してください。',
  ].join('\n');

/**
 * What a model following the instructions does in each of the two turns. `edit` lets a test make
 * the model sloppy (invent a dimension) to check the backend catches it. Tool results are real.
 */
function designer(
  edit: (changeSet: ChangeSet) => ChangeSet = (changeSet) => changeSet,
  requirements: Requirements = REQUIREMENTS,
) {
  return async (context: ScriptContext): Promise<string> => {
    const chosen = /^(\S+) を元に作図/u.exec(context.prompt)?.[1];
    if (chosen === undefined) {
      const found = await context.tool('drawing-index', 'search_drawings', {
        query: requirements.partName,
        material: requirements.material,
        width: requirements.width,
        height: requirements.height,
      });
      const { candidates } = JSON.parse(found.text) as SearchResult;
      return candidates
        .map((hit) => `| ${hit.drawingNo} | ${hit.differences.join('、') || '差分なし'} |`)
        .join('\n');
    }
    const read = await context.tool('drawing-index', 'read_drawing', { drawingNo: chosen });
    const base = JSON.parse(read.text) as DrawingSummary;
    return answerWith(edit(changeSetFor(requirements, base)));
  };
}

const connectors = () => ({ 'drawing-index': { id: CONNECTOR_ID, session: index } });

describe('CAD drawing agent', () => {
  it('the project passes the contract aw check applies', () => {
    const [agent] = project.agents;
    expect(project.agents).toHaveLength(1);
    const definition = agent?.body.definition;
    expect(definition?.agent.permissions).toStrictEqual({
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: false,
    });
    expect(definition?.policy).toMatchObject({
      tools: {
        permissionMode: 'default',
        autoApprove: ['Write', 'mcp__agent-workspace__run_skill_script'],
      },
    });
    expect(definition?.resources).toMatchObject({
      connectors: ['drawing-index'],
      skills: ['dxf-draft'],
      files: [
        { path: 'drawings', access: 'read' },
        { path: 'drafts', access: 'read-write' },
      ],
    });
    expect(agent?.body.surfaces?.map((surface) => surface.name)).toStrictEqual(['design-desk']);
    expect(project.surfaces[0]?.layout).toBe('page');
    expect(definition?.agent.instructions).toContain('未検図');
    // The reply's bullets are the script's own `changes` and `kept` lines.
    expect(definition?.agent.instructions).toContain('`changes` を変更点の箇条書きにそのまま写し');
    expect(definition?.agent.instructions).toContain('元図と値が違う項目だけ');
    // ...and its change set is the script's `changeSet`, pasted, not composed by the model.
    expect(definition?.agent.instructions).toContain('`changeSet`');
    expect(project.skills.map((skill) => skill.name)).toStrictEqual(['dxf-draft']);
    expect(project.skills[0]?.files.map((file) => file.path).sort()).toStrictEqual([
      'SKILL.md',
      'scripts/dxf.d.mts',
      'scripts/dxf.mjs',
    ]);
    expect(project.project.policy?.permissions?.unrestrictedNetwork).toBe(false);
  });

  it('the eval file pins the candidates, the 未検図 mark and the refusals in text', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(4);
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
    expect(cases.some((entry) => entry.expect.contains?.includes('未検図'))).toBe(true);
    expect(cases.filter((entry) => entry.expect.judge !== undefined)).toHaveLength(3);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('every past drawing is a valid R12 DXF the skill reads', async () => {
    for (const drawingNo of [
      'BRK-1001',
      'BRK-1002',
      'BRK-1003',
      'BRK-1004',
      'PLT-2001',
      'CVR-3002',
    ]) {
      const summary = summarise(await readDrawing(drawingNo));
      expect(summary).toMatchObject({ version: 'AC1009', drawingNo, status: '出図' });
      expect(summary.unreadEntities).toStrictEqual([]);
    }
    expect(summarise(await readDrawing('BRK-1003'))).toMatchObject({
      partName: 'ブラケット',
      material: 'SUS304',
      thickness: 't2.0',
      origin: { x: 50, y: 50 },
      width: 140,
      height: 80,
      rectangular: true,
    });
    expect(summarise(await readDrawing('BRK-1004')).rectangular).toBe(false);
  });

  it('the skill script drafts a DXF that re-parses with exactly the requested geometry', async () => {
    const changes = path.join(work, 'BRK-1101.changes.json');
    const out = path.join(work, 'BRK-1101.dxf');
    const base = summarise(await readDrawing('BRK-1003'));
    await writeFile(
      changes,
      JSON.stringify({ ...changeSetFor(REQUIREMENTS, base), drafter: '高橋', date: '2026-10-04' }),
    );
    const { stdout } = await run(process.execPath, [
      SCRIPT,
      'draft',
      path.join(DRAWINGS, 'BRK-1003.dxf'),
      changes,
      out,
    ]);
    const {
      changeSet: printed,
      changes: changed,
      kept: keptLines,
      ...reported
    } = JSON.parse(stdout) as DrawingSummary & {
      changeSet: ChangeSet;
      changes: string[];
      kept: string[];
    };
    const written = summarise(await readFile(out, 'utf8'));
    expect(written).toStrictEqual(reported);
    // The change set the reply pastes: only the fields that differ from the base.
    expect(printed).toStrictEqual({
      ...changeSetFor(REQUIREMENTS, base),
      drafter: '高橋',
      date: '2026-10-04',
    });
    expect(Object.keys(printed)).not.toContain('material');
    // The reply's bullets come from these lines: only the height and the two upper holes changed,
    // and everything the request merely repeats is reported as kept.
    expect(changed).toStrictEqual([
      '高さ 80 → 90',
      '穴 (15,65)φ9 → (15,75)φ9',
      '穴 (125,65)φ9 → (125,75)φ9',
    ]);
    expect(keptLines).toStrictEqual([
      '幅 140（元図のまま）',
      '材質 SUS304（元図のまま）',
      '板厚 t2.0（元図のまま）',
      '品名 ブラケット（元図のまま）',
      '穴 (15,15)φ9 (125,15)φ9（元図のまま）',
    ]);
    expect(written).toMatchObject({
      version: 'AC1009',
      drawingNo: 'BRK-1101',
      material: 'SUS304',
      thickness: 't2.0',
      status: '未検図',
      derivedFrom: 'BRK-1003',
      origin: base.origin,
      width: 140,
      height: 90,
      rectangular: true,
    });
    expect(written.title).toMatchObject({ 検図: '未', 作成: '2026-10-04 高橋', 尺度: '1:1' });
    expect(written.holes).toStrictEqual([
      { x: 15, y: 15, diameter: 9 },
      { x: 125, y: 15, diameter: 9 },
      { x: 15, y: 75, diameter: 9 },
      { x: 125, y: 75, diameter: 9 },
    ]);
    // Only what the request changes: the notes are the base's, plus the 未検図 note.
    expect(written.notes.slice(0, base.notes.length)).toStrictEqual(base.notes);
    expect(written.notes.at(-1)).toContain('未検図 BRK-1003 から派生');

    // Holes left out keep the base's; the summary command reads the draft back.
    await writeFile(
      changes,
      JSON.stringify({ base: 'BRK-1001', drawingNo: 'BRK-1102', width: 130, height: 60 }),
    );
    await run(process.execPath, [
      SCRIPT,
      'draft',
      path.join(DRAWINGS, 'BRK-1001.dxf'),
      changes,
      out,
    ]);
    const kept = JSON.parse(
      (await run(process.execPath, [SCRIPT, 'summary', out])).stdout,
    ) as DrawingSummary;
    expect(kept).toMatchObject({ width: 130, height: 60, material: 'SS400', thickness: 't3.2' });
    expect(kept.holes).toStrictEqual(summarise(await readDrawing('BRK-1001')).holes);
  });

  it('a change set that repeats the base values reports them as kept, not as changes', async () => {
    const base = summarise(await readDrawing('BRK-1003'));
    const chatty = {
      ...changeSetFor(REQUIREMENTS, base),
      material: 'SUS304',
      thickness: 2.0,
      partName: 'ブラケット',
    };
    const { changes, kept, changeSet } = draft(await readDrawing('BRK-1003'), chatty);
    // The printed change set drops every field the request merely repeats.
    expect(changeSet).toStrictEqual(changeSetFor(REQUIREMENTS, base));
    expect(
      draft(await readDrawing('BRK-1003'), { ...chatty, holes: base.holes }).changeSet,
    ).toStrictEqual({ base: 'BRK-1003', drawingNo: 'BRK-1101', width: 140, height: 90 });
    expect(changes).toStrictEqual([
      '高さ 80 → 90',
      '穴 (15,65)φ9 → (15,75)φ9',
      '穴 (125,65)φ9 → (125,75)φ9',
    ]);
    expect(kept).toContain('材質 SUS304（元図のまま）');
    expect(kept).toContain('板厚 t2.0（元図のまま）');
    expect(changes.join('\n')).not.toMatch(/SUS304|t2\.0|幅/u);
    const other = draft(await readDrawing('BRK-1003'), {
      ...chatty,
      material: 'SS400',
      holes: [{ x: 15, y: 15, diameter: 9 }],
    });
    expect(other.changes).toContain('材質 SUS304 → SS400');
    expect(other.changeSet).toMatchObject({ material: 'SS400' });
    expect(other.changes.filter((line) => line.includes('削除'))).toHaveLength(3);
  });

  it('moved holes pair by position, not by the order the change set lists them in', async () => {
    const base = summarise(await readDrawing('BRK-1003'));
    const ordered = changeSetFor(REQUIREMENTS, base);
    const swapped = { ...ordered, holes: [...(ordered.holes ?? [])].reverse() };
    expect(draft(await readDrawing('BRK-1003'), swapped).changes).toStrictEqual([
      '高さ 80 → 90',
      '穴 (15,65)φ9 → (15,75)φ9',
      '穴 (125,65)φ9 → (125,75)φ9',
    ]);
  });

  it('a title field the base and the draft both lack is left out, never printed as null', async () => {
    const base = { ...summarise(await readDrawing('BRK-1003')), partName: null };
    const { changes, kept } = describeChanges(base, { ...base, height: base.height + 10 });
    expect([...changes, ...kept].join('\n')).not.toContain('null');
    expect(kept.some((line) => line.startsWith('品名'))).toBe(false);
  });

  it('a field the base lacks and the draft sets is an addition, never null → X', async () => {
    const base = { ...summarise(await readDrawing('BRK-1003')), partName: null };
    const { changes } = describeChanges(base, { ...base, partName: 'ブラケット' });
    expect(changes).toStrictEqual(['品名 ブラケット を追加']);
  });

  it('the skill script refuses holes outside the outline and an outline it would have to stretch', async () => {
    const changes = path.join(work, 'bad.changes.json');
    const out = path.join(work, 'bad.dxf');
    const refusal = async (base: string, changeSet: object): Promise<string> => {
      await writeFile(changes, JSON.stringify(changeSet));
      const failed = await run(process.execPath, [
        SCRIPT,
        'draft',
        path.join(DRAWINGS, `${base}.dxf`),
        changes,
        out,
      ]).then(
        () => null,
        (error: unknown) => error as { code: number; stderr: string },
      );
      expect(failed?.code).toBe(1);
      return failed?.stderr ?? '';
    };
    // Shrinking BRK-1001 to 100 wide keeps its hole at x=105: it would leave the outline.
    expect(
      await refusal('BRK-1001', {
        base: 'BRK-1001',
        drawingNo: 'BRK-1103',
        width: 100,
        height: 60,
      }),
    ).toContain('穴2 (105, 15) φ9: 外形 100×60 からはみ出します');
    expect(
      await refusal('BRK-1004', {
        base: 'BRK-1004',
        drawingNo: 'BRK-1104',
        width: 120,
        height: 100,
      }),
    ).toContain('BRK-1004 の外形は矩形ではありません');
    expect(
      await refusal('BRK-1001', {
        base: 'drawings/BRK-1001.dxf',
        drawingNo: 'BRK-1103',
        width: 120,
        height: 60,
      }),
    ).toContain('base must be the drawing number "BRK-1001", not a file path');
    expect(
      await refusal('BRK-1001', {
        base: 'BRK-1001',
        drawingNo: 'BRK-1001',
        width: 120,
        height: 60,
      }),
    ).toContain('drawingNo must be new');
    await expect(readFile(out, 'utf8')).rejects.toThrow();
  });

  it('the index ranks similar brackets by title block and size, reads a drawing whole, and lists DWG files it cannot read', async () => {
    expect(await index.tools()).toStrictEqual(['search_drawings', 'read_drawing']);

    const found = await index.callJson<SearchResult>('search_drawings', {
      query: 'ブラケット',
      material: 'SUS304',
      width: 140,
      height: 90,
    });
    expect(found.candidates.map((hit) => hit.drawingNo)).toStrictEqual([
      'BRK-1003',
      'BRK-1004',
      'BRK-1002',
    ]);
    expect(found.candidates[0]?.differences).toStrictEqual(['高さ 80 → 90 (+10)']);
    expect(found.candidates[1]?.differences).toContain(
      '外形が矩形でない（伸縮での流用不可、手で作図）',
    );
    expect(found.candidates[2]?.differences).toStrictEqual([
      '幅 150 → 140 (-10)',
      '高さ 75 → 90 (+15)',
      '材質 SS400 → SUS304',
    ]);

    // Size alone, with full-width input in the query, still lands on the plate.
    const plate = await index.callJson<SearchResult>('search_drawings', {
      query: '取付プレート　ＳＰＣＣ',
      limit: 1,
    });
    expect(plate.candidates.map((hit) => hit.drawingNo)).toStrictEqual(['PLT-2001']);

    const drawing = await index.callJson<DrawingSummary>('read_drawing', { drawingNo: 'BRK-1003' });
    expect(drawing).toMatchObject({
      width: 140,
      height: 80,
      holes: [{ x: 15, y: 15, diameter: 9 }, {}, {}, {}],
    });

    // An unrelated part name returns nothing rather than the least-bad drawing.
    expect(
      (await index.callJson<SearchResult>('search_drawings', { query: '油圧シリンダ' })).candidates,
    ).toStrictEqual([]);
    expect((await index.call('search_drawings', {})).isError).toBe(true);
    expect((await index.call('search_drawings', { width: -5 })).isError).toBe(true);
    expect((await index.call('read_drawing', { drawingNo: 'BRK-9999' })).isError).toBe(true);

    // A store that also holds a DWG: it is listed, never searched, and reading it says why.
    const store = path.join(work, 'store');
    await cp(DRAWINGS, store, { recursive: true });
    await writeFile(path.join(store, 'BRK-0907.dwg'), Buffer.from('AC1032\0\0\0\0binary'));
    const mixed = await startMcpServer(path.join(DIR, 'mcp', 'drawing-index.mjs'), {
      DRAWINGS_DIR: store,
    });
    try {
      const result = await mixed.callJson<SearchResult>('search_drawings', { query: 'ブラケット' });
      expect(result.unreadable).toStrictEqual(['BRK-0907.dwg']);
      const dwg = await mixed.call('read_drawing', { drawingNo: 'BRK-0907' });
      expect(dwg).toMatchObject({ isError: true });
      expect(dwg.text).toContain('DXF に書き出してから登録してください');
    } finally {
      mixed.close();
    }
  });

  it('the backend shows three candidates, then drafts from the chosen one and marks it 未検図', async () => {
    const workspace = scriptedWorkspace(designer(), connectors());
    const list = await findCandidates(workspace.aw, workspace.agentId, REQUIREMENTS);
    expect(list.candidates.map((hit) => hit.drawingNo)).toStrictEqual([
      'BRK-1003',
      'BRK-1004',
      'BRK-1002',
    ]);
    expect(list.answer).toContain('BRK-1003 | 高さ 80 → 90 (+10)');
    expect(workspace.runs[0]?.prompt).toContain('外形: 幅 140 × 高さ 90 mm');

    // The designer picks BRK-1003; the second run continues the same session.
    const outcome = await draftFrom(workspace.aw, workspace.agentId, {
      requirements: REQUIREMENTS,
      chosen: 'BRK-1003',
      sessionId: list.sessionId,
      readDrawing,
    });
    expect(outcome.sessionId).toBe(list.sessionId);
    expect(outcome.status).toBe('ready-for-check');
    if (outcome.status !== 'ready-for-check') return;
    // The agent changed only height and holes; material and thickness already matched.
    expect(Object.keys(outcome.changeSet).sort()).toStrictEqual([
      'base',
      'drawingNo',
      'height',
      'holes',
      'width',
    ]);
    expect(summarise(outcome.dxf)).toMatchObject({
      drawingNo: 'BRK-1101',
      width: 140,
      height: 90,
      status: '未検図',
      derivedFrom: 'BRK-1003',
    });
    expect(outcome.summary.title['作成']).toBe('2026-10-04 高橋');
  });

  it('the backend refuses a draft that invents a dimension, stretches a notched outline or loses a hole', async () => {
    const start = async (
      edit: (changeSet: ChangeSet) => ChangeSet,
      chosen: string,
      requirements: Requirements = REQUIREMENTS,
    ) => {
      const workspace = scriptedWorkspace(designer(edit, requirements), connectors());
      const list = await findCandidates(workspace.aw, workspace.agentId, requirements);
      return draftFrom(workspace.aw, workspace.agentId, {
        requirements,
        chosen,
        sessionId: list.sessionId,
        readDrawing,
      });
    };

    // The model writes 145 where the designer asked for 140, and moves a hole.
    const invented = await start(
      (changeSet) => ({
        ...changeSet,
        width: 145,
        holes: (changeSet.holes ?? []).map((hole, at) => (at === 1 ? { ...hole, x: 130 } : hole)),
      }),
      'BRK-1003',
    );
    expect(invented).toMatchObject({ status: 'refused' });
    if (invented.status !== 'refused') return;
    expect(invented.problems[0]).toBe('幅: 要件は 140、作図は 145');
    expect(invented.problems[1]).toMatch(/^取付穴: 要件・元図にない穴があります/u);

    // BRK-1004 is L-shaped: the script refuses to stretch it, so no DXF is returned.
    const notched = await start((changeSet) => changeSet, 'BRK-1004');
    expect(notched).toMatchObject({ status: 'refused' });
    if (notched.status !== 'refused') return;
    expect(notched.problems.join('\n')).toContain('BRK-1004 の外形は矩形ではありません');
    expect('dxf' in notched).toBe(false);

    // A requirement whose hole would cut the edge is refused before any file is written.
    const edge = await start((changeSet) => changeSet, 'BRK-1003', {
      ...REQUIREMENTS,
      holes: {
        diameter: 11,
        positions: [
          { x: 15, y: 15 },
          { x: 136, y: 15 },
        ],
      },
    });
    expect(edge).toMatchObject({ status: 'refused' });
    if (edge.status !== 'refused') return;
    expect(edge.problems).toStrictEqual(['穴2 (136, 15) φ11: 外形 140×90 からはみ出します']);

    // An answer with no change set is refused, not guessed.
    const silent = scriptedWorkspace(() => Promise.resolve('作図しました。'), connectors());
    const nothing = await draftFrom(silent.aw, silent.agentId, {
      requirements: REQUIREMENTS,
      chosen: 'BRK-1003',
      sessionId: '00000000-0000-4000-8000-000000000000',
      readDrawing,
    });
    expect(nothing).toMatchObject({
      status: 'refused',
      problems: ['回答に変更セット（```json）がありません'],
      changeSet: null,
    });
  });
});
