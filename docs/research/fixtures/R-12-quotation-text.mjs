// Text extraction and comparison primitives for R-12-quotation-check.mjs: comparison form, the
// source extractors, and the match rules a checker applies. See that file's header for the rules.

/** Comparison form. Applied identically to both sides of every comparison, and it DELETES NO LINE:
 *  every line of the text reaches the comparison, and what is removed from each is characters.
 *  Block-quote markers come off the front of each line first; then the six markdown markup
 *  characters `> * ` # | \`, which carry no text of their own; then all whitespace, so a line wrap
 *  or an HTML tag boundary cannot make two identical texts differ; then case, so `SHALL` and `shall`
 *  compare equal.
 *
 *  A fence delimiter needs no rule of its own under that: a line of three backticks reduces to the
 *  empty string, and an opening delimiter carrying an info string reduces to the info string, which
 *  is then compared like any other text — so where a quotation and its source both carry the fence,
 *  as `spec-21` and `spec-47-criterion` do, the info strings have to match too. This is where round
 *  5's defect was: the previous revision deleted the whole LINE whenever its text began with three
 *  backticks, so `> ```<a fabricated sentence>` was deleted from both sides and the region compared
 *  identical to a source that does not contain it. The two places where the note's side legitimately
 *  carries a fence the source's side does not are handled by `fenceContent` and
 *  `withoutFenceDelimiters`, each of which says on itself which side it may be applied to.
 *
 *  This form is lossy in the ways listed above and in no others; it is not character-for-character,
 *  and no comparison built on it establishes that a quotation is. */
export function comparable(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:>\s?)+/u, ''))
    .join('\n')
    .replace(/[>*`#|\\]/gu, '')
    .replace(/\s+/gu, '')
    .toLowerCase();
}

/** The content of the one fenced block a quote region wraps, delimiters excluded — used by the five
 *  regions whose quotation is a fence this note put around text its source does not wrap, so that
 *  the wrapper is removed from the note's side STRUCTURALLY, by classifying the region, rather than
 *  by a character rule that would also delete a fabricated line.
 *
 *  Refusing, in the three ways the classification can fail: the region must open and close with a
 *  fence delimiter, those two must be the only lines in it that begin with three backticks, and
 *  NEITHER may carry anything after the backticks. An info string on the opening delimiter is text,
 *  and text this function dropped would be text no comparison ever sees — which is the defect round
 *  5 repaired — so it is refused by name and the quotation must be written with a bare fence. */
export function fenceContent(regionText, label) {
  const lines = regionText.split('\n');
  let first = 0;
  while (first < lines.length && lines[first].trim() === '') first += 1;
  let last = lines.length - 1;
  while (last > first && lines[last].trim() === '') last -= 1;
  const delimiters = [];
  for (let i = first; i <= last; i += 1) {
    if (/^\s*```/u.test(lines[i])) delimiters.push(i);
  }
  if (delimiters.length !== 2 || delimiters[0] !== first || delimiters[1] !== last) {
    throw new Error(
      `region "${label}" must be exactly one fenced block for its wrapper to be removed — it opens ` +
        `with ${JSON.stringify(lines[first] ?? '')} and has ${delimiters.length} fence delimiter ` +
        `line(s), at region-relative lines ${delimiters.map((i) => i + 1).join(', ')}`,
    );
  }
  for (const i of delimiters) {
    if (!/^\s*```\s*$/u.test(lines[i])) {
      throw new Error(
        `region "${label}" line ${i + 1} carries text after its fence delimiter: ` +
          `${JSON.stringify(lines[i].trim())}. This wrapper is removed from the comparison, so ` +
          `anything written on it would never be compared against the source; write the fence bare`,
      );
    }
  }
  return lines.slice(first + 1, last).join('\n');
}

/** A source extract with its fence delimiter lines removed, in full. SOURCE SIDE ONLY, and used by
 *  exactly one checker: `spec-20-body`, where the note declares that it collapsed §20's fenced
 *  `Store:` block onto one line. Removing text from the source side of an identity comparison can
 *  only make it fail — the note's side is untouched, so nothing the note added can be hidden by
 *  this — which is why it is safe here and why the mirror of it on the note's side is not. */
export function withoutFenceDelimiters(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*```/u.test(line))
    .join('\n');
}

/** Where the two comparable forms first differ, with context, so a failure is actionable. */
function firstDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return {
    index: i,
    source: a.slice(Math.max(0, i - 40), i + 60),
    note: b.slice(Math.max(0, i - 40), i + 60),
  };
}

function stripHtmlTags(html) {
  return html.replace(/<[^>]+>/gu, ' ');
}

