/**
 * The design desk's backend: ask the agent for a drawing like the one a designer needs, show the
 * designer the change set it proposes, and refuse any draft that is not exactly what was asked.
 *
 * One run chain. The agent searches, picks the closest past drawing, reads it with office-reader
 * (which saves the JSON itself, so no `Write`) and then `Write`s the change set to
 * `drafts/<new number>.changes.json`. That `Write` is the chain's only gated call (ADR-0145), so
 * the run pauses on it and nothing is drafted: `proposeDraft` answers the pause with the change set.
 * The designer decides with `decideDraft`: approving starts a continuation that makes the same
 * `Write`, runs `draft` and leaves the DXF in `outputs/`; rejecting with a comment ("BRK-1004 を元に")
 * sends it back to the agent, and the revised change set pauses again.
 *
 * Nothing the agent wrote is trusted. The paused `Write` is untrusted JSON until it parses as a
 * change set and is compared field by field with the requirements and the base drawing (a dimension
 * in neither is an invented one), before anyone is asked to approve it. After the approval the DXF
 * the agent wrote to its `outputs/` is read back from the run (`runs.outputs`) and parsed, so the
 * geometry is checked as written. The backend produces no drawing itself.
 *
 * Who may see which drawings: they live at `drawings/<series>/<number>.dxf`, and the run carries
 * `fileScope` = the `drawings/<series>` folders `access` gives the signed-in designer, so the
 * platform's `search_files` and the sandbox hold nothing else; the continuation keeps that scope and
 * the designer as its `subject` (ADR-0157). A designer with no series gets no run, and a change set
 * that names a base outside their series is refused.
 */
import { readDxf } from '@agent-workspace/skills-office/office-reader/scripts/dxf.mjs';
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { z } from 'zod';

import {
  pendingCall,
  readRun,
  runAndRead,
  RunAwaitingApproval,
  type AwaitingApproval,
  type RunReading,
} from '../../shared/run-answer.ts';
import {
  holeProblems,
  summarise,
  type ChangeSet,
  type DrawingSummary,
  type Hole,
} from '../skills/dxf-draft/scripts/dxf.mjs';

/** What the designer asks for; every dimension in mm. */
export interface Requirements {
  readonly partName: string;
  readonly width: number;
  readonly height: number;
  readonly material: string;
  /** Sheet thickness, as in 板厚 t2.0. */
  readonly thickness: number;
  /** Mounting holes from the outline's lower-left corner; leave out to keep the base drawing's. */
  readonly holes?: {
    readonly diameter: number;
    readonly positions: readonly { readonly x: number; readonly y: number }[];
  };
  /** The new drawing number the designer reserved. */
  readonly drawingNo: string;
  /** The signed-in designer: stamped on the drawing and the run's `subject`; `access` sets their `fileScope`. */
  readonly drafter: string;
  readonly date: string;
}

/** `data/access.json`: the drawing-number series (BRK in BRK-1003) each designer may use. */
export type AccessList = Readonly<Record<string, { readonly series: readonly string[] }>>;

/** A designer the access list gives no drawing series: no run is started for them. */
export class NoDrawingAccess extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'NoDrawingAccess';
  }
}

/** What the desk's backend holds beside the platform: the request, who may see what, the drawing store. */
export interface Desk {
  readonly requirements: Requirements;
  readonly access: AccessList;
  /** Reads a base DXF from your drawing store (PDM, file server), by number. */
  readonly readDrawing: (drawingNo: string) => Promise<Buffer>;
}

/** The run paused on the change set's `Write`; decide it with {@link decideDraft}. */
export interface DraftAwaitingApproval extends AwaitingApproval {
  /** The change set in the paused `Write`, validated: what the designer approves. */
  readonly changeSet: ChangeSet;
  /** The base drawing the change set names, read from the drawing store. */
  readonly base: DrawingSummary;
  readonly desk: Desk;
}

