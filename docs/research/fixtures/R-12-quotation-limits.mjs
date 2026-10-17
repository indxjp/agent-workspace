// Asserts what R-12-quotation-check.mjs reads and where it stops.
//
// Why this exists. That file's header used to say its rule (4) refused "the other two block forms
// markdown offers for displaying a passage". That is an overstatement of completeness, and the
// overstatement is what stops the next reader looking (ADR-0031 clause 2): a passage displayed in an
// HTML `<div>`, `<figure>` or `<table>` element, in a markdown table cell, in a list item, inline in
// an ordinary paragraph, or in a fence nobody wrapped in a region is read by no derivation there and
// refused by no rule there, and the run exits 0 with the fabrication on the page. Verification round
// 5 also found the two forms rule (4) does name were refused by SPELLING and not by construct: a
// block indented with a TAB, and an HTML open tag whose attribute list began on the next line, both
// walked past it.
//
// So the limits are asserted here rather than described there. Each case below appends one construct
// to a copy of the note, outside every marker region, under a paragraph ending in a colon — the
// note's own mark for "what follows is quoted" — and runs the real check over the result. The case
// records the verdict the check gives that construct, REFUSED or NOT READ, and this file fails if
// any verdict changes. A limit that is later closed fails here and forces the sentence describing it
// to be rewritten; a refusal that is later broken fails here too.
//
// WHAT THIS FILE DECIDES, AND WHAT IT DOES NOT. It decides, for each construct it carries, whether
// the check names it. It does not decide that the list of constructs is complete — it cannot, for
// the same reason rule (4) cannot: both are lists, and markdown and HTML offer more than either
// enumerates. It also does not decide how a renderer displays any of them. That the HTML, table and
// list cases really do put their passage on the page was established by running each through
// GitHub's own renderer (`gh api -X POST markdown`) and reading what came back — including the two
// spellings round 5 walked past, whose rendered HTML is byte-identical to the spellings it refused —
// and those runs are recorded in PR #36 rather than re-run here. The remaining two cases, a fence and
// an inline span, display their text by construction.
//
// It needs no network and no SDK: the checkers whose sources are not supplied fail with their own
// message, and this file reads only the refusals that name a LINE. That is also its parser check —
// the REFUSED cases fail loudly if the check's failure wording drifts, so a drift cannot quietly
// turn a refusal into a NOT READ. A run that ABORTS before rule (4) is reached names no line either,
// and is given its own verdict rather than being counted as a limit, because a verdict inferred from
// silence is the mistake this file exists to catch.
//
// Usage:
//
//   node docs/research/fixtures/R-12-quotation-limits.mjs \
//     --note <the R-12 research note>
//
// Exit status 0 means every construct got the verdict recorded for it. Any other outcome exits 1 and
// names the construct whose verdict changed.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = fileURLToPath(new URL('./R-12-quotation-check.mjs', import.meta.url));

/** In no source. `grep -ci 'reused indefinitely'` over the four fetched sources returns 0, and the
 *  sentence reverses NIST SP 800-63B-4 §3.1.2.2's single-use requirement, so a construct that
 *  carries it and passes is a construct through which a fabrication reaches the page. */
const SENTENCE = 'Verifiers SHALL permit look-up secrets to be reused indefinitely by machine clients.';
const LEAD_IN = 'NIST SP 800-63B-4 §3.1.2.2 also says:';

const REFUSED = 'refused';
const NOT_READ = 'not read';
const ABORTED = 'aborted';

/** Every construct, with the verdict this check gives it. `refused` cases are rule (4)'s two named
 *  forms and rule (1)'s coverage rule; `not read` cases are the limit — each is a way of displaying
 *  a passage that no derivation here reads and no rule here refuses. */