/** Every paragraph element of an HTML page, as text. The pilcrow both these pages' renderers append
 *  to a paragraph as its self-link is not part of the paragraph and comes off. */
function htmlParagraphs(html) {
  return [...html.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gu)].map((m) =>
    stripHtmlTags(m[1]).replace(/¶|&para;/gu, ''),
  );
}

/** `[text](url)` -> `text`, and the `&sect;` entity -> `§`. ASVS writes its cross-references as
 *  markdown links to NIST anchors; the note quotes the sentence as it renders. */
export function flattenMarkdownLinks(markdown) {
  return markdown.replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/&sect;/gu, '§');
}

/** The body of the HTML section introduced by the heading carrying `anchorId`: from the end of that
 *  heading element to the start of the next heading element of any level. Structural, so it cannot
 *  be shortened by a wording change inside the section. */
export function nistSectionBody(html, anchorId) {
  const at = html.indexOf(`id="${anchorId}"`);
  if (at === -1) throw new Error(`no element with id="${anchorId}" in the NIST source`);
  const openTag = html.lastIndexOf('<', at);
  const tagName = /^<(h[1-6])[\s>]/u.exec(html.slice(openTag, openTag + 8));
  if (tagName === null) throw new Error(`id="${anchorId}" is not on a heading element`);
  const headingEnd = html.indexOf(`</${tagName[1]}>`, at);
  if (headingEnd === -1) throw new Error(`heading for id="${anchorId}" is unterminated`);
  const bodyStart = headingEnd + `</${tagName[1]}>`.length;
  const next = /<h[1-6][\s>]/u.exec(html.slice(bodyStart));
  if (next === null)
    throw new Error(`no heading follows id="${anchorId}"; refusing to read to EOF`);
  return stripHtmlTags(html.slice(bodyStart, bodyStart + next.index));
}

/** The body of the markdown section whose heading line matches `heading`: from after that line to
 *  the line before the next heading of the same or a higher level. */
export function markdownSectionBody(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) throw new Error(`no heading matching ${String(heading)}`);
  const level = /^(#+)/u.exec(lines[start])[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const h = /^(#+)\s/u.exec(lines[i]);
    if (h !== null && h[1].length <= level) {
      end = i;
      break;
    }
  }
  if (end === lines.length) throw new Error(`no heading closes ${String(heading)}`);
  // The horizontal rule that separates spec sections belongs to neither section.
  while (end > start && /^\s*(-{3,}|\s*)$/u.test(lines[end - 1])) end -= 1;
  return lines.slice(start + 1, end).join('\n');
}

/** The part of a section that follows its labelled lead-in line — `Completion criteria:` and the
 *  like — with the blank lines at either end removed. The label must occur exactly once, so a
 *  section that grew a second one is refused rather than silently read from the first. */
export function afterLabel(body, label) {
  const lines = body.split('\n');
  const at = lines.reduce(
    (found, line, index) => (label.test(line) ? [...found, index] : found),
    [],
  );
  if (at.length !== 1)
    throw new Error(`${String(label)} occurs ${at.length} times in the section, not once`);
  let start = at[0] + 1;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

/** The inclusive span `from`..`to` of a source file, 1-based, as the note's own citation writes it.
 *  A citation past the end of the file is a failure, not a shorter span. */
export function citedSpan(sourceText, from, to) {
  const lines = sourceText.split('\n');
  if (from < 1 || to < from) throw new Error(`the cited span ${from}-${to} is not a line range`);
  if (to > lines.length)
    throw new Error(`the note cites line ${to} of a source that has ${lines.length} lines`);
  return lines.slice(from - 1, to).join('\n');
}

/** A brace-balanced TypeScript declaration, from `header` to the `}` that closes it, plus the
 *  terminating `;` when the source writes one. */
export function declarationBody(source, header) {
  const at = source.indexOf(header);
  if (at === -1) throw new Error(`no declaration starting ${header}`);
  let depth = 0;
  for (let i = at; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const end = source[i + 1] === ';' ? i + 2 : i + 1;
        return source.slice(at, end);
      }
    }
  }
  throw new Error(`declaration starting ${header} is unbalanced`);
}

/** Every requirement row of one ASVS section, as {id, text}, derived from the table rows the
 *  section contains rather than from a list of ids this file knows.
 *
 *  Every line of the section body is classified, and the classification ends in rejection: a line
 *  that opens a table cell is either the requirement row this returns, or the table's header row,
 *  or its alignment row — and anything else that opens a table cell throws, naming the line. A
 *  `continue` on no-match here would be a filter, and a requirement row whose wording drifted out
 *  of the pattern would then be dropped instead of reported, which is the whole defect this file
 *  exists to prevent. */