export interface DraftReady {
  readonly status: 'ready-for-check';
  readonly changeSet: ChangeSet;
  readonly dxf: string;
  readonly summary: DrawingSummary;
  readonly answer: string;
  readonly sessionId: string;
}

export interface DraftRefused {
  readonly status: 'refused';
  readonly problems: readonly string[];
  readonly changeSet: ChangeSet | null;
  readonly answer: string;
  /** The run the refusal is about; one still paused can be rejected with `runs.reject`. */
  readonly runId: string;
  readonly sessionId: string;
}

export type DraftOutcome = DraftAwaitingApproval | DraftReady | DraftRefused;

function formatHoles(holes: Requirements['holes']): string {
  if (holes === undefined) return '取付穴: 元図のまま';
  const positions = holes.positions.map(({ x, y }) => `${String(x)},${String(y)}`).join(' / ');
  return `取付穴: φ${String(holes.diameter)} × ${String(holes.positions.length)}か所（外形左下から ${positions}）`;
}

/** The requirements as the designer would type them into the desk. */
export function requirementsPrompt(requirements: Requirements): string {
  return [
    `品名: ${requirements.partName}`,
    `外形: 幅 ${String(requirements.width)} × 高さ ${String(requirements.height)} mm`,
    `材質: ${requirements.material} 板厚 t${requirements.thickness.toFixed(1)}`,
    formatHoles(requirements.holes),
    `新図番: ${requirements.drawingNo}（作成 ${requirements.date} ${requirements.drafter}）`,
  ].join('\n');
}

const DRAWING_NO = /^[A-Z]{2,4}-\d{4}$/u;
const seriesOf = (drawingNo: string): string => drawingNo.split('-')[0] ?? '';

/** The folders the designer may search and read, or a refusal before any run starts. */
export function fileScopeOf(access: AccessList, designer: string): string[] {
  const series = Object.hasOwn(access, designer) ? (access[designer]?.series ?? []) : [];
  if (series.length === 0) {
    throw new NoDrawingAccess(`${designer} は使える図面の系列がありません`);
  }
  return series.map((name) => `drawings/${name}`);
}

const HoleSchema = z.object({
  x: z.number().describe('外形左下からの X（mm）'),
  y: z.number().describe('外形左下からの Y（mm）'),
  diameter: z.number().describe('穴径 φ（mm）'),
});

/** What the agent changes in the base drawing; a field the request leaves alone is left out. */
export const ChangeSetSchema = z.object({
  base: z.string().regex(DRAWING_NO, '図番の形ではない').describe('元にした図面の図番'),
  drawingNo: z.string().describe('新図番'),
  width: z.number().describe('外形の幅（mm）'),
  height: z.number().describe('外形の高さ（mm）'),
  material: z.string().exactOptional().describe('材質。元図と同じなら省く'),
  thickness: z.number().exactOptional().describe('板厚（mm）。元図と同じなら省く'),
  partName: z.string().exactOptional().describe('品名。元図と同じなら省く'),
  holes: z.array(HoleSchema).exactOptional().describe('取付穴の全部。元図のままなら省く'),
  drafter: z.string().exactOptional().describe('作成者'),
  date: z.string().exactOptional().describe('作成日'),
});

const holeKey = (hole: Hole): string =>
  `${String(hole.x)},${String(hole.y)},φ${String(hole.diameter)}`;
const holeSet = (holes: readonly Hole[]): string => holes.map(holeKey).sort().join(' ');

const thicknessOf = (title: string | null): number | null => {
  const match = /^t?(\d+(?:\.\d+)?)$/u.exec(title ?? '');
  return match?.[1] === undefined ? null : Number(match[1]);
};

/**
 * Every way the final drawing would differ from what the designer asked for. A value is right when
 * it equals the requirement, or, where the requirements are silent, the base drawing's value.
 */
