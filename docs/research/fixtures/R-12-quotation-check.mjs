// Checks the quotations in the R-12 research note (auth, sessions, API keys) against their sources.
//
// Why this exists: verification round 1 raised, as a major finding, that the note quoted two
// standards while omitting sentences that bore on its reading. Round 2 raised that the repair's
// replacement wording ("verbatim and complete", "quoted in full") was itself unchecked, and a
// re-fetch disproved it. A sentence claiming a quotation is whole is a measured claim about two
// files, so it is checked here rather than asserted in prose (ADR-0016).
//
// Round 3 raised the defect this revision repairs: the contributing set used to be the set of
// `<!-- R-12-QUOTE -->` markers the author remembered to place, so a blockquote the note introduced
// as a quotation but did not wrap was checked by nothing and rejected by nothing. A fabricated
// sentence attributed to NIST passed. The set is now derived BY SHAPE — every blockquote the note
// contains, found by scanning for lines that open with `>` outside code fences — and an unwrapped
// blockquote is a hard failure naming its line range (ADR-0027, ADR-0029).
//
// Round 4 raised the defect this revision repairs, in the two checkers that had asserted containment
// in one direction only. `asvs-v6.5` asserted that every derived requirement row appeared in the
// region and that every requirement-shaped number the region printed was a known id; a fabricated
// normative sentence appended to the end of a real row, carrying no requirement number, satisfied
// both and passed. `r01-no-probe-resumed` rejected leftover quoted text only when what was left over
// held a straight double quote, so a third entry written with typographic quotes was read by neither
// the attribution pattern nor the guard, and sat inside the region unchecked. Each of those two now
// also asserts the converse — that the region carries no text its source does not have — and the
// comment beside each says which comparison does it.
//
// Round 5 raised the defect this revision repairs, and it was in the comparison form itself rather
// than in any checker: `comparable()` used to DELETE every whole line whose text began with three
// backticks. A fabricated sentence written as `> ```<sentence>` inside a quote region was therefore
// deleted from BOTH sides before the comparison, so the region compared identical to its source
// while the note printed a sentence no source contains — eleven of the seventeen regions accepted
// that, including the two round 4 had just repaired. The rule that replaces it deletes no line at
// all (see `comparable`), and the two places where the note legitimately carries a fence its source
// does not are handled where they arise, by named helpers that refuse rather than drop:
// `fenceContent` for the five regions that wrap their quotation in a fence, and
// `withoutFenceDelimiters` on the SOURCE side of `spec-20-body`, where the note declares that it
// collapsed a fenced block onto one line.
//
// WHAT THIS FILE DECIDES, AND WHAT IT DOES NOT. It decides one question per quote region: does the
// text between that region's markers match the extract its checker derives from the source, in the
// comparison form below. That form is lossy and this header says exactly how: it removes block-quote
// markers, the six markdown markup characters `> * ` # | \`, all whitespace, and case — so a block
// that lowercased a `SHALL`, rewrapped a line, or dropped a backtick still compares equal, and a
// claim that a quotation is character-for-character verbatim is NOT what any check here establishes.
// No line is deleted, so prose cannot hide behind markup that this form throws away. What is outside
// its reach: it reads the note as text and cannot see how a renderer displays that text, so a
// quotation whose meaning depends on rendering — an HTML comment, a zero-width character, a
// right-to-left override — is compared as the characters it is written with and nothing here decides
// whether a reader sees them.
//
// WHAT IT READS, AND WHERE IT STOPS. It reads two forms: a `>` blockquote, and a ``` fence a region
// wraps. The coverage rule in (1) is over the first of those and there is no coverage rule over the
// second. Rule (4) refuses two further forms — an indented block, and a line opening an HTML
// `<blockquote>` or `<pre>` element — and refusing is not reading: a passage written in either is
// rejected, never compared. Everything else stops here. A passage displayed in an HTML `<div>`,
// `<figure>` or `<table>` element, in a markdown table cell, in a markdown list item, inline inside
// an ordinary paragraph, or in a fence nobody wrapped in a region is read by no derivation above,
// refused by no rule above, and leaves the run at exit 0 with the passage on the page. That is not a
// claim about this comment's completeness in either direction: each of those forms is a case in
// `R-12-quotation-limits.mjs`, which appends it to the note and asserts the verdict this check gives
// it, so closing one fails that file and forces this paragraph to be rewritten. What that file
// cannot assert is that they are all of them — it is a list too, and neither list terminates,
// because refusing the CLASS would take an else-branch (every non-fence, non-blockquote block outside
// a region refused) that rule (4) does not have. The PR body's declared gaps carry these with their
// counter-examples. A gate over prose cannot be complete, and the overstatement of one is what stops
// the next reader looking.
//
// Shape: four derivations, each ending in rejection.
//   1. Every blockquote in the note must lie inside exactly one marker region. A blockquote inside
//      none is a failure naming its lines; a blockquote inside two is a failure naming both.
//   2. A blockquote whose introducing paragraph ends in a colon is PRESENTED as quoted material, so
//      it must be inside an `<!-- R-12-QUOTE <id> -->` region and not an `<!-- R-12-NOTQUOTE
//      <reason> -->` one. The colon is the note's — and English's — mark for "what follows is the
//      quoted text"; opting a colon-introduced blockquote out is refused by name.
//   3. Every quote region's id must have a checker here and match its source; a checker with no
//      region is a failure; a region whose source was not supplied on the command line is a failure
//      naming the region, not a skipped check.
//   4. The two derivations above read `>` blockquotes and ``` fences. TWO further block forms are
//      refused wherever they appear outside a fence, whether or not anything about them looks
//      quoted: an indented block, and a line that opens an HTML `<blockquote>` or `<pre>` element.
//      Each is matched as its construct rather than as one way of writing it — indentation is
//      measured in columns so a tab indents as four, and the tag name is matched wherever the tag
//      ends, end of line included — because verification round 5 found this rule refusing two
//      SPELLINGS: a tab-indented block and an element whose attribute list began on the next line
//      both walked past it while rendering as the very elements the rule names. Those two spellings
//      are cases in `R-12-quotation-limits.mjs` now. What rule (4) is NOT is a rule over the class
//      "a block that displays a passage": it is a list of two element names and one indent
//      measurement, and the forms it does not name are enumerated under WHAT IT READS above and
//      asserted, one case each, in the same file. It will also refuse an indented block nobody meant
//      as a quotation, and that is the side to err on.
//
// Usage (every source path is required; the four remote ones must be fetched first):
//
//   curl -sS -o /tmp/nist.html https://pages.nist.gov/800-63-4/sp800-63b.html
//   curl -sS -o /tmp/asvs-v6.md \
//     https://raw.githubusercontent.com/OWASP/ASVS/master/5.0/en/0x15-V6-Authentication.md
//   curl -sS -o /tmp/owasp-session.html \
//     https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
//   curl -sS -o /tmp/rfc6265bis.html \
//     https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis-22
//   node docs/research/fixtures/R-12-quotation-check.mjs \
//     --note <the R-12 research note> \
//     --nist /tmp/nist.html --asvs /tmp/asvs-v6.md \
//     --owasp /tmp/owasp-session.html --rfc /tmp/rfc6265bis.html \
//     --spec docs/spec.md --plan <the development plan> \
//     --r01 <the R-01 research note> \
//     --dts node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts \
//     --mjs node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs \
//     --exe node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe
//
// A region may wrap a blockquote or a fenced block, and the note quotes both. The coverage rule in
// (1) is over blockquotes only — a colon-introduced fence is also how the note prints probe output
// and prescribed code, so the same rule cannot be run over fences, and a fence quotation added later
// would not be caught. That is declared as a gap in the PR body.
//
// The companion file needs no source and no network, and asserts what this one reads and where it
// stops, one case per construct:
//
//   node docs/research/fixtures/R-12-quotation-limits.mjs \
//     --note <the R-12 research note>
//
// Exit status 0 means every blockquote was classified and every derived region matched its source.
// Any other outcome exits 1 and names what failed.

