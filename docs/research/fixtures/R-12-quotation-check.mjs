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

import { readFileSync } from 'node:fs';
import { CHECKERS } from './R-12-quotation-checkers.mjs';
import {
  derivedBlockquotes,
  derivedFences,
  derivedRegions,
  derivedUnreadableBlocks,
  introParagraph,
} from './R-12-quotation-regions.mjs';

const LABEL_WIDTH = 22;

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

function regionRange(region) {
  return `lines ${region.startLine}-${region.endLine}`;
}

/** 1. Coverage. Every blockquote the note contains is assigned to the region that encloses it, and
 *  a blockquote no region encloses is refused by name. This is the assertion that makes the
 *  contributing set the note's blockquotes rather than the author's markers. */
function assignBlockquotes(blocks, regions, failures) {
  for (const block of blocks) {
    const owners = regions.filter(
      (r) => r.startLine < block.startLine && r.endLine > block.endLine,
    );
    if (owners.length === 0) {
      failures.push(
        `the blockquote at lines ${block.startLine}-${block.endLine} is inside no R-12-QUOTE or ` +
          `R-12-NOTQUOTE region, so nothing checks it and nothing rejects it — wrap it. ` +
          `It begins: ${block.first.slice(0, 90)}`,
      );
      console.log(
        `  lines ${block.startLine}-${block.endLine}`.padEnd(24) + 'FAIL  unclassified blockquote',
      );
    } else if (owners.length > 1) {
      failures.push(
        `the blockquote at lines ${block.startLine}-${block.endLine} is inside ${owners.length} regions ` +
          `(${owners.map((r) => r.label).join(', ')}); a blockquote belongs to exactly one`,
      );
    } else {
      block.region = owners[0];
    }
  }
}

/** 2. Presentation. A colon closes the paragraph that introduces quoted material, so a
 *  colon-introduced blockquote must be a checked quotation and cannot be opted out. */
function checkPresentation(lines, regions, blocks, fences, failures) {
  for (const region of regions) {
    region.intro = introParagraph(lines, region.startLine);
    const wraps =
      blocks.some((b) => b.region === region) ||
      fences.some((f) => f.startLine > region.startLine && f.endLine < region.endLine);
    if (!wraps) {
      failures.push(
        `region "${region.label}" (${regionRange(region)}) wraps no blockquote and ` +
          `no fenced block, so it marks nothing`,
      );
    }
    if (region.kind === 'notquote' && /:$/u.test(region.intro.text.trimEnd())) {
      failures.push(
        `region "${region.label}" (${regionRange(region)}) is marked R-12-NOTQUOTE, ` +
          `but the paragraph introducing it at line ${region.intro.startLine} ends in a colon, which ` +
          `presents what follows as quoted material. Give it an id and a checker, or reword the ` +
          `introduction so it does not present the block as a quotation`,
      );
    }
  }
}

function reportFailure(failures, label, failureMessage, consoleDetail) {
  failures.push(failureMessage);
  console.log(`  ${label.padEnd(LABEL_WIDTH)} FAIL  ${consoleDetail}`);
}

/** Runs one quote region's checker against its source, or returns the failure to report. */
function verdictFor(region, checker, args) {
  const sourcePath = args.get(checker.arg);
  if (sourcePath === undefined) {
    return {
      message: `region "${region.label}" needs ${checker.arg} <path>; it was not supplied, so the quotation is unchecked`,
      console: `${checker.arg} not supplied`,
    };
  }
  let verdict;
  try {
    const run = checker.check(readFileSync(sourcePath, checker.encoding ?? 'utf8'), sourcePath);
    verdict = run(region.text, region.intro.text);
  } catch (error) {
    return { message: `region "${region.label}": ${error.message}`, console: error.message };
  }
  if (!verdict.ok) {
    return {
      message: `region "${region.label}" does not match its source: ${JSON.stringify(verdict.detail)}`,
      console: JSON.stringify(verdict.detail),
    };
  }
  console.log(
    `  ${region.label.padEnd(LABEL_WIDTH)} OK    ${checker.describe} — ${verdict.detail}`,
  );
  return undefined;
}

/** 3. Sources. Every quote region is checked against the source its id names; every checker must
 *  still have a region. Returns the labels of the quote regions seen. */
function checkSources(regions, args, failures) {
  const seen = [];
  for (const region of regions) {
    if (region.kind === 'notquote') {
      console.log(
        `  ${region.label.padEnd(LABEL_WIDTH)} —     the note's own words, not a quotation`,
      );
      continue;
    }
    seen.push(region.label);
    const checker = CHECKERS[region.label];
    if (checker === undefined) {
      reportFailure(
        failures,
        region.label,
        `region "${region.label}" has no checker in this file — classify it or remove it`,
        'no checker',
      );
      continue;
    }
    const failure = verdictFor(region, checker, args);
    if (failure !== undefined)
      reportFailure(failures, region.label, failure.message, failure.console);
  }
  return seen;
}

/** 4. Two forms neither derivation reads. A passage displayed as an HTML `<blockquote>` or `<pre>`
 *  element, or as an indented block, is invisible to both, so each is refused wherever it occurs
 *  rather than examined. This is two named forms and not the class; the forms it does not reach
 *  are listed in the header and asserted in `R-12-quotation-limits.mjs`. */
function refuseUnreadableForms(lines, failures) {
  for (const block of derivedUnreadableBlocks(lines)) {
    failures.push(
      `line ${block.line} opens ${block.form}, a way of displaying a passage that neither the ` +
        `blockquote derivation nor the fence derivation reads, so a quotation written there would be ` +
        `checked by nothing. Write it as a blockquote or a fenced block inside a region. ` +
        `The line begins: ${block.text.slice(0, 90)}`,
    );
    console.log(
      `  line ${block.line}`.padEnd(24) + `FAIL  ${block.form}, which nothing here can read`,
    );
  }
}

function requireEveryCheckerUsed(seen, failures) {
  for (const id of Object.keys(CHECKERS)) {
    if (!seen.includes(id)) {
      reportFailure(
        failures,
        id,
        `checker "${id}" has no region in the note — the quotation it guards is gone or its markers were dropped`,
        'no region in the note',
      );
    }
  }
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const notePath = args.get('--note');
  if (notePath === undefined)
    throw new Error('--note <path to R-12-auth-sessions-api-keys.md> is required');
  const lines = readFileSync(notePath, 'utf8').split('\n');

  const blocks = derivedBlockquotes(lines);
  const fences = derivedFences(lines);
  const regions = derivedRegions(lines);
  const failures = [];

  console.log(
    `derived from ${notePath}: ${blocks.length} blockquote(s), ${regions.length} marker region(s)`,
  );
  assignBlockquotes(blocks, regions, failures);
  checkPresentation(lines, regions, blocks, fences, failures);
  const seen = checkSources(regions, args, failures);
  refuseUnreadableForms(lines, failures);
  requireEveryCheckerUsed(seen, failures);

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
