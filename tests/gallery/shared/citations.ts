/**
 * Citations written as 〔source p.page §section〕, the convention the gallery's grounded agents are
 * taught in their skills.
 *
 * The answers themselves are typed (`outputSchema`, ADR-0143), but what the agent's tools return
 * is text: the 〔…〕 in a tool's result is how the backend learns which sources a run actually saw,
 * and a reply's own text is read too so the schema is no way around the check. The bracket pair
 * 〔〕 is chosen because it almost never appears in Japanese business prose, so a match is a
 * citation and not a quotation.
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
