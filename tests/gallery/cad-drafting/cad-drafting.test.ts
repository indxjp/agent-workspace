/**
 * Use case 2, the CAD drawing agent: the definition passes the contract, the platform's
 * `search_files` finds similar past drawings inside the designer's `fileScope`, the dxf-draft skill
 * writes a draft whose geometry is exactly the request, and the design desk's backend refuses a
 * draft that invents a dimension or loses a hole.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readDxf } from '@agent-workspace/skills-office/office-reader/scripts/dxf.mjs';
import { beforeAll, describe, expect, it } from 'vitest';

import { createFileSearch } from '../harness/file-search.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type ScriptAnswer,
  type Script,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import {
  NoDrawingAccess,
  decideDraft,
  fileScopeOf,
  proposeDraft,
  type AccessList,
  type DraftAwaitingApproval,
  type Requirements,
} from './backend/draft.ts';
import {
  DraftRefused,
  describeChanges,
  draft,
  summarise,
  type ChangeSet,
  type DrawingSummary,
} from './skills/dxf-draft/scripts/dxf.mjs';
import agentDefinition from './agents/cad-drafting.ts';
import surfaceDefinition from './surfaces/design-desk.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, 'data');
const SCRIPT = path.join(DIR, 'skills', 'dxf-draft', 'scripts', 'dxf.mjs');
// Who is asking: both are in `data/access.json`; the second may use the PLT series only.
const DESIGNER = '高橋';
const OTHER_DESIGNER = '中村';
const ACCESS = JSON.parse(readFileSync(path.join(DATA, 'access.json'), 'utf8')) as AccessList;
const run = promisify(execFile);

interface Hit {
  readonly path: string;
  readonly snippet: string;
}

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

let project: GalleryProject;
let work: string;

beforeAll(async () => {
  project = await loadGalleryProject(DIR, {
    'agents/cad-drafting.ts': agentDefinition,
    'surfaces/design-desk.ts': surfaceDefinition,
  });
  work = await mkdtemp(path.join(tmpdir(), 'cad-drafting-'));
});

// The agent's one `files('drawings')` grant: `fileScope` is what narrows it per designer.
const search = createFileSearch({ root: DATA, grants: ['drawings'] });
const claudeEngine =
  typeof agentDefinition.engine === 'object' && agentDefinition.engine.id === 'claude-agent-sdk'
    ? agentDefinition.engine
    : undefined;
// The gates are the agent definition's own, as the engine applies them.
const desk = (script: Script) =>
  scriptedWorkspace(
    script,
    {},
    { search_files: search.call },
    { requireApproval: claudeEngine?.requireApproval },
  );

/** A drawing's workspace path: `drawings/<series>/<number>.dxf`. */
const drawingPath = (drawingNo: string): string =>
  `drawings/${drawingNo.split('-')[0] ?? ''}/${drawingNo}.dxf`;

const readDrawing = (drawingNo: string): Promise<Buffer> =>
  readFile(path.join(DATA, drawingPath(drawingNo)));

/** The paths a `search_files` result lists. */
const pathsOf = (result: { readonly text: string }): string[] =>
  (JSON.parse(result.text) as Hit[]).map((hit) => hit.path);

/** How far a past drawing is from the request: relative outline gap, plus a material mismatch. */
const distance = (drawing: DrawingSummary, wanted: Requirements): number =>
  (Math.abs(drawing.width - wanted.width) / wanted.width +
    Math.abs(drawing.height - wanted.height) / wanted.height) /
    2 +
  (drawing.material === wanted.material ? 0 : 0.25);

/** What the office-reader skill prints for a past drawing: the base the draft script works from. */
const drawingOf = async (drawingNo: string) => readDxf(await readDrawing(drawingNo));

/** The office-reader output for a past drawing, saved where the script reads its base from. */
async function baseFile(drawingNo: string): Promise<string> {
  const file = path.join(work, `${drawingNo}.base.json`);
  await writeFile(file, JSON.stringify(await drawingOf(drawingNo)));
  return file;
}

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

const answerFor = (changeSet: ChangeSet): string =>
  [
    `${changeSet.base} から高さと穴位置を変更しました。`,
    '未検図です。出図前に検図してください。',
  ].join('\n');

