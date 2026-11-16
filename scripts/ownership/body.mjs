import { requiredValue } from './invariants.mjs';
import { matchAny, normalizeGlob, splitTopLevel } from './globs.mjs';
import { ownsEverything } from './reach.mjs';
export { areasFromTree, ownsEverything, trackedAreaNames } from './reach.mjs';

// ── PR-body parsing ─────────────────────────────────────────────────────────────────────
// This parser IS the §2.3 gate: everything downstream trusts the globs it hands back, so it
// is written to fail loudly and never permissively. Four rules, each of which was a real
// bypass before it existed:
//
//   1. Fenced (``` / ~~~) and indented code blocks are stripped BEFORE parsing. A PR body
//      that quotes the ownership template — which the plans carry inside a
//      ````markdown fence — otherwise gets that quoted `Owns globs:` line read in place of the
//      real declaration. Quoting the template is not declaring it.
//   2. Exactly one `## Ownership` section. Zero or several is an error, not a guess at
//      which one governs.
//   3. Exactly one `Owns globs:` line inside that section, and the section ends at the
//      next heading of any level.
//   4. A declaration that reaches across the whole repository is refused: at that reach the
//      gate can no longer tell this task's diff from a wandering one. "Reaches across" is
//      three specific questions (see ownsEverything), each decided by asking matchGlob what
//      the globs MATCH — never by blacklisting the spellings `**`, `*`, `**/*`, since a
//      spelling list is walked around with `**/**` or `**/*.*`. All three questions are asked
//      of each glob on its own and of the declared set together.
//
// CRLF and lone-CR bodies are normalised to LF before any of this runs, so a PR opened from
// a Windows client is parsed identically to one opened from a Unix client.
//
// Every failure path returns { ok: false, reason } and every caller turns that into a
// non-zero exit. There is deliberately no permissive fallback.

/**
 * Blank out fenced and indented code blocks, preserving line count so a body's structure
 * (headings, sections) is otherwise untouched. An unterminated fence swallows the rest of
 * the body, which fails closed: the Ownership section then reads as absent.
 *
 * CRLF and lone-CR bodies are normalised to LF FIRST. GitHub stores whatever the author's
 * client sent, so a PR opened from a Windows editor arrives CRLF; without this, OWNS_LINE's
 * `(.*)$` cannot span the trailing \r (JS `.` excludes \r, and `$` without /m wants true
 * end-of-string) and the gate fails with "the section has no Owns globs: line" — closed, but
 * blaming the author for a line they did write.
 */