export function asvsRequirements(markdown, sectionHeading) {
  const body = markdownSectionBody(markdown, sectionHeading);
  const rows = [];
  for (const line of body.split('\n')) {
    // A line that opens no table cell cannot be a markdown table row; the section's prose and blank
    // lines land here. This is the one narrowing in this function, and the contiguity assertion
    // below is what stops it — or anything else — from shortening the derived set unnoticed.
    if (!line.trimStart().startsWith('|')) continue;
    const row = /^\|\s*\*\*(\d+\.\d+\.\d+)\*\*\s*\|\s*(.+?)\s*\|\s*\d+\s*\|\s*$/u.exec(line);
    if (row !== null) {
      rows.push({ id: row[1], text: row[2] });
    } else if (/^\|\s*#\s*\|/u.test(line) || /^\|\s*:?-{2,}/u.test(line)) {
      // the table's header row and its alignment row: cells, but not requirements
    } else {
      throw new Error(
        `unclassified table row under ${String(sectionHeading)} — it is neither a requirement, ` +
          `a header nor an alignment row, so the requirement set derived here may be short: ${line}`,
      );
    }
  }
  if (rows.length === 0) throw new Error(`no requirement rows under ${String(sectionHeading)}`);
  // Backstop for the `continue` above and for anything else that could shorten this set: ASVS
  // numbers a section's requirements from .1 upward with no gaps, so a gap means a row was dropped
  // rather than that the section is short. Reject the gap; do not derive a shorter set from it.
  const numbers = rows.map((r) => Number.parseInt(r.id.slice(r.id.lastIndexOf('.') + 1), 10));
  for (let i = 0; i < numbers.length; i += 1) {
    if (numbers[i] !== i + 1) {
      throw new Error(
        `requirement ids under ${String(sectionHeading)} are not 1..n with no gaps — got ` +
          `${rows.map((r) => r.id).join(' ')}; a row was dropped or renumbered`,
      );
    }
  }
  return rows;
}

// --- comparison primitives ---------------------------------------------------------------------

/** The whole region must equal the whole source extract in comparison form. Neither side may carry
 *  a character the other does not. */
export function identical(sourceExtract, regionText, describeSource) {
  const source = comparable(sourceExtract);
  const note = comparable(regionText);
  if (source === note) {
    return {
      ok: true,
      detail: `${source.length} comparable chars, identical to ${describeSource}`,
    };
  }
  return { ok: false, detail: firstDivergence(source, note) };
}

/** The region must be the opening of the source extract, character for character in comparison form
 *  up to the point the note stops. Stronger than containment: a sentence dropped from the middle of
 *  the region breaks the prefix, because comparison form has already removed every space. */
export function prefixOf(sourceExtract, regionText, describeSource) {
  const source = comparable(sourceExtract);
  const note = comparable(regionText);
  if (note.length === 0) return { ok: false, detail: 'the region has no text to compare' };
  if (source.startsWith(note)) {
    return {
      ok: true,
      detail: `${note.length} comparable chars, the opening of ${describeSource}`,
    };
  }
  return { ok: false, detail: firstDivergence(source.slice(0, note.length), note) };
}

/** The region must be one whole paragraph of the page. The paragraph is found by asking which of the
 *  page's paragraphs contains the region — so no paragraph is named in this file — and then the two
 *  are compared for identity, which is what makes a quotation that stopped a sentence early a
 *  failure rather than a shorter passage that still happens to be verbatim. Matching no paragraph,
 *  and matching more than one, are both failures. */
export function wholeParagraphOf(html, regionText, describeSource) {
  const note = comparable(regionText);
  if (note.length === 0) return { ok: false, detail: 'the region has no text to compare' };
  const holding = htmlParagraphs(html).filter((p) => comparable(p).includes(note));
  if (holding.length === 0) {
    return {
      ok: false,
      detail: { noParagraphOf: describeSource, containsVerbatim: note.slice(0, 140) },
    };
  }
  if (holding.length > 1) {
    return {
      ok: false,
      detail: { ambiguous: `${holding.length} paragraphs of ${describeSource} contain this text` },
    };
  }
  return identical(holding[0], regionText, `the whole paragraph of ${describeSource}`);
}

