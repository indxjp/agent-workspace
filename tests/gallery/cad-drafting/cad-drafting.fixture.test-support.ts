/**
 * The CAD drawing agent's shared fixture: the loaded project, the request, the scripted designer
 * model and the helpers the case modules use.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readDxf } from '@agent-workspace/skills-office/office-reader/scripts/dxf.mjs';
import { beforeAll } from 'vitest';

import { createFileSearch } from '../harness/file-search.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type ScriptAnswer,
  type Script,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import {
  proposeDraft,
  type AccessList,
  type DraftAwaitingApproval,
  type Requirements,
} from './backend/draft.ts';
import {
  DraftRefused,
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

/** What the skill script's `draft` prints: the written drawing's summary, its change set and lines. */
type PrintedDraft = DrawingSummary & {
  changeSet: ChangeSet;
  changes: string[];
  kept: string[];
};

/**
 * Runs the skill script's `draft` on `baseNo`'s office-reader output with `changeSet`, saved as
 * `<name>.changes.json`, into `<name>.dxf`; returns what it printed and the DXF it wrote, re-read.
 */
async function scriptDraft(
  baseNo: string,
  changeSet: object,
  name: string,
): Promise<{ printed: PrintedDraft; written: DrawingSummary }> {
  const changes = path.join(work, `${name}.changes.json`);
  const out = path.join(work, `${name}.dxf`);
  await writeFile(changes, JSON.stringify(changeSet));
  const { stdout } = await run(process.execPath, [
    SCRIPT,
    'draft',
    await baseFile(baseNo),
    changes,
    out,
  ]);
  return {
    printed: JSON.parse(stdout) as PrintedDraft,
    written: summarise(readDxf(await readFile(out))),
  };
}

/** Runs the skill script's `draft` on a base file; resolves to how it failed, or null if it did not. */
const failedDraft = (
  base: string,
  changes: string,
  out: string,
): Promise<{ code: number; stderr: string } | null> =>
  run(process.execPath, [SCRIPT, 'draft', base, changes, out]).then(
    () => null,
    (error: unknown) => error as { code: number; stderr: string },
  );

/**
 * Proposes a draft for `drafter`, whose prompt names the first designer, with a model that
 * searches every title block; returns what the search returned and the run it started.
 */
async function titleBlocksSearchedBy(drafter: string) {
  let seen = '';
  const workspace = desk(async ({ builtin }) => {
    seen = (await builtin('search_files', { query: '図番' })).text;
    return seen;
  });
  // The prompt names the first designer; only the run's subject and scope decide.
  await proposeDraft(
    workspace.aw,
    workspace.agentId,
    deskOf({ ...REQUIREMENTS, drafter, partName: DESIGNER }),
  );
  return { seen, paths: pathsOf({ text: seen }), run: workspace.runs[0] };
}

/** The PLT-only designer's proposal when the model writes a change set from BRK-1003 anyway. */
function proposalOutsideSeries() {
  const elsewhere = desk(async ({ native }) => {
    const base = summarise(await drawingOf('BRK-1003'));
    await native('Write', changesWrite(REQUIREMENTS, changeSetFor(REQUIREMENTS, base)));
    return 'unreachable';
  });
  return proposeDraft(
    elsewhere.aw,
    elsewhere.agentId,
    deskOf({ ...REQUIREMENTS, drafter: OTHER_DESIGNER }),
  );
}

export {
  DIR,
  DATA,
  DESIGNER,
  OTHER_DESIGNER,
  ACCESS,
  type Hit,
  REQUIREMENTS,
  project,
  work,
  search,
  desk,
  drawingPath,
  pathsOf,
  drawingOf,
  baseFile,
  changeSetFor,
  designer,
  deskOf,
  proposed,
  scriptDraft,
  failedDraft,
  titleBlocksSearchedBy,
  proposalOutsideSeries,
};