/** @param {unknown} body */
export function stripCodeBlocks(body) {
  const out = [];
  let fence = null; // the opening run of fence characters, e.g. '```'
  for (const line of String(body).replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (
        close &&
        requiredValue(close[1], 'closing fence capture exists')[0] === fence[0] &&
        requiredValue(close[1], 'closing fence capture exists').length >= fence.length
      )
        fence = null;
      out.push('');
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    // A backtick fence's info string may not itself contain a backtick (CommonMark).
    if (
      open &&
      !(
        requiredValue(open[1], 'opening fence capture exists')[0] === '`' &&
        requiredValue(open[2], 'fence info capture exists').includes('`')
      )
    ) {
      fence = requiredValue(open[1], 'opening fence capture exists');
      out.push('');
      continue;
    }
    // Indented code block. The ownership template puts headings and the `Owns globs:` line at the left
    // margin, so a line indented four spaces or a tab is quoted matter, not a declaration.
    if (/^(?: {4}|\t)/.test(line)) {
      out.push('');
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

const HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

// Group 1 is the emphasis run that OPENS the label (`**Owns globs`), group 2 the value. The
// closing run of a bolded label may sit on either side of the colon — `**Owns globs**:` is
// handled by the `\**` before the colon, `**Owns globs:**` by ownsValue() below, which needs
// group 1 to know that a closing run is expected at all.
const OWNS_LINE = /^ {0,3}(?:[-*+]\s+)?(\*{1,3})?\s*Owns\s*globs\s*\**\s*:\s*(.*)$/i;

/**
 * The value of an `Owns globs:` line, with a `**Owns globs:** …` closing emphasis run removed.
 *
 * This cannot be folded into OWNS_LINE as a plain emphasis run after the colon: a declaration
 * whose first glob legitimately starts with a doubled star would then have that star eaten and
 * would silently NARROW, which is the worst possible failure for this parser. So the run is
 * stripped only when the label opened with one AND the character after the run is not a slash —
 * a space or a backtick means closing emphasis, a slash means the glob has begun.
 */
/** @param {RegExpExecArray} match */
function ownsValue(match) {
  const open = match[1];
  const raw = requiredValue(match[2], 'ownership value capture exists').trim();
  if (!open || !raw.startsWith(open)) return raw;
  const rest = raw.slice(open.length);
  if (rest.startsWith('/')) return raw;
  return rest.trim();
}

/**
 * The lines of the one `## Ownership` section, or the reason there is not exactly one.
 * @returns {{ok: true, lines: string[]} | {ok: false, reason: string}}
 */
/** @param {string} body
 * @returns {{ok:true,lines:string[]}|{ok:false,reason:string}} */
function ownershipSection(body) {
  const lines = stripCodeBlocks(body).split('\n');
  /** @type {string[][]} */
  const sections = [];
  /** @type {string[]|null} */
  let current = null;
  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h) {
      current = /^ownership$/i.test(requiredValue(h[1], 'heading capture exists').trim())
        ? []
        : null;
      if (current) sections.push(current);
      continue;
    }
    if (current) current.push(line);
  }
  if (sections.length === 0) {
    return {
      ok: false,
      reason:
        'the PR body has no "## Ownership" section. the Ownership section in CONTRIBUTING.md requires one, and §2.3 cannot be checked without it. (Fenced code blocks are ignored, so quoting the template does not count as declaring it.)',
    };
  }
  if (sections.length > 1) {
    return {
      ok: false,
      reason: `the PR body has ${sections.length} "## Ownership" sections; exactly one is required, so which one governs is ambiguous.`,
    };
  }
  return { ok: true, lines: requiredValue(sections[0], 'exactly one ownership section exists') };
}

/**
 * Parse the `## Ownership` section of a PR body that follows the ownership template.
 * @returns {{ok: true, globs: string[]} | {ok: false, reason: string}}
 */
/** @param {string} body
 * @returns {{ok:true,globs:string[]}|{ok:false,reason:string}} */
export function parseOwnership(body) {
  const found = ownershipSection(body);
  if (!found.ok) return found;
  const owns = found.lines.map((l) => OWNS_LINE.exec(l)).filter((match) => match !== null);
  if (owns.length === 0) {
    return { ok: false, reason: 'the "## Ownership" section has no "Owns globs:" line.' };
  }
  if (owns.length > 1) {
    return {
      ok: false,
      reason: `the "## Ownership" section has ${owns.length} "Owns globs:" lines; exactly one is required.`,
    };
  }

  const raw = ownsValue(requiredValue(owns[0], 'exactly one ownership declaration exists'));
  if (!raw || /^(none|n\/a)\.?$/i.test(raw)) return { ok: true, globs: [] };
  // Split on commas OUTSIDE any brace list: `packages/**, *.{json,mjs}` is two globs. A plain
  // `.split(',')` tore that into `*.{json` and `mjs}`, which match nothing, so a legitimate
  // brace declaration silently became an empty one and the gate then blamed the diff.
  const declared = splitTopLevel(raw)
    .map((s) =>
      s
        .trim()
        .replace(/^`+|`+$/g, '')
        .trim(),
    )
    .filter(Boolean);
  if (declared.length === 0) return { ok: true, globs: [] };

  const placeholder = declared.find((g) => /^<.*>$/.test(g));
  if (placeholder) {
    return {
      ok: false,
      reason: `the "Owns globs:" line still carries the template placeholder \`${placeholder}\`. Replace it with the globs from the task card — an unfilled placeholder matches no file, so every changed file would be reported as out of bounds for the wrong reason.`,
    };
  }

  // NORMALISE BEFORE GUARDING. The whole-repo guard below runs with { root: null } so its
  // answer never depends on what happens to exist on disk — but the enforcer (findViolations
  // → matchAny → normalizeGlob) runs with the real root, where a wildcard-free path that IS a
  // directory means "everything under it". Guarding the raw spelling therefore asked a
  // different question from the one enforcement answers, and the gap was a bypass: the guard
  // rejects `apps/**, packages/**, .github/**, docs/**, scripts/**, ui/**, *.*` and used to
  // ACCEPT `apps, packages, .github, docs, scripts, ui, *.*`, which enforcement expands into
  // exactly the same claim on the whole tree. Normalising here closes it, and returning the
  // normalised globs keeps everything downstream matching what was actually checked.
  const globs = declared.map((g) => normalizeGlob(g));

  for (const g of globs) {
    const why = ownsEverything([g]);
    if (why) {
      return {
        ok: false,
        reason: `the "Owns globs:" line declares \`${g}\`, which claims the repository rather than one task's part of it: ${why}. That is not a declaration, it is a disabled gate — list the real globs.`,
      };
    }
  }
  const whySet = ownsEverything(globs);
  if (whySet) {
    return {
      ok: false,
      reason: `the "Owns globs:" line declares ${globs.map((g) => `\`${g}\``).join(', ')}, which together claim the repository rather than one task's part of it: ${whySet}. Split the work, or escalate (the development plan §3.5) — a declaration of that reach gates nothing.`,
    };
  }
  return { ok: true, globs };
}