export function dimensionProblems(
  requirements: Requirements,
  base: DrawingSummary,
  drawn: {
    readonly drawingNo: string | null;
    readonly partName: string | null;
    readonly material: string | null;
    readonly thickness: number | null;
    readonly width: number;
    readonly height: number;
    readonly holes: readonly Hole[];
  },
): string[] {
  const problems: string[] = [];
  const expect = (label: string, wanted: unknown, got: unknown): void => {
    if (wanted !== got) problems.push(`${label}: 要件は ${String(wanted)}、作図は ${String(got)}`);
  };
  expect('図番', requirements.drawingNo, drawn.drawingNo);
  expect('品名', requirements.partName, drawn.partName);
  expect('材質', requirements.material, drawn.material);
  expect('板厚', requirements.thickness, drawn.thickness);
  expect('幅', requirements.width, drawn.width);
  expect('高さ', requirements.height, drawn.height);
  const wantedHoles =
    requirements.holes === undefined
      ? base.holes
      : requirements.holes.positions.map(({ x, y }) => ({
          x,
          y,
          diameter: requirements.holes?.diameter ?? 0,
        }));
  if (holeSet(wantedHoles) !== holeSet(drawn.holes)) {
    problems.push(
      `取付穴: 要件・元図にない穴があります（要件 ${holeSet(wantedHoles)}、作図 ${holeSet(drawn.holes)}）`,
    );
  }
  return problems;
}

const noChangeSet = (reading: RunReading): DraftRefused => ({
  status: 'refused',
  problems: ['エージェントが変更セットを書かずに終わりました'],
  changeSet: null,
  answer: reading.answer,
  runId: reading.run.id,
  sessionId: reading.run.sessionId,
});

/**
 * The change set in the call the run is paused on, checked before anyone is asked to approve it: it
 * must be the change set's file, parse as one, name a base the designer may use, and match the
 * requirements and that base.
 */
async function proposalFrom(
  paused: AwaitingApproval,
  desk: Desk,
): Promise<DraftAwaitingApproval | DraftRefused> {
  const { requirements } = desk;
  const file = `drafts/${requirements.drawingNo}.changes.json`;
  const refuse = (problems: string[], changeSet: ChangeSet | null): DraftRefused => ({
    status: 'refused',
    problems,
    changeSet,
    answer: '',
    runId: paused.runId,
    sessionId: paused.sessionId,
  });

  const { name, input } = pendingCall(paused.call);
  const content = input['content'];
  if (name !== 'Write' || input['file_path'] !== file || typeof content !== 'string') {
    return refuse([`${name} が ${file} 以外を書こうとして止まった`], null);
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return refuse([`${file} が JSON ではない`], null);
  }
  const parsed = ChangeSetSchema.safeParse(json);
  if (!parsed.success) {
    return refuse(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      null,
    );
  }
  const changeSet: ChangeSet = parsed.data;
  const scope = fileScopeOf(desk.access, requirements.drafter);
  if (!scope.includes(`drawings/${seriesOf(changeSet.base)}`)) {
    return refuse([`${requirements.drafter} は ${changeSet.base} を使えません`], changeSet);
  }

  let base: DrawingSummary;
  try {
    base = summarise(readDxf(await desk.readDrawing(changeSet.base)));
  } catch {
    return refuse([`${changeSet.base} は図面庫にありません`], changeSet);
  }
  const holes = changeSet.holes ?? base.holes;
  const problems = [
    ...dimensionProblems(requirements, base, {
      drawingNo: changeSet.drawingNo,
      partName: changeSet.partName ?? base.partName,
      material: changeSet.material ?? base.material,
      thickness: changeSet.thickness ?? thicknessOf(base.thickness),
      width: changeSet.width,
      height: changeSet.height,
      holes,
    }),
    ...holeProblems(changeSet.width, changeSet.height, holes),
  ];
  if (problems.length > 0) return refuse(problems, changeSet);
  return { ...paused, changeSet, base, desk };
}