const CASES = [
  {
    name: 'indent-four-spaces',
    verdict: REFUSED,
    note: "rule 4's indented block, the spelling round 5 wrote it for",
    block: [`    ${SENTENCE}`],
  },
  {
    name: 'indent-one-tab',
    verdict: REFUSED,
    note: 'the same block indented with a tab; the indent is measured in columns, not in space characters',
    block: [`\t${SENTENCE}`],
  },
  {
    name: 'indent-tab-then-spaces',
    verdict: REFUSED,
    note: 'a tab and two spaces, six columns',
    block: [`\t  ${SENTENCE}`],
  },
  {
    name: 'indent-space-then-tab',
    verdict: REFUSED,
    note: 'one space then a tab, which advances to column four',
    block: [` \t${SENTENCE}`],
  },
  {
    name: 'html-blockquote-one-line',
    verdict: REFUSED,
    note: "rule 4's HTML element, the spelling round 5 wrote it for",
    block: [`<blockquote>${SENTENCE}</blockquote>`],
  },
  {
    name: 'html-blockquote-attributes-next-line',
    verdict: REFUSED,
    note: 'the same element with its attribute list on the following line, so the tag name ends the line',
    block: ['<blockquote', '  cite="https://pages.nist.gov/800-63-4/sp800-63b.html">', SENTENCE, '</blockquote>'],
  },
  {
    name: 'html-pre-one-line',
    verdict: REFUSED,
    note: "rule 4's other HTML element",
    block: [`<pre>${SENTENCE}</pre>`],
  },
  {
    name: 'html-pre-attributes-next-line',
    verdict: REFUSED,
    note: 'the same, with the tag name ending the line',
    block: ['<pre', '  class="quotation">', SENTENCE, '</pre>'],
  },
  {
    name: 'blockquote-unwrapped',
    verdict: REFUSED,
    note: "rule 1's coverage rule, over the form the derivations do read",
    block: [`> ${SENTENCE}`],
  },
  {
    name: 'html-div',
    verdict: NOT_READ,
    note: 'rule 4 is a list of two element names, and this is a third',
    block: [`<div>${SENTENCE}</div>`],
  },
  {
    name: 'html-figure',
    verdict: NOT_READ,
    note: "the element HTML has for exactly this; GitHub's sanitiser strips the tags and displays the passage as prose, which is no better for a reader",
    block: ['<figure>', SENTENCE, '<figcaption>NIST SP 800-63B-4 §3.1.2.2</figcaption>', '</figure>'],
  },
  {
    name: 'html-table',
    verdict: NOT_READ,
    note: 'a passage in an HTML table cell',
    block: ['<table>', '<tr><td>NIST SP 800-63B-4 §3.1.2.2</td></tr>', `<tr><td>${SENTENCE}</td></tr>`, '</table>'],
  },
  {
    name: 'markdown-table-cell',
    verdict: NOT_READ,
    note: 'the same, in the markdown table syntax this note uses throughout',
    block: ['| NIST SP 800-63B-4 §3.1.2.2 |', '| --- |', `| ${SENTENCE} |`],
  },
  {
    name: 'markdown-list-item',
    verdict: NOT_READ,
    note: 'a quoted list item; the coverage rule is over blockquotes, and a list is not one',
    block: [`- "${SENTENCE}"`],
  },
  {
    name: 'inline-in-a-paragraph',
    verdict: NOT_READ,
    note: 'declared gap 16 — the contributing set is block-shaped, and this is not a block',
    block: [`NIST SP 800-63B-4 §3.1.2.2 also says, in the same section, *"${SENTENCE}"*`],
  },
  {
    name: 'fence-unwrapped',
    verdict: NOT_READ,
    note: 'declared gap 12 — a colon-introduced fence is also how this note prints probe output, so no coverage rule can be run over fences',
    block: ['```text', SENTENCE, '```'],
  },
];

/** The refusals the check prints that name a line of the note. Two rules produce them: rule (4),
 *  which names one line, and rule (1)'s coverage rule, which names a blockquote's range. Everything
 *  else the check reports names a region or a checker, not a line, and is ignored here — that is what
 *  lets this run without any source file. */
function lineNamingRefusals(stderrText) {
  const refusals = [];
  for (const raw of stderrText.split('\n')) {
    const failure = /^\s+- (.*)$/u.exec(raw);
    if (failure === null) continue;
    const unreadable = /^line (\d+) opens (.+?), a way of displaying a passage that neither/u.exec(failure[1]);
    if (unreadable !== null) {
      refusals.push({ line: Number(unreadable[1]), form: unreadable[2] });
      continue;
    }
    const uncovered = /^the blockquote at lines (\d+)-(\d+) is inside no R-12-QUOTE/u.exec(failure[1]);
    if (uncovered !== null) {
      refusals.push({ line: Number(uncovered[1]), form: 'an unclassified blockquote' });
    }
  }
  return refusals;
}

/** Running the check over one note. Three outcomes are distinguished, not two: the check can refuse a
 *  line, it can reach the end without naming one, or it can ABORT — `derivedBlockquotes` throws on a
 *  fence left open at the end of the file, and `derivedRegions` throws on a marker that does not
 *  nest, and either ends the run before rule (4) is reached. An abort names no line, so reading it as
 *  "no rule named this construct" would be the same mistake this whole file exists to catch: a
 *  verdict inferred from silence. It gets its own verdict instead, and a case that starts aborting is
 *  a mismatch here rather than a limit that quietly appears. */
