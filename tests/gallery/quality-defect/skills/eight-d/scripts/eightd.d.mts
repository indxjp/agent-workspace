// Types for the eight-d skill's script, which is plain JavaScript so it runs with Node alone inside
// a run's sandbox. The backend and the tests import it through these declarations.
export type Discipline = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8';
export type FourM = '人' | '機械' | '材料' | '方法';

export interface EightDSection {
  readonly id: Discipline;
  readonly title: string;
  readonly body: string;
  /** Q-numbers cited in the section, first occurrence order. */
  readonly cites: readonly string[];
}

export interface Why {
  /** The number the draft wrote after なぜ. */
  readonly depth: number;
  readonly text: string;
  readonly cites: readonly string[];
}

export interface EightDIssue {
  readonly code:
    | 'missing_section'
    | 'duplicate_section'
    | 'section_order'
    | 'shallow_whys'
    | 'whys_out_of_order'
    | 'missing_root_cause'
    | 'uncited_claim';
  readonly section: Discipline | null;
  readonly message: string;
}

export interface QuotedFourM {
  /** The counts the draft quotes, by 4M key; a key the draft left out is absent. */
  readonly counts: Readonly<Partial<Record<FourM, number>>>;
  /** The 類似 N件 total, when quoted. */
  readonly total: number | null;
  readonly line: string;
}

/** A statement in D4 that needs a source: each なぜ, each bullet and the 根本原因 line. */
export interface Claim {
  readonly text: string;
  readonly cites: readonly string[];
}

/** A draft read into parts, before any check: what `parseEightD` finds or a run returns. */
export interface EightDStructure {
  readonly title: string | null;
  readonly sections: readonly EightDSection[];
  readonly whys: readonly Why[];
  readonly claims: readonly Claim[];
  readonly rootCause: { readonly text: string; readonly cites: readonly string[] } | null;
  /** The 原因区分 written in D4, such as 金型摩耗. */
  readonly causeCode: string | null;
  readonly fourM: QuotedFourM | null;
}

export interface EightDDraft extends EightDStructure {
  /** Every Q-number cited anywhere in the draft. */
  readonly cites: readonly string[];
  readonly issues: readonly EightDIssue[];
  readonly valid: boolean;
}

export const DISCIPLINES: readonly Discipline[];
export const FOUR_M: readonly FourM[];
export const MIN_WHYS: number;
export function citedCases(text: string): string[];
/** The format checks, on a structure that was parsed or returned as data. */
export function checkEightD(structure: EightDStructure): EightDDraft;
export function parseEightD(markdown: string): EightDDraft;
