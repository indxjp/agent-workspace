/**
 * The design desk's backend: find past drawings like the one a designer needs, then draft a new
 * drawing from the one the designer chose, and refuse any draft that is not exactly what was asked.
 *
 * Two runs in one session, because a run cannot stop and wait for a person: the first shows the
 * candidates, the designer picks one, the second drafts from it. The draft is checked here, not
 * trusted: the agent's change set is compared field by field with the requirements and the base
 * drawing (a dimension in neither is an invented one), and the DXF is produced by the same
 * deterministic script the agent ran and parsed again, so the geometry is checked as written. The
 * file the agent writes inside its run does not come back to the workspace file store
 * (`apps/web/server/runs/launcher.ts` collects `persistPaths` from the wrong directory), so the
 * backend writes the DXF the designer receives, from the change set the agent returned.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import { runAndRead, type ToolCall } from '../../shared/run-answer.ts';
import {
  DraftRefused,
  draft,
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
  readonly drafter: string;
  readonly date: string;
}

export interface Candidate {
  readonly drawingNo: string;
  readonly partName: string | null;
  readonly material: string | null;
  readonly thickness: string | null;
  readonly width: number;
  readonly height: number;
  readonly holes: number;
  readonly rectangular: boolean;
  readonly score: number;
  readonly differences: readonly string[];
}

export interface CandidateList {
  /** From the index's own result, not the agent's prose, so the numbers are the index's. */
  readonly candidates: readonly Candidate[];
  /** Drawings the index holds but could not read (DWG, scans). */
  readonly unreadable: readonly string[];
  readonly answer: string;
  readonly sessionId: string;
}

export type DraftOutcome =
  | {
      readonly status: 'ready-for-check';
      readonly changeSet: ChangeSet;
      readonly dxf: string;
      readonly summary: DrawingSummary;
      readonly answer: string;
      readonly sessionId: string;
    }
  | {
      readonly status: 'refused';
      readonly problems: readonly string[];
      readonly changeSet: ChangeSet | null;
      readonly answer: string;
      readonly sessionId: string;
    };

const toolIs = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function lastSearch(calls: readonly ToolCall[]): { candidates: Candidate[]; unreadable: string[] } {
  const found = calls.filter(
    (call) => toolIs(call.name, 'search_drawings') && !call.isError && call.output !== null,
  );
  const parsed = parseJson(found.at(-1)?.output ?? '');
  if (!isRecord(parsed) || !Array.isArray(parsed['candidates'])) {
    return { candidates: [], unreadable: [] };
  }
  const unreadable = Array.isArray(parsed['unreadable'])
    ? parsed['unreadable'].filter((name): name is string => typeof name === 'string')
    : [];
  return { candidates: parsed['candidates'] as Candidate[], unreadable };
}