function runCheck(notePath) {
  const run = spawnSync(process.execPath, [CHECK, '--note', notePath], { encoding: 'utf8' });
  if (run.error !== undefined) throw run.error;
  const stderr = run.stderr ?? '';
  return {
    refusals: lineNamingRefusals(stderr),
    aborted: /^QUOTATION CHECK FAILED: /mu.test(stderr),
    stderr,
  };
}

function main() {
  const args = new Map();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`arguments are --name value pairs; got ${argv[i]}`);
    }
    args.set(argv[i], argv[i + 1]);
  }
  const notePath = args.get('--note');
  if (notePath === undefined) throw new Error('--note <path to R-12-auth-sessions-api-keys.md> is required');
  const noteLines = readFileSync(notePath, 'utf8').split('\n');
  const directory = mkdtempSync(join(tmpdir(), 'r12-limits-'));
  const failures = [];

  console.log(`the check under test: ${CHECK}`);
  console.log(`the note it is run over: ${notePath}, ${noteLines.length} lines`);

  // The baseline. Every case appends to this note, so a refusal the note already carries would be
  // read as the appended construct's. It carries none: no unclassified blockquote, and no block in a
  // form neither derivation reads. This assertion needs no source file, so it is the one part of
  // probe M that can be re-run anywhere.
  const baseline = runCheck(notePath);
  if (baseline.aborted) {
    failures.push(
      `the check aborts on the unmodified note, so it never reaches rule (4) and no case below means ` +
        `anything. Its message: ${baseline.stderr.trim().split('\n')[0]}`,
    );
    console.log('\n  ' + 'baseline'.padEnd(38) + 'FAIL  the check aborts on the unmodified note');
  } else if (baseline.refusals.length === 0) {
    console.log('\n  ' + 'baseline'.padEnd(38) + 'OK    no refusal of the unmodified note names any line');
  } else {
    failures.push(
      `the unmodified note is already refused at ${baseline.refusals.map((r) => `line ${r.line} (${r.form})`).join(', ')}, ` +
        `so no case below can be attributed to what it appends`,
    );
    console.log('\n  ' + 'baseline'.padEnd(38) + 'FAIL  the unmodified note is already refused');
  }

  for (const testCase of CASES) {
    const appendedAt = noteLines.length + 3;
    const mutated = [...noteLines, '', LEAD_IN, '', ...testCase.block, ''].join('\n');
    const path = join(directory, `${testCase.name}.md`);
    writeFileSync(path, mutated, 'utf8');
    const run = runCheck(path);
    const mine = run.refusals.filter((r) => r.line >= appendedAt);
    let verdict = NOT_READ;
    let detail = 'named by no rule; the run reaches no verdict on it';
    if (run.aborted) {
      verdict = ABORTED;
      detail = `the check aborted: ${run.stderr.trim().split('\n')[0]}`;
    } else if (mine.length > 0) {
      verdict = REFUSED;
      detail = mine.map((r) => `${r.form} at line ${r.line}`).join('; ');
    }
    if (verdict === testCase.verdict) {
      console.log(`  ${testCase.name.padEnd(38)}OK    ${verdict.toUpperCase().padEnd(8)} — ${detail}`);
    } else {
      failures.push(
        `${testCase.name} is recorded as ${testCase.verdict.toUpperCase()} (${testCase.note}) but the check gives ` +
          `${verdict.toUpperCase()}: ${detail}. Either the check changed, in which case rewrite this case and every ` +
          `sentence that describes rule (4), or the parser above no longer matches the check's wording`,
      );
      console.log(`  ${testCase.name.padEnd(38)}FAIL  expected ${testCase.verdict.toUpperCase()}, got ${verdict.toUpperCase()}`);
    }
  }

  console.log(
    `\n${CASES.filter((c) => c.verdict === REFUSED).length} construct(s) refused, ` +
      `${CASES.filter((c) => c.verdict === NOT_READ).length} read by nothing here — the second number is the limit, ` +
      `and it is not a complete list of the forms outside this check's reach`,
  );

  if (failures.length > 0) {
    console.error('\nLIMITS CHECK FAILED');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\nLIMITS CHECK PASSED');
}

try {
  main();
} catch (error) {
  console.error(`LIMITS CHECK FAILED: ${error.message}`);
  process.exit(1);
}