/** Read a run that should pause on the change set: the next proposal, or a refusal. */
async function untilProposal(
  reading: Promise<RunReading>,
  desk: Desk,
): Promise<DraftAwaitingApproval | DraftRefused> {
  try {
    return noChangeSet(await reading);
  } catch (error) {
    if (!(error instanceof RunAwaitingApproval)) throw error;
    return proposalFrom(error.pending, desk);
  }
}

/**
 * Ask `agentId` for a drawing that fits the request. The agent's `Write` of the change set is gated,
 * so the answer is the pause with the validated change set, to be decided with {@link decideDraft};
 * nothing is drafted yet. A reference drawing the designer attached (a DXF) rides on the run for the
 * agent to read. A run that ends without a change set (the agent asked for a missing dimension) or
 * pauses on one that is not the request's comes back `refused`.
 *
 * @throws {NoDrawingAccess} before any run, when `access` gives the designer no series.
 */
export async function proposeDraft(
  aw: AgentWorkspaceClient,
  agentId: string,
  desk: Desk,
  reference?: { readonly fileId: string },
): Promise<DraftAwaitingApproval | DraftRefused> {
  const { requirements } = desk;
  return await untilProposal(
    runAndRead(aw, agentId, {
      subject: requirements.drafter,
      fileScope: fileScopeOf(desk.access, requirements.drafter),
      prompt: `${requirementsPrompt(requirements)}\n\n似た過去図面を探し、最も近い1件を元に作図してください。`,
      ...(reference === undefined ? {} : { attachments: [{ fileId: reference.fileId }] }),
    }),
    desk,
  );
}

/**
 * The designer decided the paused change set. Rejecting (with a comment saying what to change) starts
 * a continuation that revises it, so the answer is the next pause, checked again. Approving starts
 * the continuation that drafts: the DXF it wrote is returned only when every check passes, marked
 * 未検図 for the designer's own check.
 */
export async function decideDraft(
  aw: AgentWorkspaceClient,
  awaiting: DraftAwaitingApproval,
  decision: { readonly approve: boolean; readonly comment?: string },
): Promise<DraftOutcome> {
  const input = decision.comment === undefined ? {} : { comment: decision.comment };
  const { run } = decision.approve
    ? await aw.runs.approve(awaiting.runId, input)
    : await aw.runs.reject(awaiting.runId, input);
  if (!decision.approve) return untilProposal(readRun(aw, run.id), awaiting.desk);

  const { changeSet, base, desk } = awaiting;
  const { requirements } = desk;
  const reading = await readRun(aw, run.id);
  const done = { answer: reading.answer, sessionId: reading.run.sessionId };
  const refused = (problems: string[]): DraftRefused => ({
    status: 'refused',
    problems,
    changeSet,
    runId: reading.run.id,
    ...done,
  });

  const written = (await aw.runs.outputs(reading.run.id)).find(
    (file) => file.name === `${requirements.drawingNo}.dxf`,
  );
  if (written === undefined) {
    return refused([`エージェントが outputs/${requirements.drawingNo}.dxf を書いていません`]);
  }
  const downloaded = await aw.files.download(written.path);
  if (downloaded.kind !== 'file') return refused(['outputs の図面がファイルではありません']);
  const dxf = new TextDecoder().decode(downloaded.bytes);
  // The geometry is checked as it will be opened in CAD. The file is the agent's, so a DXF that does
  // not parse is a refusal, not a crash.
  let summary: DrawingSummary;
  try {
    summary = summarise(readDxf(Buffer.from(downloaded.bytes)));
  } catch (error) {
    return refused([
      `outputs/${requirements.drawingNo}.dxf を図面として読めません: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const after = [
    ...dimensionProblems(requirements, base, {
      ...summary,
      thickness: thicknessOf(summary.thickness),
    }),
    ...(summary.status === '未検図' ? [] : ['状態が未検図になっていません']),
    ...(summary.derivedFrom === changeSet.base ? [] : ['派生元が表題欄にありません']),
  ];
  if (after.length > 0) return refused(after);
  return { status: 'ready-for-check', changeSet, dxf, summary, ...done };
}