/** Run 1: the agent searches and shows the candidates; the designer chooses from `candidates`. */
export async function findCandidates(
  aw: AgentWorkspaceClient,
  agentId: string,
  requirements: Requirements,
): Promise<CandidateList> {
  const reading = await runAndRead(aw, agentId, {
    prompt: `${requirementsPrompt(requirements)}\n\n似た過去図面を3件、要件との差分つきで示してください。`,
  });
  return {
    ...lastSearch(reading.toolCalls),
    answer: reading.answer,
    sessionId: reading.run.sessionId,
  };
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function toHole(value: unknown): Hole | null {
  if (!isRecord(value)) return null;
  const { x, y, diameter } = value;
  return isNumber(x) && isNumber(y) && isNumber(diameter) ? { x, y, diameter } : null;
}

/**
 * The change set the agent put in its answer's last ```json block, validated field by field, or
 * the reason it is not usable.
 */
export function parseChangeSet(answer: string): ChangeSet | string {
  const blocks = [...answer.matchAll(/```json\s*\n([\s\S]*?)```/gu)];
  const body = blocks.at(-1)?.[1];
  if (body === undefined) return '回答に変更セット（```json）がありません';
  const value = parseJson(body);
  if (!isRecord(value)) return '変更セットが JSON オブジェクトではありません';
  const { base, drawingNo, width, height, material, thickness, partName, holes } = value;
  if (typeof base !== 'string' || typeof drawingNo !== 'string') {
    return '変更セットに base と drawingNo（文字列）が必要です';
  }
  if (!isNumber(width) || !isNumber(height))
    return '変更セットに width と height（数値）が必要です';
  if (material !== undefined && typeof material !== 'string') return 'material は文字列です';
  if (partName !== undefined && typeof partName !== 'string') return 'partName は文字列です';
  if (thickness !== undefined && !isNumber(thickness)) return 'thickness は数値です';
  let parsedHoles: Hole[] | undefined;
  if (holes !== undefined) {
    if (!Array.isArray(holes)) return 'holes は配列です';
    parsedHoles = [];
    for (const entry of holes) {
      const hole = toHole(entry);
      if (hole === null) return 'holes の各要素に x, y, diameter（数値）が必要です';
      parsedHoles.push(hole);
    }
  }
  const drafter = typeof value['drafter'] === 'string' ? value['drafter'] : undefined;
  const date = typeof value['date'] === 'string' ? value['date'] : undefined;
  return {
    base,
    drawingNo,
    width,
    height,
    ...(material === undefined ? {} : { material }),
    ...(thickness === undefined ? {} : { thickness }),
    ...(partName === undefined ? {} : { partName }),
    ...(parsedHoles === undefined ? {} : { holes: parsedHoles }),
    ...(drafter === undefined ? {} : { drafter }),
    ...(date === undefined ? {} : { date }),
  };
}

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

/**
 * Run 2, in the same session: draft from the designer's choice, then check the draft. The DXF is
 * returned only when every check passes; it is marked 未検図 for the designer's own check.
 *
 * @param readDrawing reads the base DXF from your drawing store (PDM, file server), by number.
 */
export async function draftFrom(
  aw: AgentWorkspaceClient,
  agentId: string,
  options: {
    readonly requirements: Requirements;
    readonly chosen: string;
    readonly sessionId: string;
    readonly readDrawing: (drawingNo: string) => Promise<string>;
  },
): Promise<DraftOutcome> {
  const { requirements, chosen } = options;
  const reading = await runAndRead(aw, agentId, {
    prompt: `${chosen} を元に作図してください。`,
    sessionId: options.sessionId,
  });
  const done = { answer: reading.answer, sessionId: reading.run.sessionId };
  const refused = (problems: string[], changeSet: ChangeSet | null): DraftOutcome => ({
    status: 'refused',
    problems,
    changeSet,
    ...done,
  });

  const changeSet = parseChangeSet(reading.answer);
  if (typeof changeSet === 'string') return refused([changeSet], null);
  const read = reading.toolCalls.some(
    (call) =>
      toolIs(call.name, 'read_drawing') &&
      !call.isError &&
      isRecord(call.input) &&
      call.input['drawingNo'] === chosen,
  );
  const problems: string[] = [];
  if (changeSet.base !== chosen) {
    problems.push(`元図: 設計者が選んだのは ${chosen}、変更セットは ${changeSet.base}`);
  }
  if (!read) problems.push(`元図 ${chosen} を read_drawing で読まずに作図しています`);

  const baseText = await options.readDrawing(chosen);
  const base = summarise(baseText);
  const holes = changeSet.holes ?? base.holes;
  problems.push(
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
  );
  if (problems.length > 0) return refused(problems, changeSet);

  let produced: { dxf: string; summary: DrawingSummary };
  try {
    produced = draft(baseText, {
      ...changeSet,
      drafter: requirements.drafter,
      date: requirements.date,
    });
  } catch (error) {
    if (error instanceof DraftRefused) return refused([...error.problems], changeSet);
    throw error;
  }
  // Read the written file back: the geometry is checked as it will be opened in CAD.
  const summary = summarise(produced.dxf);
  const after = [
    ...dimensionProblems(requirements, base, {
      ...summary,
      thickness: thicknessOf(summary.thickness),
    }),
    ...(summary.status === '未検図' ? [] : ['状態が未検図になっていません']),
    ...(summary.derivedFrom === chosen ? [] : ['派生元が表題欄にありません']),
  ];
  if (after.length > 0) return refused(after, changeSet);
  return { status: 'ready-for-check', changeSet, dxf: produced.dxf, summary, ...done };
}
