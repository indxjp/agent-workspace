/**
 * The review sheet the `ringi-checklist` skill asks for, read back into typed findings.
 *
 * A run returns free text (no output schema; probe `run-output-schema`), so the five fixed
 * headings are the contract between the skill and this parser. A sheet that drops or renames a
 * heading is reported as `missingSections`, not silently read as "no findings".
 */
import { parseCitations, type Citation } from '../../shared/citations.ts';

export const SECTIONS = ['記載漏れ', '規程との照合', '決裁区分', '類似案件', '総合所見'] as const;
export type SectionName = (typeof SECTIONS)[number];

export interface Finding {
  readonly section: SectionName;
  /** The bullet's text, without the leading `- ` and with its citations still in place. */
  readonly text: string;
  readonly citations: readonly Citation[];
}

export interface ReviewSheet {
  /** Findings by section; a section the agent wrote as `- なし` is an empty list. */
  readonly sections: Readonly<Record<SectionName, readonly Finding[]>>;
  /** The 総合所見 paragraph as written (bullets or prose). */
  readonly summary: string;
  /** The approver the 決裁区分 line names, such as `本部長` for `決裁区分: 本部長決裁`. */
  readonly approver: string | null;
  readonly coReview: string | null;
  /** Headings the skill requires that the sheet does not have. */
  readonly missingSections: readonly SectionName[];
}

const isSection = (value: string): value is SectionName =>
  (SECTIONS as readonly string[]).includes(value);

const NONE = /^なし[。.]?$/u;
const ROUTE = /^決裁区分[:：]\s*(.+?)決裁/u;
const CO_REVIEW = /^合議[:：]\s*([^〔\s]+)/u;

/** Read a sheet written in the `ringi-checklist` format. */
export function parseReviewSheet(sheet: string): ReviewSheet {
  const lines = new Map<SectionName, string[]>();
  let current: SectionName | null = null;
  for (const raw of sheet.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/u.exec(raw);
    if (heading !== null) {
      const title = heading[1] ?? '';
      current = isSection(title) ? title : null;
      if (current !== null) lines.set(current, []);
      continue;
    }
    if (current !== null && raw.trim() !== '') lines.get(current)?.push(raw.trim());
  }

  const findingsOf = (section: SectionName): Finding[] =>
    (lines.get(section) ?? [])
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      .filter((text) => !NONE.test(text))
      .map((text) => ({ section, text, citations: parseCitations(text) }));

  const sections = Object.fromEntries(
    SECTIONS.map((section) => [section, findingsOf(section)]),
  ) as Record<SectionName, Finding[]>;
  const route = sections.決裁区分.map((finding) => ROUTE.exec(finding.text)?.[1]).find(Boolean);
  const coReview = sections.決裁区分
    .map((finding) => CO_REVIEW.exec(finding.text)?.[1])
    .find((value) => value !== undefined);

  return {
    sections,
    summary: (lines.get('総合所見') ?? []).map((line) => line.replace(/^- /u, '')).join('\n'),
    approver: route?.trim() ?? null,
    coReview: coReview === undefined || NONE.test(coReview) ? null : coReview,
    missingSections: SECTIONS.filter((section) => !lines.has(section)),
  };
}
