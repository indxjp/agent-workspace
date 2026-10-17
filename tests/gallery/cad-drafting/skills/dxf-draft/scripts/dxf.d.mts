// Types for the dxf-draft skill's script, which is plain JavaScript so it runs with Node alone
// inside a run's sandbox. The backend and the tests import it through these declarations.
export interface Hole {
  /** From the outline's lower-left corner, mm. */
  readonly x: number;
  readonly y: number;
  readonly diameter: number;
}

export interface DrawingSummary {
  readonly version: string | null;
  readonly drawingNo: string | null;
  readonly partName: string | null;
  readonly material: string | null;
  readonly thickness: string | null;
  readonly status: string | null;
  readonly derivedFrom: string | null;
  readonly title: Readonly<Record<string, string>>;
  readonly origin: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
  readonly rectangular: boolean;
  readonly holes: readonly Hole[];
  readonly notes: readonly string[];
  readonly entityCount: number;
  readonly unreadEntities: readonly string[];
}

export interface ChangeSet {
  readonly base: string;
  readonly drawingNo: string;
  readonly width: number;
  readonly height: number;
  readonly material?: string;
  readonly thickness?: number;
  readonly partName?: string;
  readonly holes?: readonly Hole[];
  readonly drafter?: string;
  readonly date?: string;
}

export interface DxfEntity {
  readonly type: string;
  readonly layer: string;
  readonly [field: string]: unknown;
}

export class DraftRefused extends Error {
  public readonly problems: readonly string[];
}

export function parseDxf(text: string): {
  header: Record<string, string>;
  entities: DxfEntity[];
};
export function summarise(text: string): DrawingSummary;
export function holeProblems(width: number, height: number, holes: readonly Hole[]): string[];
/**
 * `changes`: `高さ 80 → 90`, `穴 (15,65)φ9 → (15,75)φ9`, `品名 ブラケット を追加`;
 * `kept`: `幅 140（元図のまま）`.
 */
export function describeChanges(
  base: DrawingSummary,
  next: DrawingSummary,
): { changes: string[]; kept: string[] };
export function draft(
  baseText: string,
  changes: ChangeSet,
): {
  dxf: string;
  summary: DrawingSummary;
  /** The change set to paste into the reply: fields equal to the base's are left out. */
  changeSet: ChangeSet;
  changes: string[];
  kept: string[];
};
export function writeDxf(drawing: {
  readonly header?: Readonly<Record<string, string>>;
  readonly entities: readonly DxfEntity[];
}): string;