/** Every fenced code block of a markdown source, as text, fence lines excluded. */
function markdownFences(markdown) {
  const blocks = [];
  let open = null;
  markdown.split('\n').forEach((line, index) => {
    if (!/^\s*```/u.test(line)) return;
    if (open === null) open = index;
    else {
      blocks.push(
        markdown
          .split('\n')
          .slice(open + 1, index)
          .join('\n'),
      );
      open = null;
    }
  });
  return blocks;
}

/** The region must be one whole fenced block of the source, found the same way `wholeParagraphOf`
 *  finds its paragraph: by asking which block contains the region, so no block is named here. */
export function wholeFenceOf(markdown, regionText, describeSource) {
  const note = comparable(regionText);
  if (note.length === 0) return { ok: false, detail: 'the region has no text to compare' };
  const holding = markdownFences(markdown).filter((f) => comparable(f).includes(note));
  if (holding.length === 0) {
    return {
      ok: false,
      detail: { noFencedBlockOf: describeSource, containsVerbatim: note.slice(0, 140) },
    };
  }
  if (holding.length > 1) {
    return {
      ok: false,
      detail: {
        ambiguous: `${holding.length} fenced blocks of ${describeSource} contain this text`,
      },
    };
  }
  return identical(holding[0], regionText, `the whole fenced block of ${describeSource}`);
}

/** The mark the note uses for an elision it declares. A region carrying none is compared as one
 *  contiguous passage, which is the stronger check: a sentence dropped from the middle of it breaks
 *  contiguity, because comparison form has already removed every space and line break. */
const ELISION = '[…]';

/** One fragment, quoted contiguously from somewhere inside the source extract. Used where the note
 *  says it is quoting part of a line and claims nothing about where in the line it begins or ends. */
export function verbatimWithin(sourceExtract, text, describeSource) {
  const source = comparable(sourceExtract);
  const fragment = comparable(text);
  if (fragment.length === 0) return { ok: false, detail: 'there is no text to compare' };
  if (source.includes(fragment)) {
    return {
      ok: true,
      detail: `${fragment.length} comparable chars, contiguous within ${describeSource}`,
    };
  }
  return {
    ok: false,
    detail: { notFoundInSource: fragment.slice(0, 140), searchedIn: describeSource },
  };
}

/** Each passage of the region, split at its declared elisions, must appear in the source in
 *  comparison form, contiguously, and in the order the note prints them — AND the region must be
 *  anchored to the source extract at both ends. A region that does not open with an elision must
 *  start where the extract starts, and one that does not close with an elision must run to where the
 *  extract ends. Without those two anchors this is containment, and containment cannot tell a
 *  quotation that stopped a sentence early from one that did not: it was the check that let round
 *  3's second reproduction — two sentences deleted from the head of this note's §3.1.2 block —
 *  pass. Text may be dropped only where the note prints `[…]` and says so. */
export function excerptOf(sourceExtract, regionText, describeSource) {
  const source = comparable(sourceExtract);
  const passages = regionText.split(ELISION).map(comparable);
  const quoted = passages.filter((p) => p.length > 0);
  if (quoted.length === 0) return { ok: false, detail: 'the region has no text to compare' };
  const opensElided = passages[0].length === 0;
  const closesElided = passages[passages.length - 1].length === 0;
  let from = 0;
  for (const [index, passage] of quoted.entries()) {
    const at = source.indexOf(passage, from);
    if (at === -1) {
      return {
        ok: false,
        detail: { notFoundInSource: passage.slice(0, 140), searchedFromOffset: from },
      };
    }
    if (index === 0 && !opensElided && at !== 0) {
      return {
        ok: false,
        detail: {
          startsAtOffset: at,
          of: describeSource,
          expected: 'the start, or a declared […] elision before it',
        },
      };
    }
    from = at + passage.length;
  }
  if (!closesElided && from !== source.length) {
    return {
      ok: false,
      detail: {
        stopsAtOffset: from,
        ofLength: source.length,
        of: describeSource,
        expected: 'the end, or a declared […] elision after it',
      },
    };
  }
  const chars = quoted.reduce((n, p) => n + p.length, 0);
  return {
    ok: true,
    detail:
      `${quoted.length} passage(s), ${chars} comparable chars, contiguous and in order within ${describeSource}` +
      `; anchored at ${opensElided ? 'a declared elision' : 'its start'} and ${closesElided ? 'a declared elision' : 'its end'}`,
  };
}

/** The one line range the note's own introducing paragraph cites, so the span checked here is the
 *  span the prose claims rather than a span this file remembers. Not exactly one match is a
 *  failure: two would make the claim ambiguous, none means the prose no longer states it. */
export function citation(intro, pattern, describe) {
  const found = [...intro.matchAll(pattern)];
  if (found.length !== 1) {
    throw new Error(
      `the introducing paragraph must cite ${describe} exactly once for this region to be checked ` +
        `against what it claims; ${found.length} citations match ${String(pattern)}`,
    );
  }
  return found[0];
}