/**
 * What a model following `agents/cad-drafting.md` does. The first run: `search_files`, the closest
 * past drawing, and the one gated `Write` of the change set, where the engine stops it for approval.
 * After a rejection it revises (a comment like "BRK-1004 を元に" names the base) and writes again;
 * after an approval it makes the same `Write`, runs `draft` and answers. `edit` lets a test make the
 * model sloppy (invent a dimension) in the change set it writes to check the backend catches it;
 * `scripted` changes what the model passes to the skill script, so the file it leaves in `outputs/`
 * can differ from what it wrote. Tool results are real, and so is `draft()`: it is the script the
 * agent runs.
 */
function designer(
  edit: (changeSet: ChangeSet) => ChangeSet = (changeSet) => changeSet,
  requirements: Requirements = REQUIREMENTS,
  scripted: (changeSet: ChangeSet) => ChangeSet = (changeSet) => changeSet,
) {
  let chosen = '';
  return async (context: ScriptContext): Promise<ScriptAnswer> => {
    if (!/^(approved|rejected)/u.test(context.prompt)) {
      const found = await context.builtin('search_files', { query: requirements.partName });
      const candidates = await Promise.all(
        [...new Set(pathsOf(found))].map(async (file) =>
          summarise(readDxf(await readFile(path.join(DATA, file)))),
        ),
      );
      candidates.sort((a, b) => distance(a, requirements) - distance(b, requirements));
      chosen = candidates[0]?.drawingNo ?? '';
    } else {
      // A continuation continues the session: the agent remembers its base unless told another.
      chosen = /([A-Z]{2,4}-\d{4}) を元に/u.exec(context.prompt)?.[1] ?? chosen;
    }
    const base = summarise(await drawingOf(chosen));
    const changeSet = changeSetFor(requirements, base);
    const said = edit(changeSet);
    await context.native('Write', changesWrite(requirements, said));
    if (context.prompt !== 'approved')
      throw new Error('the change set should have stopped at its Write');
    const answer = answerFor(said);
    try {
      const { dxf } = draft(await drawingOf(chosen), {
        drafter: requirements.drafter,
        date: requirements.date,
        ...scripted(changeSet),
      });
      context.write(`${requirements.drawingNo}.dxf`, dxf);
      return answer;
    } catch (error) {
      if (!(error instanceof DraftRefused)) throw error;
      return `${answer}\nスクリプトが拒否しました: ${error.problems.join(' / ')}`;
    }
  };
}

/** The `Write` of the change set the agent makes, as the engine reports its input. */
const changesWrite = (requirements: Requirements, changeSet: unknown): Record<string, unknown> => ({
  file_path: `drafts/${requirements.drawingNo}.changes.json`,
  content: JSON.stringify(changeSet, null, 2),
});

/** The desk the backend runs: the request, the access list and the drawing store. */
const deskOf = (requirements: Requirements = REQUIREMENTS, access: AccessList = ACCESS) => ({
  requirements,
  access,
  readDrawing,
});