// ── Integration mode: a merge is attributed to the parent that introduced each file ──────
//
// `--pr` compares one diff against one declaration, and a wave integration branch cannot
// satisfy it: its whole purpose is to carry files five other tasks wrote. Wave 1a measured
// this — 83 changed files, 3 of them the integrator's — and
// docs/adr/W1a-INT-the-ownership-gate-has-no-shape-for-a-merge.md records both the failure and
// the shape of the fix, which is implemented here.
//
// The property being checked is NOT "every changed file is mine". It is the one that actually
// matters on a merge:
//
//     every changed file is inside the declared globs of the branch whose merge introduced it,
//     or inside the integrator's own globs
//
// and — the ADR-0015 half — **a file that can be attributed to no parent and is outside the
// integrator's own globs FAILS.** There is no "not mine, so probably fine" path. Attribution
// comes from the commit graph, which cannot be edited by a PR body; the per-branch globs come
// from the body, which is where a declaration lives (ADR-0018), and each is put through the same
// whole-repository reach guard as an ordinary Owns line, so "Merged X: **" gates nothing either.

/**
 * A `Merged <ref>: <globs>` line inside the `## Ownership` section.
 *
 * `<ref>` is anything git can resolve — a branch name, a tag, a SHA. It is resolved and matched
 * against the merge parents found in the graph; a declaration naming a ref that is not a parent
 * of any merge on this branch is an error, not a no-op, because it means the body and the branch
 * disagree about what was merged.
 */
const MERGED_LINE = /^ {0,3}(?:[-*+]\s+)?\**\s*Merged\s+(\S+?)\s*\**\s*:\s*(.*)$/i;

/**
 * Parse an integration PR body: the integrator's own globs, plus one declaration per merged ref.
 * @returns {{ok: true, globs: string[], merged: {ref: string, globs: string[]}[]}
 *          | {ok: false, reason: string}}
 */
/** @param {string} body
 * @returns {{ok:true,globs:string[],merged:{ref:string,globs:string[]}[]}|{ok:false,reason:string}} */
export function parseIntegrationOwnership(body) {
  const own = parseOwnership(body);
  if (!own.ok) return own;
  const section = ownershipSection(body);
  if (!section.ok) return section;

  const merged = [];
  for (const line of section.lines) {
    const m = MERGED_LINE.exec(line);
    if (!m) continue;
    const ref = requiredValue(m[1], 'merged ref capture exists').replace(/^`+|`+$/g, '');
    const raw = requiredValue(m[2], 'merged globs capture exists').trim();
    if (!raw || /^(none|n\/a)\.?$/i.test(raw)) {
      merged.push({ ref, globs: [] });
      continue;
    }
    const declared = splitTopLevel(raw)
      .map((s) =>
        s
          .trim()
          .replace(/^`+|`+$/g, '')
          .trim(),
      )
      .filter(Boolean)
      .map((g) => normalizeGlob(g));
    const why = ownsEverything(declared);
    if (why) {
      return {
        ok: false,
        reason: `the "Merged ${ref}:" line declares ${declared.map((g) => `\`${g}\``).join(', ')}, which together claim the repository rather than one task's part of it: ${why}. A merged branch's declaration is one task's, and is held to the same reach as any other.`,
      };
    }
    merged.push({ ref, globs: declared });
  }
  if (merged.length === 0) {
    return {
      ok: false,
      reason:
        'the "## Ownership" section has no "Merged <ref>: <globs>" line. An integration PR declares, per merged branch, the globs that branch declared on its own PR — that is what makes this a check rather than an exemption. If nothing was merged, this is not an integration PR: use --pr.',
    };
  }
  return { ok: true, globs: own.globs, merged };
}

/**
 * Decide every changed file against the integrator's globs and the merged branches' globs.
 *
 * Pure, so the self-test can exercise it without a repository. `parents` is the attribution
 * already computed from the graph: for each merged parent, the files that parent introduced.
 *
 * A file is accounted for when it is inside the integrator's own globs, or inside the globs of
 * at least one parent that introduced it. Two parents can legitimately introduce the same file —
 * `docs/adr/README.md` and `pnpm-lock.yaml` are generated and arrive from several branches
 * (ADR-0017 rules 2 and 3) — so any one of them vouching for it is enough. Everything else is a
 * violation, and the reason says which of the two ways it failed, because they call for different
 * repairs: an unattributed file is an integrator edit that was not declared, and an attributed one
 * outside its parent's globs is that branch having written outside its own declaration.
 *
 * @returns {{file: string, why: string}[]}
 */
/** @param {readonly string[]} ownGlobs
 * @param {readonly import('./types.mjs').AttributedParent[]} parents
 * @param {readonly string[]} changedFiles
 * @param {import('./types.mjs').GlobOptions} [opts] */
export function findIntegrationViolations(ownGlobs, parents, changedFiles, opts) {
  const out = [];
  for (const file of changedFiles) {
    if (!file) continue;
    if (matchAny(ownGlobs, file, opts)) continue;
    const introducedBy = parents.filter((p) => p.files.includes(file));
    if (introducedBy.length === 0) {
      out.push({
        file,
        why: 'no merged parent introduced it and it is outside the integrator’s own Owns globs',
      });
      continue;
    }
    if (introducedBy.some((p) => matchAny(p.globs, file, opts))) continue;
    out.push({
      file,
      why: `introduced by ${introducedBy.map((p) => p.ref).join(', ')}, but outside the globs declared for ${introducedBy.length > 1 ? 'any of them' : 'it'}`,
    });
  }
  return out;
}
