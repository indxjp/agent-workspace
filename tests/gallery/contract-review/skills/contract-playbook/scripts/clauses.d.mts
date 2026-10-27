// Types for the contract-playbook skill's script, which is plain JavaScript so it runs with Node
// alone inside a run's sandbox. The tests and the backend import it through these declarations.

/** One paragraph as the office-reader skill prints it for a .docx; this script reads that JSON, never the Word file. */
export interface DocxParagraph {
  readonly style: string | null;
  readonly text: string;
}

export type Severity = '高' | '中' | '低';

export interface Clause {
  readonly number: number;
  /** 「第8条」, with the number folded to ASCII digits whatever the draft wrote. */
  readonly label: string;
  /** The text in 「（）」 after the number, or empty. */
  readonly heading: string;
  readonly text: string;
}

export interface SplitDocument {
  readonly title: string;
  readonly preamble: readonly string[];
  readonly clauses: readonly Clause[];
}

export interface Finding {
  readonly rule: string;
  readonly topic: string;
  readonly severity: Severity;
  /** The agent must put this finding in its risk table; the backend checks that it did. */
  readonly mustFlag: boolean;
  /** 「第8条」, or `null` when the finding is an absence (no such clause anywhere). */
  readonly clause: string | null;
  readonly heading: string;
  readonly kind: 'present' | 'absent';
  /** The sentence that fired, normalized; empty for an absence. */
  readonly evidence: string;
  readonly reason: string;
  /** The playbook's 標準条項, when the check was given the playbook. */
  readonly standard?: string;
}

export interface CheckResult {
  readonly title: string;
  readonly clauses: readonly { readonly label: string; readonly heading: string }[];
  readonly findings: readonly Finding[];
}

export interface PlaybookRule {
  readonly id: string;
  readonly title: string;
  readonly severity: string;
  readonly mustFlag: boolean;
  readonly criteria: string;
  readonly standard: string;
  readonly file: string;
}

export interface Detector {
  readonly rule: string;
  readonly topic: string;
  readonly severity: Severity;
  readonly mustFlag: boolean;
  readonly explain: string;
}

export function clauseNumber(written: string): number;
export function normalize(text: string): string;
export function splitClauses(paragraphs: readonly DocxParagraph[]): SplitDocument;
export const DETECTORS: readonly Detector[];
export function loadPlaybook(dir: string): Map<string, PlaybookRule>;
export function check(
  paragraphs: readonly DocxParagraph[],
  playbook?: ReadonlyMap<string, PlaybookRule> | null,
): CheckResult;
/** The draft's paragraphs plus a 【修正案】 block: the playbook's standard clause for each must-flag or 高 finding. */
export function redline(
  paragraphs: readonly DocxParagraph[],
  result: CheckResult,
): readonly DocxParagraph[];