/** The backend's proposal for `workspace`, which the test expects to be approvable. */
async function proposed(
  workspace: ReturnType<typeof desk>,
  requirements: Requirements = REQUIREMENTS,
): Promise<DraftAwaitingApproval> {
  const proposal = await proposeDraft(workspace.aw, workspace.agentId, deskOf(requirements));
  if (proposal.status !== 'awaiting_approval') {
    throw new Error(`nothing to approve: ${proposal.problems.join('; ')}`);
  }
  return proposal;
}

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
    // The skill script runs unattended; the change set's Write waits for the designer (ADR-0145).
    expect(definition?.policy).toMatchObject({
      tools: {
        permissionMode: 'default',
        autoApprove: [
          'mcp__agent-workspace__run_skill_script',
          'mcp__agent-workspace__search_files',
        ],
      },
      requireApproval: ['Write'],
    });
    expect(definition?.resources).toMatchObject({
      connectors: [],
      skills: ['office-reader', 'dxf-draft'],
      files: [
        { path: 'drawings', access: 'read' },
        { path: 'drafts', access: 'read-write' },
      ],
    });
    expect(agent?.body.surfaces?.map((surface) => surface.name)).toStrictEqual(['design-desk']);
    expect(project.surfaces[0]?.layout).toBe('page');
    expect(agent?.body.surfaces).toMatchObject([{ parts: { attachments: true } }]);
    expect(definition?.agent.instructions).toContain('未検図');
    expect(definition?.agent.instructions).toContain('`search_files`');
    // The reply's bullets are the script's own `changes` and `kept` lines.
    expect(definition?.agent.instructions).toContain('`changes` を変更点の箇条書きにそのまま写し');
    expect(definition?.agent.instructions).toContain('元図と値が違う項目だけ');
    // ...and its change set is the script's `changeSet`, pasted, not composed by the model.
    expect(definition?.agent.instructions).toContain('`changeSet`');
    expect(project.skills.map((skill) => skill.name).sort()).toStrictEqual([
      'dxf-draft',
      'office-reader',
    ]);
    expect(
      project.skills
        .find((skill) => skill.name === 'dxf-draft')
        ?.files.map((file) => file.path)
        .sort(),
    ).toStrictEqual(['SKILL.md', 'scripts/dxf.d.mts', 'scripts/dxf.mjs']);
    expect(project.project.policy?.permissions?.unrestrictedNetwork).toBe(false);
  });

  it('the eval file pins the candidates, the 未検図 mark, the refusals and the change-set geometry', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(5);
    const geometry = cases.filter((entry) => entry.outputSchema !== undefined);
    expect(geometry).toHaveLength(1);
    expect(geometry[0]?.expect.output).toMatchObject({ width: 140, height: 90 });
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
    expect(cases.some((entry) => entry.expect.contains?.includes('未検図'))).toBe(true);
    expect(cases.filter((entry) => entry.expect.judge !== undefined)).toHaveLength(3);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('every past drawing is a DXF office-reader reads and the skill summarises', async () => {
    for (const drawingNo of [
      'BRK-1001',
      'BRK-1002',
      'BRK-1003',
      'BRK-1004',
      'PLT-2001',
      'CVR-3002',
    ]) {
      const summary = summarise(await drawingOf(drawingNo));
      expect(summary).toMatchObject({ version: 'AC1027', drawingNo, status: '出図' });
      expect(summary.unreadEntities).toStrictEqual([]);
    }
    expect(summarise(await drawingOf('BRK-1003'))).toMatchObject({
      partName: 'ブラケット',
      material: 'SUS304',
      thickness: 't2.0',
      origin: { x: 50, y: 50 },
      width: 140,
      height: 80,
      rectangular: true,
    });
    expect(summarise(await drawingOf('BRK-1004')).rectangular).toBe(false);
  });

  it('the skill script drafts a DXF that re-parses with exactly the requested geometry', async () => {
    const changes = path.join(work, 'BRK-1101.changes.json');
    const out = path.join(work, 'BRK-1101.dxf');
    const base = summarise(await drawingOf('BRK-1003'));
    await writeFile(
      changes,
      JSON.stringify({ ...changeSetFor(REQUIREMENTS, base), drafter: '高橋', date: '2026-10-04' }),
    );
    const { stdout } = await run(process.execPath, [
      SCRIPT,
      'draft',
      await baseFile('BRK-1003'),
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
    const written = summarise(readDxf(await readFile(out)));
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
      version: 'AC1027',
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

    // Holes left out keep the base's.
    await writeFile(
      changes,
      JSON.stringify({ base: 'BRK-1001', drawingNo: 'BRK-1102', width: 130, height: 60 }),
    );
    await run(process.execPath, [SCRIPT, 'draft', await baseFile('BRK-1001'), changes, out]);
    const kept = summarise(readDxf(await readFile(out)));
    expect(kept).toMatchObject({ width: 130, height: 60, material: 'SS400', thickness: 't3.2' });
    expect(kept.holes).toStrictEqual(summarise(await drawingOf('BRK-1001')).holes);
  });

  it('a change set that repeats the base values reports them as kept, not as changes', async () => {
    const base = summarise(await drawingOf('BRK-1003'));
    const chatty = {
      ...changeSetFor(REQUIREMENTS, base),
      material: 'SUS304',
      thickness: 2.0,
      partName: 'ブラケット',
    };
    const { changes, kept, changeSet } = draft(await drawingOf('BRK-1003'), chatty);
    // The printed change set drops every field the request merely repeats.
    expect(changeSet).toStrictEqual(changeSetFor(REQUIREMENTS, base));
    expect(
      draft(await drawingOf('BRK-1003'), { ...chatty, holes: base.holes }).changeSet,
    ).toStrictEqual({ base: 'BRK-1003', drawingNo: 'BRK-1101', width: 140, height: 90 });
    expect(changes).toStrictEqual([
      '高さ 80 → 90',
      '穴 (15,65)φ9 → (15,75)φ9',
      '穴 (125,65)φ9 → (125,75)φ9',
    ]);
    expect(kept).toContain('材質 SUS304（元図のまま）');
    expect(kept).toContain('板厚 t2.0（元図のまま）');
    expect(changes.join('\n')).not.toMatch(/SUS304|t2\.0|幅/u);
    const other = draft(await drawingOf('BRK-1003'), {
      ...chatty,
      material: 'SS400',
      holes: [{ x: 15, y: 15, diameter: 9 }],
    });
    expect(other.changes).toContain('材質 SUS304 → SS400');
    expect(other.changeSet).toMatchObject({ material: 'SS400' });
    expect(other.changes.filter((line) => line.includes('削除'))).toHaveLength(3);
  });

  it('moved holes pair by position, not by the order the change set lists them in', async () => {
    const base = summarise(await drawingOf('BRK-1003'));
    const ordered = changeSetFor(REQUIREMENTS, base);
    const swapped = { ...ordered, holes: [...(ordered.holes ?? [])].reverse() };
    expect(draft(await drawingOf('BRK-1003'), swapped).changes).toStrictEqual([
      '高さ 80 → 90',
      '穴 (15,65)φ9 → (15,75)φ9',
      '穴 (125,65)φ9 → (125,75)φ9',
    ]);
  });

  it('a title field the base and the draft both lack is left out, never printed as null', async () => {
    const base = { ...summarise(await drawingOf('BRK-1003')), partName: null };
    const { changes, kept } = describeChanges(base, { ...base, height: base.height + 10 });
    expect([...changes, ...kept].join('\n')).not.toContain('null');
    expect(kept.some((line) => line.startsWith('品名'))).toBe(false);
  });

  it('a field the base lacks and the draft sets is an addition, never null → X', async () => {
    const base = { ...summarise(await drawingOf('BRK-1003')), partName: null };
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
        await baseFile(base),
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
        base: 'drawings/BRK/BRK-1001.dxf',
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

  it('the skill script refuses a base with an entity it cannot read, and a base that is not office-reader output', async () => {
    const changes = path.join(work, 'unread.changes.json');
    const out = path.join(work, 'unread.dxf');
    const asked = { base: 'BRK-1003', drawingNo: 'BRK-1105', width: 140, height: 90 };
    await writeFile(changes, JSON.stringify(asked));
    const withArc = { ...(await drawingOf('BRK-1003')), counts: { LINE: 4, CIRCLE: 4, ARC: 1 } };
    expect(() => draft(withArc, asked)).toThrow(/BRK-1003 には ARC が含まれます/u);
    const withBlock = { ...(await drawingOf('BRK-1003')), blocks: ['FRAME'] };
    expect(() => draft(withBlock, asked)).toThrow(/BLOCK が含まれます/u);

    const text = path.join(work, 'BRK-1003.dxf');
    await cp(path.join(DATA, drawingPath('BRK-1003')), text);
    const failed = await run(process.execPath, [SCRIPT, 'draft', text, changes, out]).then(
      () => null,
      (error: unknown) => error as { code: number; stderr: string },
    );
    expect(failed?.code).toBe(1);
    expect(failed?.stderr).toContain(
      'the base must be the JSON that the office-reader skill prints',
    );
  });

  it('the agent finds similar drawings with search_files and ships no index server', async () => {
    // No connector, and no hosted server of ours: the platform reads the DXF title block itself.
    expect(project.agents[0]?.body.definition?.resources).toMatchObject({ connectors: [] });
    expect(existsSync(path.join(DIR, 'mcp'))).toBe(false);
    expect(search.searchablePaths().sort()).toStrictEqual([
      'drawings/BRK/BRK-1001.dxf',
      'drawings/BRK/BRK-1002.dxf',
      'drawings/BRK/BRK-1003.dxf',
      'drawings/BRK/BRK-1004.dxf',
      'drawings/CVR/CVR-3002.dxf',
      'drawings/PLT/PLT-2001.dxf',
    ]);

    const hitsOf = async (query: string): Promise<string[]> => {
      const result = await search.call({ query });
      expect(result.isError).toBe(false);
      return pathsOf(result).sort();
    };
    expect(await hitsOf('ブラケット')).toStrictEqual([
      'drawings/BRK/BRK-1001.dxf',
      'drawings/BRK/BRK-1002.dxf',
      'drawings/BRK/BRK-1003.dxf',
      'drawings/BRK/BRK-1004.dxf',
    ]);
    // Full-width input in the query still lands on the plate.
    expect(await hitsOf('取付プレート　ＳＰＣＣ')).toStrictEqual(['drawings/PLT/PLT-2001.dxf']);
    const [material] = JSON.parse(
      (await search.call({ query: 'ブラケット SUS304' })).text,
    ) as Hit[];
    expect(material?.path).toBe('drawings/BRK/BRK-1003.dxf');
    // An unrelated part name returns nothing rather than the least-bad drawing.
    expect(await hitsOf('油圧シリンダ')).toStrictEqual([]);
    expect((await search.call({ query: '？' })).isError).toBe(true);

    // The model reads what it found and writes its change set from the closest drawing.
    const workspace = desk(designer());
    const proposal = await proposed(workspace);
    const searched = proposal.toolCalls.find((call) => call.name.endsWith('__search_files'));
    expect(pathsOf({ text: searched?.output ?? '[]' }).sort()).toStrictEqual([
      'drawings/BRK/BRK-1001.dxf',
      'drawings/BRK/BRK-1002.dxf',
      'drawings/BRK/BRK-1003.dxf',
      'drawings/BRK/BRK-1004.dxf',
    ]);
    expect(proposal.changeSet.base).toBe('BRK-1003');
  });

  it('a designer reaches only the drawing series access.json gives them, by fileScope and not by prompt text', async () => {
    let seen = '';
    const everyTitleBlock: Script = async ({ builtin }) => {
      seen = (await builtin('search_files', { query: '図番' })).text;
      return seen;
    };
    const asked = async (drafter: string) => {
      const workspace = desk(everyTitleBlock);
      // The prompt names the first designer; only the run's subject and scope decide.
      await proposeDraft(
        workspace.aw,
        workspace.agentId,
        deskOf({ ...REQUIREMENTS, drafter, partName: DESIGNER }),
      );
      return { paths: pathsOf({ text: seen }), run: workspace.runs[0] };
    };

    const first = await asked(DESIGNER);
    expect(first.run).toMatchObject({
      subject: DESIGNER,
      fileScope: ['drawings/BRK', 'drawings/PLT', 'drawings/CVR'],
    });
    expect(first.paths.sort()).toStrictEqual([
      'drawings/BRK/BRK-1001.dxf',
      'drawings/BRK/BRK-1002.dxf',
      'drawings/BRK/BRK-1003.dxf',
      'drawings/BRK/BRK-1004.dxf',
      'drawings/CVR/CVR-3002.dxf',
      'drawings/PLT/PLT-2001.dxf',
    ]);

    // The second designer may use the PLT series only: nothing else is searched, so no bracket
    // or cover drawing, nor any word of theirs, reaches the model.
    const second = await asked(OTHER_DESIGNER);
    expect(second.run).toMatchObject({ subject: OTHER_DESIGNER, fileScope: ['drawings/PLT'] });
    expect(second.paths).toStrictEqual(['drawings/PLT/PLT-2001.dxf']);
    expect(seen).toContain('PLT-2001');
    expect(seen).not.toMatch(/BRK-|CVR-|ブラケット/u);
    expect(
      pathsOf(await search.call({ query: 'ブラケット' }, { fileScope: ['drawings/PLT'] })),
    ).toStrictEqual([]);

    // The continuation keeps the same scope and subject (ADR-0157).
    const workspace = desk(designer());
    const outcome = await decideDraft(workspace.aw, await proposed(workspace), { approve: true });
    expect(outcome.status).toBe('ready-for-check');
    for (const entry of workspace.runs) {
      expect(entry).toMatchObject({
        subject: DESIGNER,
        fileScope: ['drawings/BRK', 'drawings/PLT', 'drawings/CVR'],
      });
    }

    // A designer with nothing accessible is refused before any run, never given an unscoped one.
    const none: AccessList = { ...ACCESS, 新人: { series: [] } };
    for (const drafter of ['新人', '見知らぬ人']) {
      const refused = desk(designer());
      await expect(
        proposeDraft(refused.aw, refused.agentId, deskOf({ ...REQUIREMENTS, drafter }, none)),
      ).rejects.toThrow(NoDrawingAccess);
      expect(refused.runs).toHaveLength(0);
    }

    // A change set that names a drawing outside the designer's series pauses nothing to approve.
    const elsewhere = desk(async ({ native }) => {
      const base = summarise(await drawingOf('BRK-1003'));
      await native('Write', changesWrite(REQUIREMENTS, changeSetFor(REQUIREMENTS, base)));
      return 'unreachable';
    });
    const outside = await proposeDraft(
      elsewhere.aw,
      elsewhere.agentId,
      deskOf({ ...REQUIREMENTS, drafter: OTHER_DESIGNER }),
    );
    expect(outside).toMatchObject({
      status: 'refused',
      problems: ['中村 は BRK-1003 を使えません'],
    });
    expect(() => fileScopeOf(ACCESS, '__proto__')).toThrow(NoDrawingAccess);
  });

  it('the backend pauses on the change set before anything is drawn, and drafts it once approved, marked 未検図', async () => {
    const workspace = desk(designer());
    const proposal = await proposed(workspace);
    expect(workspace.runs[0]?.prompt).toContain('外形: 幅 140 × 高さ 90 mm');
    expect(workspace.runs[0]?.outputSchema).toBeNull();
    // The pause carries the agent's change set from the Write, validated: only height and holes changed.
    expect(proposal.call.toolName).toBe('Write');
    expect(Object.keys(proposal.changeSet).sort()).toStrictEqual([
      'base',
      'drawingNo',
      'height',
      'holes',
      'width',
    ]);
    expect(proposal.changeSet.base).toBe('BRK-1003');

    // The designer approves; the continuation is the same session and the same Write.
    const outcome = await decideDraft(workspace.aw, proposal, { approve: true });
    expect(workspace.runs[1]).toMatchObject({
      prompt: 'approved',
      sessionId: workspace.runs[0]?.sessionId,
      approvedToolCalls: [{ toolName: 'Write' }],
    });
    expect(outcome.status).toBe('ready-for-check');
    if (outcome.status !== 'ready-for-check') return;
    expect(outcome.sessionId).toBe(proposal.sessionId);
    expect(outcome.changeSet).toStrictEqual(proposal.changeSet);
    expect(summarise(readDxf(Buffer.from(outcome.dxf)))).toMatchObject({
      drawingNo: 'BRK-1101',
      width: 140,
      height: 90,
      status: '未検図',
      derivedFrom: 'BRK-1003',
    });
    expect(outcome.summary.title['作成']).toBe('2026-10-04 高橋');
  });

  it('a rejection that names another base sends it back, and the revised change set pauses again', async () => {
    const workspace = desk(designer());
    const first = await proposed(workspace);
    expect(first.changeSet.base).toBe('BRK-1003');

    const second = await decideDraft(workspace.aw, first, {
      approve: false,
      comment: 'BRK-1004 を元に',
    });
    expect(workspace.runs[1]).toMatchObject({
      prompt: 'rejected: BRK-1004 を元に',
      approvedToolCalls: [],
    });
    expect(second.status).toBe('awaiting_approval');
    if (second.status !== 'awaiting_approval') return;
    expect(second.changeSet.base).toBe('BRK-1004');
    expect(second.runId).not.toBe(first.runId);
    expect((await workspace.aw.runs.get(second.runId)).status).toBe('awaiting_approval');
    expect(await workspace.aw.runs.outputs(second.runId)).toStrictEqual([]);

    // The script refuses a notched outline it would have to stretch: the agent writes no file, and
    // the backend refuses rather than draw one itself.
    const notched = await decideDraft(workspace.aw, second, { approve: true });
    expect(notched).toMatchObject({
      status: 'refused',
      problems: ['エージェントが outputs/BRK-1101.dxf を書いていません'],
    });
    if (notched.status !== 'refused') return;
    expect(notched.answer).toContain('BRK-1004 の外形は矩形ではありません');
    expect('dxf' in notched).toBe(false);
  });

  it('nothing is drafted before approval, and a rejection drafts nothing', async () => {
    const workspace = desk(designer());
    const proposal = await proposed(workspace);
    expect(workspace.runs).toHaveLength(1);
    expect(workspace.runs[0]?.approvedToolCalls).toStrictEqual([]);
    expect((await workspace.aw.runs.get(proposal.runId)).status).toBe('awaiting_approval');
    expect(await workspace.aw.runs.outputs(proposal.runId)).toStrictEqual([]);

    const revised = await decideDraft(workspace.aw, proposal, {
      approve: false,
      comment: '高さを確認してから',
    });
    expect(revised.status).toBe('awaiting_approval');
    for (const entry of workspace.runs) {
      expect(await workspace.aw.runs.outputs(entry.id)).toStrictEqual([]);
    }
  });

  it('a reference drawing rides on the proposal run as an attachment, and none is sent without one', async () => {
    const workspace = desk(designer());
    const referenceId = 'a0000000-0000-4000-8000-000000000007';

    await proposeDraft(workspace.aw, workspace.agentId, deskOf(), { fileId: referenceId });
    await proposeDraft(workspace.aw, workspace.agentId, deskOf());

    const starts = workspace.calls
      .filter((call) => call.method === 'POST')
      .map((call) => call.json as { prompt: string; attachments?: unknown });
    expect(starts[0]?.attachments).toStrictEqual([{ fileId: referenceId }]);
    expect(starts[0]?.prompt).toContain('外形: 幅 140 × 高さ 90 mm');
    expect(starts[1]).not.toHaveProperty('attachments');
  });

  it('the backend returns the DXF the agent wrote, not one it regenerates', async () => {
    const stamped = (changeSet: ChangeSet): ChangeSet => ({
      ...changeSet,
      drafter: 'エージェント',
      date: '2026-10-05',
    });
    const workspace = desk(designer((changeSet) => changeSet, REQUIREMENTS, stamped));
    const outcome = await decideDraft(workspace.aw, await proposed(workspace), { approve: true });
    expect(outcome.status).toBe('ready-for-check');
    if (outcome.status !== 'ready-for-check') return;
    // Regenerating from the requirements would stamp 2026-10-04 高橋; these are the agent's bytes.
    const [written] = await workspace.aw.runs.outputs(workspace.runs[1]?.id ?? '');
    expect(written?.name).toBe('BRK-1101.dxf');
    expect(outcome.dxf).toBe(
      draft(
        await drawingOf('BRK-1003'),
        stamped(changeSetFor(REQUIREMENTS, summarise(await drawingOf('BRK-1003')))),
      ).dxf,
    );
    expect(outcome.summary.title['作成']).toBe('2026-10-05 エージェント');
  });

  it('the backend refuses a DXF the agent wrote that does not parse, instead of throwing', async () => {
    const script = designer();
    const workspace = desk((context) =>
      script({ ...context, write: (name) => context.write(name, 'not a dxf') }),
    );
    const outcome = await decideDraft(workspace.aw, await proposed(workspace), { approve: true });
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.problems).toHaveLength(1);
    expect(outcome.problems[0]).toMatch(/^outputs\/BRK-1101\.dxf を図面として読めません: /u);
  });

  it('the backend validates the change set in the paused Write and refuses one that invents a dimension before anyone approves it', async () => {
    const workspace = desk(designer((changeSet) => ({ ...changeSet, width: 145 })));
    const outcome = await proposeDraft(workspace.aw, workspace.agentId, deskOf());
    // The run asks for no schema: the change set is the Write's content, untrusted until validated.
    expect(workspace.runs[0]?.outputSchema).toBeNull();
    expect(outcome).toMatchObject({
      status: 'refused',
      changeSet: { width: 145 },
      runId: workspace.runs[0]?.id,
    });
    if (outcome.status !== 'refused') return;
    expect(outcome.problems[0]).toBe('幅: 要件は 140、作図は 145');
    expect(workspace.runs).toHaveLength(1);
  });

  it('the backend refuses a paused Write that is not the change set, whatever it holds', async () => {
    const paused = async (write: Record<string, unknown>) => {
      const workspace = desk(async ({ native }) => {
        await native('Write', write);
        return 'unreachable';
      });
      return proposeDraft(workspace.aw, workspace.agentId, deskOf());
    };
    const file = 'drafts/BRK-1101.changes.json';
    const base = summarise(await drawingOf('BRK-1003'));
    const good = changeSetFor(REQUIREMENTS, base);

    expect(await paused({ file_path: 'drafts/other.json', content: '{}' })).toMatchObject({
      status: 'refused',
      problems: [`Write が ${file} 以外を書こうとして止まった`],
    });
    expect(await paused({ file_path: file, content: 'not json' })).toMatchObject({
      status: 'refused',
      problems: [`${file} が JSON ではない`],
    });
    expect(await paused({ file_path: file, content: '{"base":"BRK-1003"}' })).toMatchObject({
      status: 'refused',
      changeSet: null,
    });
    // A path is not a drawing number: the schema refuses it before anything is read.
    const asPath = await paused({
      file_path: file,
      content: JSON.stringify({ ...good, base: 'drawings/BRK/BRK-1003.dxf' }),
    });
    expect(asPath).toMatchObject({ status: 'refused', changeSet: null });
    // A well-formed number the store does not hold is invented too.
    expect(
      await paused({ file_path: file, content: JSON.stringify({ ...good, base: 'BRK-9999' }) }),
    ).toMatchObject({ status: 'refused', problems: ['BRK-9999 は図面庫にありません'] });
  });

  it('the backend refuses a draft that invents a dimension, stretches a notched outline or loses a hole', async () => {
    // The model writes 145 where the designer asked for 140, and moves a hole.
    const sloppy = desk(
      designer((changeSet) => ({
        ...changeSet,
        width: 145,
        holes: (changeSet.holes ?? []).map((hole, at) => (at === 1 ? { ...hole, x: 130 } : hole)),
      })),
    );
    const invented = await proposeDraft(sloppy.aw, sloppy.agentId, deskOf());
    expect(invented).toMatchObject({ status: 'refused' });
    if (invented.status !== 'refused') return;
    expect(invented.problems[0]).toBe('幅: 要件は 140、作図は 145');
    expect(invented.problems[1]).toMatch(/^取付穴: 要件・元図にない穴があります/u);

    // A requirement whose hole would cut the edge is refused before anyone is asked to approve.
    const cutting: Requirements = {
      ...REQUIREMENTS,
      holes: {
        diameter: 11,
        positions: [
          { x: 15, y: 15 },
          { x: 136, y: 15 },
        ],
      },
    };
    const edgeWorkspace = desk(designer((changeSet) => changeSet, cutting));
    const edge = await proposeDraft(edgeWorkspace.aw, edgeWorkspace.agentId, deskOf(cutting));
    expect(edge).toMatchObject({
      status: 'refused',
      problems: ['穴2 (136, 15) φ11: 外形 140×90 からはみ出します'],
    });

    // A DXF whose width is not what the change set says (the file is what is delivered) is refused.
    const wrongFile = desk(
      designer(
        (changeSet) => changeSet,
        REQUIREMENTS,
        (changeSet) => ({ ...changeSet, width: 145 }),
      ),
    );
    const stretched = await decideDraft(wrongFile.aw, await proposed(wrongFile), {
      approve: true,
    });
    expect(stretched).toMatchObject({ status: 'refused' });
    if (stretched.status !== 'refused') return;
    expect(stretched.problems).toContain('幅: 要件は 140、作図は 145');

    // An answer with no change set is not guessed at: there is nothing to approve.
    const silent = desk(() => Promise.resolve('作図しました。'));
    expect(await proposeDraft(silent.aw, silent.agentId, deskOf())).toMatchObject({
      status: 'refused',
      problems: ['エージェントが変更セットを書かずに終わりました'],
      changeSet: null,
    });
  });
});
