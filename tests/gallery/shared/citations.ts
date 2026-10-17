/**
 * Citations written as 〔source p.page §section〕, the convention the gallery's grounded agents are
 * taught in their skills.
 *
 * A run cannot return typed data today (no output schema; see `../harness/probes.ts`), so the
 * citations an answer makes are recovered from its text. The bracket pair 〔〕 is chosen because it
 * almost never appears in Japanese business prose, so a match is a citation and not a quotation.
 */
export interface Citation {
  readonly source: string;
  readonly page: number | null;
  readonly section: string | null;
  /** The whole bracketed text, as written. */
  readonly raw: string;
}

const CITATION = /〔([^〔〕]+)〕/gu;
const PAGE = /\s*p\.?\s*(\d+)/u;
const SECTION = /\s*§\s*([^\s〕]+)/u;

/** Every 〔…〕 citation in `text`, in order, with its page and section when it names them. */
export function parseCitations(text: string): Citation[] {
  return [...text.matchAll(CITATION)].map((match) => {
    const raw = match[1] ?? '';
    const page = PAGE.exec(raw);
    const section = SECTION.exec(raw);
    const source = raw.replace(PAGE, '').replace(SECTION, '').trim();
    return {
      source,
      page: page?.[1] === undefined ? null : Number(page[1]),
      section: section?.[1] ?? null,
      raw,
    };
  });
}