import { basename } from 'node:path';
import { readFileSync } from 'node:fs';

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
function comparable(text) {
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
function fenceContent(regionText, label) {
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
function withoutFenceDelimiters(text) {
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
function flattenMarkdownLinks(markdown) {
  return markdown.replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/&sect;/gu, '§');
}

/** The body of the HTML section introduced by the heading carrying `anchorId`: from the end of that
 *  heading element to the start of the next heading element of any level. Structural, so it cannot
 *  be shortened by a wording change inside the section. */
function nistSectionBody(html, anchorId) {
  const at = html.indexOf(`id="${anchorId}"`);
  if (at === -1) throw new Error(`no element with id="${anchorId}" in the NIST source`);
  const openTag = html.lastIndexOf('<', at);
  const tagName = /^<(h[1-6])[\s>]/u.exec(html.slice(openTag, openTag + 8));
  if (tagName === null) throw new Error(`id="${anchorId}" is not on a heading element`);
  const headingEnd = html.indexOf(`</${tagName[1]}>`, at);
  if (headingEnd === -1) throw new Error(`heading for id="${anchorId}" is unterminated`);
  const bodyStart = headingEnd + `</${tagName[1]}>`.length;
  const next = /<h[1-6][\s>]/u.exec(html.slice(bodyStart));
  if (next === null) throw new Error(`no heading follows id="${anchorId}"; refusing to read to EOF`);
  return stripHtmlTags(html.slice(bodyStart, bodyStart + next.index));
}

/** The body of the markdown section whose heading line matches `heading`: from after that line to
 *  the line before the next heading of the same or a higher level. */
function markdownSectionBody(markdown, heading) {
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
function afterLabel(body, label) {
  const lines = body.split('\n');
  const at = lines.reduce((found, line, index) => (label.test(line) ? [...found, index] : found), []);
  if (at.length !== 1) throw new Error(`${String(label)} occurs ${at.length} times in the section, not once`);
  let start = at[0] + 1;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

/** The inclusive span `from`..`to` of a source file, 1-based, as the note's own citation writes it.
 *  A citation past the end of the file is a failure, not a shorter span. */
function citedSpan(sourceText, from, to) {
  const lines = sourceText.split('\n');
  if (from < 1 || to < from) throw new Error(`the cited span ${from}-${to} is not a line range`);
  if (to > lines.length) throw new Error(`the note cites line ${to} of a source that has ${lines.length} lines`);
  return lines.slice(from - 1, to).join('\n');
}

/** A brace-balanced TypeScript declaration, from `header` to the `}` that closes it, plus the
 *  terminating `;` when the source writes one. */
function declarationBody(source, header) {
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
function asvsRequirements(markdown, sectionHeading) {
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
function identical(sourceExtract, regionText, describeSource) {
  const source = comparable(sourceExtract);
  const note = comparable(regionText);
  if (source === note) {
    return { ok: true, detail: `${source.length} comparable chars, identical to ${describeSource}` };
  }
  return { ok: false, detail: firstDivergence(source, note) };
}

/** The region must be the opening of the source extract, character for character in comparison form
 *  up to the point the note stops. Stronger than containment: a sentence dropped from the middle of
 *  the region breaks the prefix, because comparison form has already removed every space. */
function prefixOf(sourceExtract, regionText, describeSource) {
  const source = comparable(sourceExtract);
  const note = comparable(regionText);
  if (note.length === 0) return { ok: false, detail: 'the region has no text to compare' };
  if (source.startsWith(note)) {
    return { ok: true, detail: `${note.length} comparable chars, the opening of ${describeSource}` };
  }
  return { ok: false, detail: firstDivergence(source.slice(0, note.length), note) };
}

/** The region must be one whole paragraph of the page. The paragraph is found by asking which of the
 *  page's paragraphs contains the region — so no paragraph is named in this file — and then the two
 *  are compared for identity, which is what makes a quotation that stopped a sentence early a
 *  failure rather than a shorter passage that still happens to be verbatim. Matching no paragraph,
 *  and matching more than one, are both failures. */
function wholeParagraphOf(html, regionText, describeSource) {
  const note = comparable(regionText);
  if (note.length === 0) return { ok: false, detail: 'the region has no text to compare' };
  const holding = htmlParagraphs(html).filter((p) => comparable(p).includes(note));
  if (holding.length === 0) {
    return { ok: false, detail: { noParagraphOf: describeSource, containsVerbatim: note.slice(0, 140) } };
  }
  if (holding.length > 1) {
    return { ok: false, detail: { ambiguous: `${holding.length} paragraphs of ${describeSource} contain this text` } };
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
      blocks.push(markdown.split('\n').slice(open + 1, index).join('\n'));
      open = null;
    }
  });
  return blocks;
}

/** The region must be one whole fenced block of the source, found the same way `wholeParagraphOf`
 *  finds its paragraph: by asking which block contains the region, so no block is named here. */
function wholeFenceOf(markdown, regionText, describeSource) {
  const note = comparable(regionText);
  if (note.length === 0) return { ok: false, detail: 'the region has no text to compare' };
  const holding = markdownFences(markdown).filter((f) => comparable(f).includes(note));
  if (holding.length === 0) {
    return { ok: false, detail: { noFencedBlockOf: describeSource, containsVerbatim: note.slice(0, 140) } };
  }
  if (holding.length > 1) {
    return { ok: false, detail: { ambiguous: `${holding.length} fenced blocks of ${describeSource} contain this text` } };
  }
  return identical(holding[0], regionText, `the whole fenced block of ${describeSource}`);
}

/** The mark the note uses for an elision it declares. A region carrying none is compared as one
 *  contiguous passage, which is the stronger check: a sentence dropped from the middle of it breaks
 *  contiguity, because comparison form has already removed every space and line break. */
const ELISION = '[…]';

/** One fragment, quoted contiguously from somewhere inside the source extract. Used where the note
 *  says it is quoting part of a line and claims nothing about where in the line it begins or ends. */
function verbatimWithin(sourceExtract, text, describeSource) {
  const source = comparable(sourceExtract);
  const fragment = comparable(text);
  if (fragment.length === 0) return { ok: false, detail: 'there is no text to compare' };
  if (source.includes(fragment)) {
    return { ok: true, detail: `${fragment.length} comparable chars, contiguous within ${describeSource}` };
  }
  return { ok: false, detail: { notFoundInSource: fragment.slice(0, 140), searchedIn: describeSource } };
}

/** Each passage of the region, split at its declared elisions, must appear in the source in
 *  comparison form, contiguously, and in the order the note prints them — AND the region must be
 *  anchored to the source extract at both ends. A region that does not open with an elision must
 *  start where the extract starts, and one that does not close with an elision must run to where the
 *  extract ends. Without those two anchors this is containment, and containment cannot tell a
 *  quotation that stopped a sentence early from one that did not: it was the check that let round
 *  3's second reproduction — two sentences deleted from the head of this note's §3.1.2 block —
 *  pass. Text may be dropped only where the note prints `[…]` and says so. */
function excerptOf(sourceExtract, regionText, describeSource) {
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
      return { ok: false, detail: { notFoundInSource: passage.slice(0, 140), searchedFromOffset: from } };
    }
    if (index === 0 && !opensElided && at !== 0) {
      return {
        ok: false,
        detail: { startsAtOffset: at, of: describeSource, expected: 'the start, or a declared […] elision before it' },
      };
    }
    from = at + passage.length;
  }
  if (!closesElided && from !== source.length) {
    return {
      ok: false,
      detail: { stopsAtOffset: from, ofLength: source.length, of: describeSource, expected: 'the end, or a declared […] elision after it' },
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
function citation(intro, pattern, describe) {
  const found = [...intro.matchAll(pattern)];
  if (found.length !== 1) {
    throw new Error(
      `the introducing paragraph must cite ${describe} exactly once for this region to be checked ` +
        `against what it claims; ${found.length} citations match ${String(pattern)}`,
    );
  }
  return found[0];
}

// --- the checkers, keyed by the region id they answer for -------------------------------------

const CHECKERS = {
  'nist-3.1.2.2': {
    arg: '--nist',
    describe: 'NIST SP 800-63B-4 §3.1.2.2, whole section body',
    check(sourceText) {
      return (regionText) => identical(nistSectionBody(sourceText, 'lookupver'), regionText, 'the #lookupver body');
    },
  },
  'nist-3.1.2-definition': {
    arg: '--nist',
    describe: "NIST SP 800-63B-4 §3.1.2, the authenticator definition",
    check(sourceText) {
      return (regionText) =>
        excerptOf(nistSectionBody(sourceText, 'lookupsecrets'), regionText, 'the #lookupsecrets body');
    },
  },
  'asvs-v6.5': {
    arg: '--asvs',
    describe: 'OWASP ASVS 5.0 §V6.5, every requirement row',
    check(sourceText) {
      return (regionText) => {
        const note = comparable(regionText);
        const rows = asvsRequirements(sourceText, /^##\s+V6\.5\s/u);
        const missing = [];
        const present = [];
        for (const row of rows) {
          // Classifier, not a filter: every derived row lands in exactly one of these two lists,
          // and a non-empty `missing` is the failure.
          if (note.includes(comparable(row.text))) present.push(row.id);
          else missing.push(row.id);
        }
        // Every requirement id the region prints, in any form the region prints them, must be an id
        // the source has. The id pattern is the shape of an ASVS requirement number, not a list of
        // the ids this file knows; a number the source does not have is `notInSource`. It is read
        // from the region AS WRITTEN and not from `note`: reading it from the comparison form would
        // make this test blind to whatever that form removes, which is how round 5's fabricated
        // `6.5.9` row reached `notInSource: []`.
        const quotedIds = [...regionText.matchAll(/(\d+\.\d+\.\d+)/gu)].map((m) => m[1]);
        const known = new Set(rows.map((r) => r.id));
        const fabricated = [...new Set(quotedIds)].filter((id) => !known.has(id));
        if (missing.length > 0 || fabricated.length > 0) {
          return { ok: false, detail: { missingFromNote: missing, notInSource: fabricated } };
        }
        // The converse direction, and the one the two assertions above do not reach. They say the
        // region carries every row and prints no unknown id; neither says the region carries
        // nothing else, so a normative sentence appended to a real row — written without a
        // requirement number, so no id test sees it, and after the row's text, so the row is still
        // contained — satisfies both. The region is therefore compared for identity against the
        // whole derived table, id and text, in the source's order: neither side may carry a
        // character the other does not.
        const wholeTable = rows.map((row) => `**${row.id}** ${row.text}`).join('\n\n');
        const bothWays = identical(wholeTable, regionText, 'the whole V6.5 requirement table');
        if (!bothWays.ok) return bothWays;
        return {
          ok: true,
          detail: `rows in source: ${rows.length}; ${bothWays.detail}, in the source's order: ${present.join(' ')}`,
        };
      };
    },
  },
  'asvs-v6.5-preamble': {
    arg: '--asvs',
    describe: "OWASP ASVS 5.0 §V6.5, the scoping preamble (an excerpt, elision declared)",
    check(sourceText) {
      const body = flattenMarkdownLinks(markdownSectionBody(sourceText, /^##\s+V6\.5\s/u));
      return (regionText) => excerptOf(body, regionText, 'the V6.5 section body');
    },
  },
  'spec-21': {
    arg: '--spec',
    describe: 'docs/spec.md § "21. Users and RBAC", whole section body',
    check(sourceText) {
      return (regionText) =>
        identical(markdownSectionBody(sourceText, /^#\s+21\.\s/u), regionText, "§21's body");
    },
  },
  'spec-20-body': {
    arg: '--spec',
    describe: 'docs/spec.md §20, the line span the note cites, whole',
    check(sourceText) {
      return (regionText, intro) => {
        const cite = citation(intro, /`docs\/spec\.md` lines (\d+)[–-](\d+)/gu, '`docs/spec.md` lines N–M');
        const span = citedSpan(sourceText, Number(cite[1]), Number(cite[2]));
        // The note collapses §20's six-line `Store:` fence onto one line and joins the fields with
        // an interpunct, and says so. Removing that interpunct from the note's side restores
        // exactly the line breaks it replaced, which comparison form has already removed from the
        // source's side; the fence delimiters the note dropped with them come off the SOURCE's side,
        // which can only make this comparison fail. Nothing else is removed from either side, and
        // nothing at all is removed from the note's.
        return identical(
          withoutFenceDelimiters(span),
          regionText.split('·').join(''),
          `docs/spec.md ${cite[1]}-${cite[2]}, its fence delimiters aside`,
        );
      };
    },
  },
  'spec-22-closing': {
    arg: '--spec',
    describe: 'docs/spec.md §22, the two closing lines the note cites',
    check(sourceText) {
      return (regionText, intro) => {
        const cite = citation(intro, /`docs\/spec\.md` (\d+) and (\d+)/gu, '`docs/spec.md` N and M');
        const span = citedSpan(sourceText, Number(cite[1]), Number(cite[2]));
        return identical(span, regionText, `docs/spec.md ${cite[1]}-${cite[2]}`);
      };
    },
  },
  'spec-47-criterion': {
    arg: '--spec',
    describe: 'docs/spec.md §47, the completion criterion, whole',
    check(sourceText) {
      const criterion = afterLabel(markdownSectionBody(sourceText, /^#\s+47\.\s/u), /^Completion criteria:\s*$/u);
      return (regionText) => identical(criterion, regionText, "§47's completion criterion");
    },
  },
  'plan-426-must-answer': {
    arg: '--plan',
    describe: 'the development plan, the R-12 card line the note cites',
    check(sourceText) {
      return (regionText, intro) => {
        const cite = citation(
          intro,
          /`docs\/DEVELOPMENT_PLAN\.md:(\d+)`/gu,
          '`docs/DEVELOPMENT_PLAN.md:N`',
        );
        const line = Number(cite[1]);
        return prefixOf(citedSpan(sourceText, line, line), regionText, `DEVELOPMENT_PLAN.md:${line}`);
      };
    },
  },
  'r01-no-probe-resumed': {
    arg: '--r01',
    describe: 'the R-01 research note, the two lines the region attributes',
    check(sourceText, sourcePath) {
      return (regionText) => {
        // Every attribution the region prints — `<file>:<line>` followed by a quoted span, in
        // straight quotes or in typographic ones — is checked against that file at that line. That
        // loop runs in one direction: it says each attributed span is in its source. The guard
        // below runs in the other, and is what makes this a classification rather than a search:
        // once the attributed entries and the block-quote markers are removed, what is left of the
        // region must be whitespace and nothing else. So a span that names no line cannot sit in
        // the region unchecked — not quoted in a style this regex does not read, not with no quote
        // marks at all, and not written in characters some narrower test would let through: round 4
        // required a straight double quote and missed a typographic one, and the letters-and-digits
        // test that replaced it let a leftover of punctuation, symbols or emoji through.
        const attribution = /`([A-Za-z0-9._-]+\.md):(\d+)`\s*—\s*(?:"([\s\S]*?)"|“([\s\S]*?)”)/gu;
        const found = [...regionText.matchAll(attribution)];
        if (found.length === 0) return { ok: false, detail: 'the region attributes no line of any file' };
        const leftover = regionText
          .replace(attribution, ' ')
          .split('\n')
          .map((line) => line.replace(/^\s*(?:>\s?)+/u, ''))
          .join('\n');
        if (leftover.trim() !== '') {
          return {
            ok: false,
            detail: { unattributedTextInRegion: leftover.replace(/\s+/gu, ' ').trim().slice(0, 160) },
          };
        }
        const checked = [];
        for (const [, file, lineNumber, straight, typographic] of found) {
          if (file !== basename(sourcePath)) {
            return { ok: false, detail: { attributesFile: file, butSourceSuppliedIs: basename(sourcePath) } };
          }
          const line = Number(lineNumber);
          const quoted = straight ?? typographic;
          const verdict = verbatimWithin(citedSpan(sourceText, line, line), quoted, `${file}:${line}`);
          if (!verdict.ok) return { ok: false, detail: { at: `${file}:${line}`, ...verdict.detail } };
          checked.push(`${file}:${line}`);
        }
        return {
          ok: true,
          detail:
            `${checked.length} attributed span(s), each contiguous within its cited line, and nothing ` +
            `but whitespace beside them in the region: ${checked.join(', ')}`,
        };
      };
    },
  },
  'rfc6265bis-host-prefix': {
    arg: '--rfc',
    describe: 'draft-ietf-httpbis-rfc6265bis-22 §4.1.3.2, the `__Host-` paragraph, whole',
    check(sourceText) {
      return (regionText) => wholeParagraphOf(sourceText, regionText, 'the draft');
    },
  },
  'owasp-samesite': {
    arg: '--owasp',
    describe: 'OWASP Session Management Cheat Sheet, the SameSite paragraph, whole',
    check(sourceText) {
      return (regionText) => wholeParagraphOf(sourceText, regionText, 'the cheat sheet');
    },
  },
  'spec-22-ui-form': {
    arg: '--spec',
    describe: 'docs/spec.md §22, the user-visible key block, whole',
    check(sourceText) {
      const body = markdownSectionBody(sourceText, /^#\s+22\.\s/u);
      return (regionText) => wholeFenceOf(body, fenceContent(regionText, 'spec-22-ui-form'), '§22');
    },
  },
  'spec-22-field-list': {
    arg: '--spec',
    describe: 'docs/spec.md §22, the field list, whole',
    check(sourceText) {
      const body = markdownSectionBody(sourceText, /^#\s+22\.\s/u);
      return (regionText) => wholeFenceOf(body, fenceContent(regionText, 'spec-22-field-list'), '§22');
    },
  },
  'sdk-cli-guard': {
    arg: '--exe',
    // A Windows executable is not UTF-8; latin1 maps every byte to one character, so the ASCII
    // fragment the note quotes survives the read and no byte is replaced.
    encoding: 'latin1',
    describe: 'claude.exe, the `--session-id` guard as extracted',
    check(sourceText) {
      // The note re-indents the extracted function across lines and says so; comparison form has
      // already removed every space from both sides, so this is the extraction character for
      // character apart from case. It is containment because the note quotes a fragment of a
      // binary and claims no boundary for it.
      return (regionText) =>
        verbatimWithin(sourceText, fenceContent(regionText, 'sdk-cli-guard'), 'the shipped CLI binary');
    },
  },
  'sdk-flag-emitter': {
    arg: '--mjs',
    describe: 'sdk.mjs, the one `--session-id` emission site',
    check(sourceText) {
      return (regionText) => {
        const quoted = fenceContent(regionText, 'sdk-flag-emitter');
        const within = verbatimWithin(sourceText, quoted, 'the shipped bundle');
        if (!within.ok) return within;
        // The note's claim is not only that this line is there but that it is the only place the
        // flag is emitted, so the occurrence count is part of what is checked. More than one, and
        // the sentence beside the block is false.
        const sites = sourceText.split('--session-id').length - 1;
        if (sites !== 1) {
          return { ok: false, detail: { sessionIdOccurrencesInBundle: sites, noteClaims: 1 } };
        }
        return { ok: true, detail: `${within.detail}; one \`--session-id\` occurrence in the bundle` };
      };
    },
  },
  'sdk-sessionkey': {
    arg: '--dts',
    describe: 'sdk.d.ts `export declare type SessionKey`, whole declaration',
    check(sourceText) {
      return (regionText) =>
        identical(
          declarationBody(sourceText, 'export declare type SessionKey = {'),
          fenceContent(regionText, 'sdk-sessionkey'),
          'the shipped declaration',
        );
    },
  },
};

// --- the derived sets -------------------------------------------------------------------------

const OPEN_QUOTE = /^<!--\s*R-12-QUOTE\s+([a-z0-9.-]+)\s*-->$/u;
const OPEN_NOTQUOTE = /^<!--\s*R-12-NOTQUOTE\s+(\S[^>]*?)\s*-->$/u;
const CLOSE_MARKER = /^<!--\s*\/R-12-(NOT)?QUOTE\s*-->$/u;

function isMarkerLine(line) {
  const trimmed = line.trim();
  return OPEN_QUOTE.test(trimmed) || OPEN_NOTQUOTE.test(trimmed) || CLOSE_MARKER.test(trimmed);
}

/** Every blockquote the note contains, in file order, derived by shape: a maximal run of lines whose
 *  first non-space character is `>`, outside fenced code blocks. This is the contributing set — not
 *  the set of blockquotes anyone marked — so a quotation added without a marker is still found here
 *  and still has to be classified below. A fence left open at the end of the file would hide every
 *  blockquote after it, so that is refused rather than scanned past. */
function derivedBlockquotes(lines) {
  const blocks = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    if (/^\s*```/u.test(lines[i])) {
      inFence = !inFence;
      i += 1;
      continue;
    }
    if (!inFence && /^\s*>/u.test(lines[i])) {
      const start = i;
      while (i < lines.length && /^\s*>/u.test(lines[i])) i += 1;
      blocks.push({ startLine: start + 1, endLine: i, first: lines[start].trim() });
      continue;
    }
    i += 1;
  }
  if (inFence) {
    throw new Error('the note ends inside an unclosed code fence, so the blockquotes below it cannot be derived');
  }
  return blocks;
}

/** Every fenced code block, by the same shape rule. Used only to assert that a region wraps
 *  something quotable; the `sdk-sessionkey` quotation is a fence rather than a blockquote. */
function derivedFences(lines) {
  const fences = [];
  let open = null;
  lines.forEach((line, index) => {
    if (!/^\s*```/u.test(line)) return;
    if (open === null) open = index + 1;
    else {
      fences.push({ startLine: open, endLine: index + 1 });
      open = null;
    }
  });
  return fences;
}

/** How far a line is indented, in columns, with a tab advancing to the next multiple of four — which
 *  is how markdown measures indentation, and it is why this is a measurement and not a character
 *  test. The previous revision tested `/^ {4,}\S/u`, literal space characters, so a block indented
 *  with one TAB was neither collected nor refused while rendering as the same `<pre><code>` element
 *  the four-space form produces. That was rule (4) refusing a spelling rather than the construct it
 *  names, and it is the defect this function's shape exists to keep out. */
function indentColumns(line) {
  let columns = 0;
  for (const character of line) {
    if (character === ' ') columns += 1;
    else if (character === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/** Every line outside a fenced block that displays a passage in one of the two forms rule (4) names:
 *  a line that opens an HTML `<blockquote>` or `<pre>` element, or an indented block — a line
 *  indented four or more columns that opens after a blank line, which markdown displays as a code
 *  block. Both put a quotation on the page where `derivedBlockquotes` and `derivedFences` do not see
 *  it, so both are refused wherever they appear, quoted-looking or not.
 *
 *  Each of the two is matched as its construct rather than as one way of writing it. Indentation is
 *  measured in columns, so a tab indents as four (see `indentColumns`). The tag name is matched
 *  wherever the tag ENDS — before whitespace, before `>`, before `/`, or at the end of the line —
 *  because an element whose attribute list begins on the following line is written `<blockquote` with
 *  nothing after it, and the previous revision's `[\s>]` did not match that, so a real, rendered
 *  `<blockquote>` walked past the rule.
 *
 *  What this does NOT reach is the CLASS. This function is a list of two element names and one indent
 *  measurement; an HTML `<div>`, `<figure>` or `<table>` element, a markdown table cell, a markdown
 *  list item, an inline quotation in a paragraph, and an unwrapped fence each display a passage and
 *  are each read by nothing here and refused by nothing here. Those are asserted, one case per form,
 *  in `R-12-quotation-limits.mjs`, so that closing one fails that file instead of leaving this comment
 *  stale. Closing the class needs an else-branch this rule does not have — every non-fence,
 *  non-blockquote block outside a region refused — and nothing here is that. */
function derivedUnreadableBlocks(lines) {
  const found = [];
  let inFence = false;
  let previousBlank = true;
  lines.forEach((line, index) => {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      previousBlank = false;
      return;
    }
    if (!inFence) {
      const tag = /<(blockquote|pre)(?=[\s>/]|$)/iu.exec(line);
      if (tag !== null) {
        found.push({ line: index + 1, form: `an HTML <${tag[1].toLowerCase()}> element`, text: line.trim() });
      } else if (previousBlank && line.trim() !== '' && indentColumns(line) >= 4) {
        found.push({ line: index + 1, form: 'an indented block', text: line.trim() });
      }
    }
    previousBlank = line.trim() === '';
  });
  return found;
}

/** Every marker region the note contains, of both kinds, with the line range it spans. Markers must
 *  be alone on their line, must nest not at all, and must close with their own kind; each of those
 *  is a failure rather than a region silently dropped or silently widened. */
function derivedRegions(lines) {
  const regions = [];
  let open = null;
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const quote = OPEN_QUOTE.exec(line);
    const notQuote = OPEN_NOTQUOTE.exec(line);
    const close = CLOSE_MARKER.exec(line);
    if (quote !== null || notQuote !== null) {
      if (open !== null) {
        throw new Error(
          `region "${open.label}" opened at line ${open.startLine} is still open where another opens at line ${index + 1}`,
        );
      }
      open = {
        kind: quote !== null ? 'quote' : 'notquote',
        label: quote !== null ? quote[1] : notQuote[1],
        startLine: index + 1,
      };
      return;
    }
    if (close !== null) {
      const kind = close[1] === undefined ? 'quote' : 'notquote';
      if (open === null) throw new Error(`the closing marker at line ${index + 1} closes no region`);
      if (open.kind !== kind) {
        throw new Error(
          `region "${open.label}" opened at line ${open.startLine} as ${open.kind} is closed at line ${index + 1} as ${kind}`,
        );
      }
      regions.push({ ...open, endLine: index + 1, text: lines.slice(open.startLine, index).join('\n') });
      open = null;
    }
  });
  if (open !== null) {
    throw new Error(`region "${open.label}" opened at line ${open.startLine} has no closing marker`);
  }
  return regions;
}

/** The paragraph that introduces the region: walking up from its opening marker, past blank and
 *  marker lines, the run of non-blank lines that ends there. This is the prose whose final
 *  punctuation decides whether the note presents the block as quoted material, and it is where a
 *  checker reads the line numbers the note cites. */
function introParagraph(lines, regionStartLine) {
  let end = regionStartLine - 2;
  while (end >= 0 && (lines[end].trim() === '' || isMarkerLine(lines[end]))) end -= 1;
  if (end < 0) return { startLine: 0, text: '' };
  let start = end;
  while (start > 0 && lines[start - 1].trim() !== '' && !isMarkerLine(lines[start - 1])) start -= 1;
  return { startLine: start + 1, text: lines.slice(start, end + 1).join('\n') };
}

function parseArguments(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`arguments are --name value pairs; got ${argv[i]}`);
    }
    args.set(argv[i], argv[i + 1]);
  }
  return args;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const notePath = args.get('--note');
  if (notePath === undefined) throw new Error('--note <path to R-12-auth-sessions-api-keys.md> is required');
  const note = readFileSync(notePath, 'utf8');
  const lines = note.split('\n');

  const blocks = derivedBlockquotes(lines);
  const fences = derivedFences(lines);
  const regions = derivedRegions(lines);
  const failures = [];

  // 1. Coverage. Every blockquote the note contains is assigned to the region that encloses it, and
  //    a blockquote no region encloses is refused by name. This is the assertion that makes the
  //    contributing set the note's blockquotes rather than the author's markers.
  console.log(`derived from ${notePath}: ${blocks.length} blockquote(s), ${regions.length} marker region(s)`);
  for (const block of blocks) {
    const owners = regions.filter((r) => r.startLine < block.startLine && r.endLine > block.endLine);
    if (owners.length === 0) {
      failures.push(
        `the blockquote at lines ${block.startLine}-${block.endLine} is inside no R-12-QUOTE or ` +
          `R-12-NOTQUOTE region, so nothing checks it and nothing rejects it — wrap it. ` +
          `It begins: ${block.first.slice(0, 90)}`,
      );
      console.log(`  lines ${block.startLine}-${block.endLine}`.padEnd(24) + 'FAIL  unclassified blockquote');
      continue;
    }
    if (owners.length > 1) {
      failures.push(
        `the blockquote at lines ${block.startLine}-${block.endLine} is inside ${owners.length} regions ` +
          `(${owners.map((r) => r.label).join(', ')}); a blockquote belongs to exactly one`,
      );
      continue;
    }
    block.region = owners[0];
  }

  // 2. Presentation. A colon closes the paragraph that introduces quoted material, so a
  //    colon-introduced blockquote must be a checked quotation and cannot be opted out.
  for (const region of regions) {
    region.intro = introParagraph(lines, region.startLine);
    const wraps =
      blocks.some((b) => b.region === region) ||
      fences.some((f) => f.startLine > region.startLine && f.endLine < region.endLine);
    if (!wraps) {
      failures.push(
        `region "${region.label}" (lines ${region.startLine}-${region.endLine}) wraps no blockquote and ` +
          `no fenced block, so it marks nothing`,
      );
    }
    if (region.kind === 'notquote' && /:$/u.test(region.intro.text.trimEnd())) {
      failures.push(
        `region "${region.label}" (lines ${region.startLine}-${region.endLine}) is marked R-12-NOTQUOTE, ` +
          `but the paragraph introducing it at line ${region.intro.startLine} ends in a colon, which ` +
          `presents what follows as quoted material. Give it an id and a checker, or reword the ` +
          `introduction so it does not present the block as a quotation`,
      );
    }
  }

  // 3. Sources. Every quote region is checked against the source its id names; every checker must
  //    still have a region.
  const seen = [];
  for (const region of regions) {
    if (region.kind === 'notquote') {
      console.log(`  ${region.label.padEnd(22)} —     the note's own words, not a quotation`);
      continue;
    }
    seen.push(region.label);
    const checker = CHECKERS[region.label];
    if (checker === undefined) {
      failures.push(`region "${region.label}" has no checker in this file — classify it or remove it`);
      console.log(`  ${region.label.padEnd(22)} FAIL  no checker`);
      continue;
    }
    const sourcePath = args.get(checker.arg);
    if (sourcePath === undefined) {
      failures.push(
        `region "${region.label}" needs ${checker.arg} <path>; it was not supplied, so the quotation is unchecked`,
      );
      console.log(`  ${region.label.padEnd(22)} FAIL  ${checker.arg} not supplied`);
      continue;
    }
    let verdict;
    try {
      const run = checker.check(readFileSync(sourcePath, checker.encoding ?? 'utf8'), sourcePath);
      verdict = run(region.text, region.intro.text);
    } catch (error) {
      failures.push(`region "${region.label}": ${error.message}`);
      console.log(`  ${region.label.padEnd(22)} FAIL  ${error.message}`);
      continue;
    }
    if (verdict.ok) {
      console.log(`  ${region.label.padEnd(22)} OK    ${checker.describe} — ${verdict.detail}`);
    } else {
      failures.push(`region "${region.label}" does not match its source: ${JSON.stringify(verdict.detail)}`);
      console.log(`  ${region.label.padEnd(22)} FAIL  ${JSON.stringify(verdict.detail)}`);
    }
  }

  // 4. Two forms neither derivation reads. A passage displayed as an HTML `<blockquote>` or `<pre>`
  //    element, or as an indented block, is invisible to both, so each is refused wherever it occurs
  //    rather than examined. This is two named forms and not the class; the forms it does not reach
  //    are listed in the header and asserted in `R-12-quotation-limits.mjs`.
  for (const block of derivedUnreadableBlocks(lines)) {
    failures.push(
      `line ${block.line} opens ${block.form}, a way of displaying a passage that neither the ` +
        `blockquote derivation nor the fence derivation reads, so a quotation written there would be ` +
        `checked by nothing. Write it as a blockquote or a fenced block inside a region. ` +
        `The line begins: ${block.text.slice(0, 90)}`,
    );
    console.log(`  line ${block.line}`.padEnd(24) + `FAIL  ${block.form}, which nothing here can read`);
  }

  for (const id of Object.keys(CHECKERS)) {
    if (!seen.includes(id)) {
      failures.push(`checker "${id}" has no region in the note — the quotation it guards is gone or its markers were dropped`);
      console.log(`  ${id.padEnd(22)} FAIL  no region in the note`);
    }
  }

  if (failures.length > 0) {
    console.error('\nQUOTATION CHECK FAILED');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\nQUOTATION CHECK PASSED');
}

try {
  main();
} catch (error) {
  console.error(`QUOTATION CHECK FAILED: ${error.message}`);
  process.exit(1);
}
