// Derives the blockquotes, fences, marker regions and unreadable blocks of the note for
// R-12-quotation-check.mjs.

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
export function derivedBlockquotes(lines) {
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
    throw new Error(
      'the note ends inside an unclosed code fence, so the blockquotes below it cannot be derived',
    );
  }
  return blocks;
}

/** Every fenced code block, by the same shape rule. Used only to assert that a region wraps
 *  something quotable; the `sdk-sessionkey` quotation is a fence rather than a blockquote. */
export function derivedFences(lines) {
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
export function derivedUnreadableBlocks(lines) {
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
        found.push({
          line: index + 1,
          form: `an HTML <${tag[1].toLowerCase()}> element`,
          text: line.trim(),
        });
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
export function derivedRegions(lines) {
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
      if (open === null)
        throw new Error(`the closing marker at line ${index + 1} closes no region`);
      if (open.kind !== kind) {
        throw new Error(
          `region "${open.label}" opened at line ${open.startLine} as ${open.kind} is closed at line ${index + 1} as ${kind}`,
        );
      }
      regions.push({
        ...open,
        endLine: index + 1,
        text: lines.slice(open.startLine, index).join('\n'),
      });
      open = null;
    }
  });
  if (open !== null) {
    throw new Error(
      `region "${open.label}" opened at line ${open.startLine} has no closing marker`,
    );
  }
  return regions;
}

/** The paragraph that introduces the region: walking up from its opening marker, past blank and
 *  marker lines, the run of non-blank lines that ends there. This is the prose whose final
 *  punctuation decides whether the note presents the block as quoted material, and it is where a
 *  checker reads the line numbers the note cites. */
export function introParagraph(lines, regionStartLine) {
  let end = regionStartLine - 2;
  while (end >= 0 && (lines[end].trim() === '' || isMarkerLine(lines[end]))) end -= 1;
  if (end < 0) return { startLine: 0, text: '' };
  let start = end;
  while (start > 0 && lines[start - 1].trim() !== '' && !isMarkerLine(lines[start - 1])) start -= 1;
  return { startLine: start + 1, text: lines.slice(start, end + 1).join('\n') };
}
