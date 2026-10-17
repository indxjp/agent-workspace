#!/usr/bin/env node
// File-ownership checker — the development plan §2.3, §9.1.
//
// Parallelism in this repository is bought with file ownership: two tasks may run
// concurrently only if their declared `Owns:` globs do not intersect. This script is the
// mechanical half of that rule. Zero dependencies, plain Node ESM (§40: a glob matcher is
// ~50 lines of clear code and does not justify a package).
//
//   node scripts/check-file-ownership.mjs --plan <wave-script.mjs> [...]
//       Parse the ownership declarations out of committed wave workflow scripts and fail if
//       two tasks at the same parallel level declare intersecting globs.
//
//   node scripts/check-file-ownership.mjs --pr [--base <ref>] [--head <ref>]
//       Read the PR body from $GITHUB_EVENT_PATH (or stdin), take the `Owns globs:` line from
//       its `## Ownership` section, and fail listing every changed file outside those globs.
//
//   node scripts/check-file-ownership.mjs --integration [--base <ref>] [--head <ref>]
//       The same, for a wave integration branch, where --pr cannot pass: its diff carries every
//       file the merged branches wrote. Reads the same PR body, and additionally one
//       `Merged <ref>: <globs>` line per merged branch. Each changed file is attributed to the
//       merge parent that introduced it, and must be inside THAT branch's declared globs; a file
//       no parent introduced must be inside the integrator's own `Owns globs:`. A file that is
//       neither FAILS — attribution is a positive rule, not an exemption for merges. See
//       docs/adr/W1-INT-02-the-ownership-gate-learns-about-merges.md.
//
//   node scripts/check-file-ownership.mjs --self-test
//       Run the built-in assertions for the glob matcher, the intersection detector, the
//       PR-body parser and the ownership enforcer. `.github/workflows/ci.yml` runs this as
//       its own step ("Ownership checker self-test") on every PR and every push, so a
//       regression here fails CI. It is not covered by `pnpm test`: vitest.config.ts sets
//       projects to 'apps/*' and 'packages/*' (with passWithNoTests, per
//       docs/adr/W0-INF-01-vitest-projects-follow-the-workspace.md — the record is now named
//       for its owning task, so the path is stable and is cited instead of the slug; the
//       number it used to carry belongs to ADR-0001, an unrelated decision), and
//       scripts/ matches neither, so it is not a Vitest project at all — and that file is
//       owned by W0-INF-01 (plan §6.2, W0-INF-01's Owns column), not by this task.
//
//   node scripts/check-file-ownership.mjs           (no arguments)
//       Equivalent to --plan over every script in .claude/workflows/.
//
// A wave script declares ownership in either of two shapes. An object literal:
//
//   export const ownership = {
//     Foundation: { 'W1-DB-01': ['migrations/**'] },
//     Implement:  { 'W1-RN-01': ['apps/runner/**'], 'W1-UI-01': ['apps/web/app/**'] },
//   }
//
// or line comments, whose level is the nearest preceding phase() call:
//
//   phase('Implement')
//   // Owns W1-RN-01: apps/runner/**, packages/core/src/runner/**

/* global console, process */ // The root ESLint config declares no environment globals.

import { readFileSync, existsSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

// ── Glob matching ───────────────────────────────────────────────────────────────────────
// Supported: ** (any number of path segments), * (any run within one segment), ? (one
// character within one segment), {a,b} brace lists. Nothing else — deliberately.

/** Expand `{a,b}` lists into the flat list of alternative patterns. */
export function expandBraces(pattern) {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}') {
      depth--;
      if (depth === 0) {
        const head = pattern.slice(0, open);
        const tail = pattern.slice(i + 1);
        const parts = splitTopLevel(pattern.slice(open + 1, i));
        return parts.flatMap((p) => expandBraces(head + p + tail));
      }
    }
  }
  return [pattern]; // unbalanced brace: treat literally
}

/**
 * Split on commas that are not inside a `{...}` list. Used both to expand brace lists and to
 * cut an `Owns globs:` line into globs — `a/**, *.{json,mjs}` is two globs, not three.
 */
function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '{') depth++;
    if (ch === '}') depth = Math.max(0, depth - 1); // an unbalanced `}` must not go negative
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Canonical form of a declared glob. `dir/` and a wildcard-free path that is a real directory
 * both mean "everything under it", which is how humans write an Owns line.
 */
export function normalizeGlob(glob, { root = REPO_ROOT } = {}) {
  let g = String(glob)
    .trim()
    .replace(/^`|`$/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();
  g = g.replace(/^\.\//, '').replace(/^\/+/, '');
  if (g.endsWith('/')) return g + '**';
  if (!/[*?{}]/.test(g)) {
    try {
      if (root && existsSync(path.join(root, g)) && statSync(path.join(root, g)).isDirectory()) {
        return g + '/**';
      }
    } catch {
      /* not a directory we can stat — leave it as an exact path */
    }
  }
  return g;
}

function segmentToRegExp(seg) {
  let out = '';
  for (const ch of seg) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

function globToRegExp(glob) {
  const segs = glob.split('/');
  let src = '^';
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1;
    if (segs[i] === '**') {
      src += last ? '.+' : '(?:[^/]+/)*';
      continue;
    }
    src += segmentToRegExp(segs[i]);
    if (!last) src += '/';
  }
  return new RegExp(src + '$');
}

/** Does `filePath` fall inside `glob`? */
export function matchGlob(glob, filePath, opts) {
  const file = String(filePath).replace(/^\.\//, '');
  return expandBraces(normalizeGlob(glob, opts)).some((g) => globToRegExp(g).test(file));
}

/** Does `filePath` fall inside any of `globs`? */
export function matchAny(globs, filePath, opts) {
  return globs.some((g) => matchGlob(g, filePath, opts));
}

// ── Intersection of two globs ───────────────────────────────────────────────────────────

/** The leading literal path portion of a glob, i.e. everything before the first wildcard. */
export function literalPrefix(glob) {
  const segs = glob.split('/');
  const out = [];
  for (const s of segs) {
    if (/[*?{}]/.test(s)) break;
    out.push(s);
  }
  return out.join('/');
}

/**
 * Cheap necessary condition: one glob's literal prefix must be a segment-aligned prefix of the
 * other's, otherwise no string can satisfy both. Used as the pre-filter the plan asks for; the
 * structural test below then decides, because prefix overlap alone over-reports (for example
 * `packages/core/*.json` and `packages/core/src/**` share a prefix but never a file).
 */
export function literalPrefixOverlap(a, b) {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  const [short, long] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  if (short === '') return true;
  return long === short || long.startsWith(short + '/');
}

/** Can two single-segment patterns (`*`, `?`, literals) generate a common string? */
function segmentsIntersect(p, q) {
  const memo = new Map();
  const go = (i, j) => {
    const key = i * (q.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    let r;
    if (i === p.length && j === q.length) r = true;
    else if (i === p.length) r = [...q.slice(j)].every((c) => c === '*');
    else if (j === q.length) r = [...p.slice(i)].every((c) => c === '*');
    else if (p[i] === '*') r = go(i + 1, j) || go(i, j + 1);
    else if (q[j] === '*') r = go(i, j + 1) || go(i + 1, j);
    else if (p[i] === '?' || q[j] === '?' || p[i] === q[j]) r = go(i + 1, j + 1);
    else r = false;
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

/** Can two brace-free globs match a common path? Segment-wise, `**` spanning any run. */
function patternsIntersect(a, b) {
  const A = a.split('/');
  const B = b.split('/');
  const memo = new Map();
  const go = (i, j) => {
    const key = i * (B.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    let r;
    if (i === A.length && j === B.length) r = true;
    else if (i === A.length) r = B.slice(j).every((s) => s === '**');
    else if (j === B.length) r = A.slice(i).every((s) => s === '**');
    else if (A[i] === '**') r = go(i + 1, j) || go(i, j + 1);
    else if (B[j] === '**') r = go(i, j + 1) || go(i + 1, j);
    else r = segmentsIntersect(A[i], B[j]) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

/**
 * Decide whether two declared globs overlap, by both routes the plan requires: expansion
 * against the real repository tree, and a literal comparison that still catches globs which
 * match nothing today but obviously overlap.
 */
export function globsIntersect(globA, globB, files = [], opts) {
  const as = expandBraces(normalizeGlob(globA, opts));
  const bs = expandBraces(normalizeGlob(globB, opts));

  const shared = files.filter(
    (f) => as.some((g) => globToRegExp(g).test(f)) && bs.some((g) => globToRegExp(g).test(f)),
  );
  if (shared.length) {
    return { intersects: true, reason: 'tree', evidence: shared.slice(0, 5) };
  }
  for (const a of as) {
    for (const b of bs) {
      if (literalPrefixOverlap(a, b) && patternsIntersect(a, b)) {
        return { intersects: true, reason: 'literal', evidence: [`${a} ⋂ ${b}`] };
      }
    }
  }
  return { intersects: false, reason: 'disjoint', evidence: [] };
}

// ── Ownership enforcement (the --pr rule, isolated so it is unit-testable) ───────────────

/** Every changed file that no declared glob covers. */
export function findViolations(ownedGlobs, changedFiles, opts) {
  return changedFiles.filter((f) => f && !matchAny(ownedGlobs, f, opts));
}

// ── Repository tree ─────────────────────────────────────────────────────────────────────

function nulSeparatedPaths(output) {
  return output.split('\0').filter(Boolean);
}

function trackedFiles() {
  try {
    return nulSeparatedPaths(
      execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' }),
    );
  } catch {
    return [];
  }
}

// ── Parsing ownership declarations out of a wave workflow script ────────────────────────

const TASK_ID = /\b([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,3})\b/;

/** Tolerant reader for the JS object-literal subset used by an `ownership` manifest. */
function readLiteral(src, start) {
  let i = start;
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('//', i)) {
        while (i < src.length && src[i] !== '\n') i++;
      } else if (src.startsWith('/*', i)) {
        i = src.indexOf('*/', i) + 2;
      } else return;
    }
  };
  const str = () => {
    const quote = src[i++];
    let out = '';
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\') {
        out += src[i + 1];
        i += 2;
      } else out += src[i++];
    }
    i++;
    return out;
  };
  const value = () => {
    ws();
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') return str();
    if (ch === '[') {
      i++;
      const arr = [];
      for (;;) {
        ws();
        if (src[i] === ']') {
          i++;
          return arr;
        }
        arr.push(value());
        ws();
        if (src[i] === ',') i++;
      }
    }
    if (ch === '{') {
      i++;
      const obj = {};
      for (;;) {
        ws();
        if (src[i] === '}') {
          i++;
          return obj;
        }
        let key;
        if (src[i] === '"' || src[i] === "'" || src[i] === '`') key = str();
        else {
          const m = /^[A-Za-z0-9_$]+/.exec(src.slice(i));
          if (!m) throw new Error(`unparsable key at ${i}`);
          key = m[0];
          i += key.length;
        }
        ws();
        if (src[i] !== ':') throw new Error(`expected ':' at ${i}`);
        i++;
        obj[key] = value();
        ws();
        if (src[i] === ',') i++;
      }
    }
    const m = /^[^,\]}\s]+/.exec(src.slice(i));
    if (!m) throw new Error(`unparsable value at ${i}`);
    i += m[0].length;
    return m[0];
  };
  return value();
}

/**
 * Extract `{ level -> { taskId -> globs[] } }` from a wave workflow script, from an
 * `ownership`/`OWNS` object literal and from `// Owns <id>: <globs>` comments.
 */
export function parsePlan(source) {
  const levels = new Map();
  const add = (level, taskId, globs) => {
    if (!levels.has(level)) levels.set(level, new Map());
    const tasks = levels.get(level);
    const prev = tasks.get(taskId) ?? [];
    tasks.set(taskId, [...prev, ...globs]);
  };

  const decl = /(?:export\s+)?const\s+(?:ownership|OWNS)\s*=\s*/.exec(source);
  if (decl) {
    const literal = readLiteral(source, decl.index + decl[0].length);
    for (const [level, tasks] of Object.entries(literal)) {
      if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) continue;
      for (const [taskId, globs] of Object.entries(tasks)) {
        add(level, taskId, Array.isArray(globs) ? globs : [globs]);
      }
    }
  }

  let level = 'default';
  for (const line of source.split('\n')) {
    const ph = /\bphase\(\s*['"`]([^'"`]+)['"`]/.exec(line);
    if (ph) level = ph[1];
    const m = /^\s*\/\/\s*Owns\s*(?:\[([^\]]+)\])?\s*([^:]*?)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const id = TASK_ID.exec(m[2] ?? '')?.[1];
    if (!id) continue;
    // splitTopLevel, not split(','), so `// Owns X: apps/{web,runner}/**` stays one glob.
    const globs = splitTopLevel(m[3])
      .map((s) => s.trim())
      .filter(Boolean);
    if (globs.length) add(m[1]?.trim() || level, id, globs);
  }
  return levels;
}

// ── Modes ───────────────────────────────────────────────────────────────────────────────

function checkPlanFile(file, files) {
  const rel = (path.relative(REPO_ROOT, path.resolve(file)) || file).split(path.sep).join('/');
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`FAIL ${rel}: cannot read (${err.message})`);
    return 1;
  }
  const levels = parsePlan(source);
  if (levels.size === 0) {
    console.log(`warn ${rel}: no ownership declarations found — nothing to check.`);
    console.log(
      '     Declare `export const ownership = { <level>: { <task-id>: [<globs>] } }` or ' +
        '`// Owns <task-id>: <globs>` so §2.3 can be enforced.',
    );
    return 0;
  }

  let failures = 0;
  for (const [level, tasks] of levels) {
    const ids = [...tasks.keys()];
    console.log(`  level ${level}: ${ids.length} task(s) — ${ids.join(', ')}`);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (const ga of tasks.get(ids[i])) {
          for (const gb of tasks.get(ids[j])) {
            const r = globsIntersect(ga, gb, files);
            if (r.intersects) {
              failures++;
              console.error(
                `FAIL ${rel} [${level}]: ${ids[i]} "${ga}" intersects ${ids[j]} "${gb}" ` +
                  `(${r.reason}: ${r.evidence.join(', ')})`,
              );
            }
          }
        }
      }
    }
  }
  if (failures === 0) console.log(`ok   ${rel}: all parallel levels have disjoint ownership.`);
  return failures ? 1 : 0;
}

function planMode(args) {
  const files = trackedFiles();
  let targets = args.filter((a) => !a.startsWith('-'));
  if (targets.length === 0) {
    const dir = path.join(REPO_ROOT, '.claude', 'workflows');
    if (!existsSync(dir)) {
      console.log('No .claude/workflows/ directory yet — no wave scripts to check.');
      return 0;
    }
    targets = readdirSync(dir)
      .filter((f) => /\.(mjs|js)$/.test(f))
      .map((f) => path.join(dir, f));
    if (targets.length === 0) {
      console.log('.claude/workflows/ contains no wave scripts — nothing to check.');
      return 0;
    }
  }
  console.log(`Ownership plan check over ${targets.length} script(s):`);
  return targets.reduce((code, f) => Math.max(code, checkPlanFile(f, files)), 0);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

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
export function stripCodeBlocks(body) {
  const out = [];
  let fence = null; // the opening run of fence characters, e.g. '```'
  for (const line of String(body).replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      out.push('');
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    // A backtick fence's info string may not itself contain a backtick (CommonMark).
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1];
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
function ownsValue(match) {
  const open = match[1];
  const raw = match[2].trim();
  if (!open || !raw.startsWith(open)) return raw;
  const rest = raw.slice(open.length);
  if (rest.startsWith('/')) return raw;
  return rest.trim();
}

// ── "This declares the whole repository" — decided semantically, never by spelling ───────
//
// A blacklist of spellings is not a guard: `**`, `*`, `**/*` and `./**` are easy to list,
// but `**/**`, `**/?*`, `**/*.*` and every other synonym are not. So we do not ask what the
// glob LOOKS like. We ask matchGlob what it MATCHES, against a spread of paths that no honest
// task owns together — all but at most one area of the tree at once, sampled at each area's
// shallowest and deepest tracked path, plus every file sitting at the shared root.
//
// The probes are DERIVED from the tracked tree, never written down. They used to be a list of
// five directories, and the repository had six: `ui/` has been tracked since the initial
// commit and the plan names it as a first-class input (§1.2, and §9.1's spec-inventory gate
// asserts "screens = ui/*.html"). The guard's own definition of "every area" therefore left a
// whole tracked directory out, and the two reason strings built from that list told an author
// their globs covered "every area of the repository" while they matched nothing under ui/.
// Any list of "the directories that exist today" is wrong the day someone adds one, so there
// is no list: areasFromTree() reads `git ls-files`, and the reason strings below are built
// from the very same data, which is what keeps a directory added tomorrow from making them
// false again.
//
// Three ways to own everything, so three questions:
//   (a) the declaration reaches the shared root and every area of the tree bar at most one;
//   (b) the declaration swallows the shared repository root wholesale (this is what a bare
//       `*` does: it misses nothing at the root, which is where every shared config lives);
//   (c) the declaration takes every subdirectory — every tracked top-level directory AND a
//       top-level directory nobody has declared yet — and misses only the root. `*/**` and
//       `**/*/**` are exactly that shape: they answer (a) and (b) NO because no root probe
//       matches either of them, yet they own every file that is not at the top level.
//       UNCLAIMED_PROBE is what separates this from an honest task that happens to list
//       several directories: enumerating the tracked directories does not reach a directory
//       added tomorrow, and a set that does reach it is claiming the tree, not a part of it.
//
// WHY (a) COUNTS WHAT IS MISSED INSTEAD OF ASKING FOR "EVERY AREA". Deriving the list was
// necessary and not sufficient, and on its own it made this gate WEAKER than the five-name
// literal above. Question (a) read `NAMED_AREAS.every(...)`, and `every` is ANTI-MONOTONE in
// the size of the set it quantifies over: each area added to that set is one more place a
// declaration can fall short and be waved through, so a COMPLETE list refuses strictly less
// than an incomplete one. Completing the list weakened the guard by the same stroke that made
// it honest. Measured by running both versions side by side over `*.*` plus every tracked
// directory but one, for each of the six directories in turn: the literal refused the `ui`
// omission and accepted the other five — `ui` being the one name missing from it, so the one
// omission it happened to notice — and the derived set accepted all six. The literal was not
// strong, it was short; putting `ui` back would restore one of those six rows and no more.
// Neither list is the defect. The quantifier is: under `every`, an author who wants the gate
// gone need only leave the smallest tracked directory off the line, or add a one-file
// directory in an earlier PR and leave that off. So (a) counts what a declaration MISSES —
// one unreached area out of many is a rounding error, not a scope. The second clause, at
// least two areas reached, keeps the rule from degenerating where "all but one" would mean
// "one": a tree with a single top-level directory, which is what FALLBACK_TREE is.
//
// None of the three is "matches literally every path", and it would be wrong to say so:
//   (a) is answered yes by `**/*.*`, which still misses extensionless LICENSE;
//   (b) says nothing at all about what lies below the top level — a bare `*` matches only
//       root files — but the root is where every shared config lives;
//   (c) misses exactly the root by construction, so a `*/**` declaration would still fail a
//       diff that touches package.json, as the (c) reason string says.
// Each is refused all the same. A gate exists to tell a task's own diff from a wandering one,
// and a declaration of any of these three reaches so far past one task's files that it stops
// being able to.
//
// All three questions are asked of each glob on its own AND of the declared set as a whole,
// so the guard cannot be walked around by splitting one `**` across several innocent-looking
// globs. Probes are matched with `{ root: null }` so the answer never depends on what
// happens to exist on disk in the checkout.

/**
 * Split a list of tracked paths into areas: the repository root, and one area per tracked
 * top-level directory. Each directory area carries its shallowest and its deepest tracked
 * path, so `area.probes.some(hits)` asks "does this declaration reach into that directory at
 * all" rather than "does it reach one particular file someone once picked".
 * @param {string[]} files tracked paths, repo-relative, forward slashes
 * @returns {{root: string[], named: {dir: string, probes: string[]}[]}}
 */
export function areasFromTree(files) {
  const root = [];
  const dirs = new Map();
  for (const f of files) {
    const slash = f.indexOf('/');
    if (slash === -1) {
      root.push(f);
      continue;
    }
    const dir = f.slice(0, slash);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(f);
  }
  const shallowestFirst = (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1);
  const named = [...dirs.keys()].sort().map((dir) => {
    const paths = dirs.get(dir).sort(shallowestFirst);
    return { dir, probes: [...new Set([paths[0], paths[paths.length - 1]])] };
  });
  return { root: root.sort(), named };
}

/** A top-level directory nobody has declared. Question (c) is why this probe exists. */
const UNCLAIMED_PROBE = 'a-directory-no-task-declared/nested/file.ts';

/**
 * Used only when the tree cannot be read at all — no git on PATH, or an unpacked tarball
 * rather than a checkout. It yields two areas — the root, and `scripts` — and no count of the
 * real tree is written down here, because any such number is wrong the day someone adds a
 * top-level directory and is wrong on the branch above this one before that. With one named
 * area, question (a) cannot fire at all (it wants two areas reached), so under the fallback it
 * is (b) and (c) that carry the whole-repo refusals: the bare-star spellings all match every
 * tracked root path, so (b) refuses them, and the dotted one that misses extensionless
 * LICENSE — and so slips past (b) — is refused by (c), which it answers yes by reaching both
 * `scripts` and UNCLAIMED_PROBE. An empty tree would be worse than any of this: `[].every()`
 * is vacuously true, so question (b) would refuse every declaration in the repository.
 */
const FALLBACK_TREE = ['package.json', 'LICENSE', '.gitignore', 'scripts/check-file-ownership.mjs'];

/** The tracked tree, read once. `git ls-files` is a subprocess; nothing here needs it twice. */
let areasCache = null;
function areas() {
  if (!areasCache) {
    const files = trackedFiles();
    areasCache = areasFromTree(files.length ? files : FALLBACK_TREE);
  }
  return areasCache;
}

/** The tracked top-level directory names, in the order the reason strings list them. */
export function trackedAreaNames() {
  return areas().named.map((a) => a.dir);
}

/**
 * Does this set of globs amount to a claim on the whole repository? `globs` may be a single
 * declared glob (the usual call) or every glob on the Owns line (the anti-splitting call).
 * @returns {false | string} false, or the reason it is a whole-repo claim.
 */
export function ownsEverything(globs, opts = { root: null }) {
  const hits = (p) => globs.some((g) => matchGlob(g, p, opts));
  const { root, named } = areas();
  const dirs = named.map((a) => a.dir).join(', ');
  const missed = named.filter((a) => !a.probes.some(hits));
  const reached = named.length - missed.length;
  const everyDirectory = missed.length === 0;
  // Question (a): the root, and every area bar at most one. Counting the misses rather than
  // demanding every area is what keeps the answer from getting weaker each time the tree
  // grows a directory — see the note above. UNCLAIMED_PROBE is deliberately NOT part of this
  // one: a set that merely enumerates today's directories must still answer (a) yes.
  if (root.some(hits) && reached >= 2 && missed.length <= 1) {
    if (everyDirectory) return `it matches a file in every area of the repository (root, ${dirs})`;
    const reachedDirs = named.filter((a) => a !== missed[0]).map((a) => a.dir);
    return `it matches a file at the repository root and in every area of the tree except ${missed[0].dir} (root, ${reachedDirs.join(', ')}). Leaving one directory out of a claim on all ${reachedDirs.length} of the others is still a claim on the tree — and a directory added tomorrow would serve as the exception just as well`;
  }
  if (root.every(hits)) {
    return `it matches every one of the ${root.length} tracked files at the repository root (${root.join(', ')})`;
  }
  // Question (c): every area below the root, plus a directory that does not exist yet.
  if (everyDirectory && hits(UNCLAIMED_PROBE)) {
    return `it matches every file below the top level — every tracked top-level directory (${dirs}), and ${UNCLAIMED_PROBE.split('/')[0]}, which does not exist — and misses only the root, which is the whole repository bar a handful of shared configs`;
  }
  return false;
}

/**
 * The lines of the one `## Ownership` section, or the reason there is not exactly one.
 * @returns {{ok: true, lines: string[]} | {ok: false, reason: string}}
 */
function ownershipSection(body) {
  const lines = stripCodeBlocks(body).split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h) {
      current = /^ownership$/i.test(h[1].trim()) ? [] : null;
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
  return { ok: true, lines: sections[0] };
}

/**
 * Parse the `## Ownership` section of a PR body that follows the ownership template.
 * @returns {{ok: true, globs: string[]} | {ok: false, reason: string}}
 */
export function parseOwnership(body) {
  const found = ownershipSection(body);
  if (!found.ok) return found;
  const owns = found.lines.map((l) => OWNS_LINE.exec(l)).filter(Boolean);
  if (owns.length === 0) {
    return { ok: false, reason: 'the "## Ownership" section has no "Owns globs:" line.' };
  }
  if (owns.length > 1) {
    return {
      ok: false,
      reason: `the "## Ownership" section has ${owns.length} "Owns globs:" lines; exactly one is required.`,
    };
  }

  const raw = ownsValue(owns[0]);
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
export function parseIntegrationOwnership(body) {
  const own = parseOwnership(body);
  if (!own.ok) return own;
  const section = ownershipSection(body);
  if (!section.ok) return section;

  const merged = [];
  for (const line of section.lines) {
    const m = MERGED_LINE.exec(line);
    if (!m) continue;
    const ref = m[1].replace(/^`+|`+$/g, '');
    const raw = m[2].trim();
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

function gitDiffFiles(base, head) {
  const range = base && head ? `${base}...${head}` : base ? `${base}...HEAD` : 'HEAD~1...HEAD';
  return nulSeparatedPaths(
    execFileSync('git', ['diff', '--name-only', '-z', range], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }),
  );
}

/** `git`, with stderr surfaced in the thrown message rather than swallowed. */
function git(...argv) {
  return execFileSync('git', argv, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function gitLines(...argv) {
  return git(...argv)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Every merge on this branch's first-parent path, with the commits it merged in.
 *
 * `--first-parent` on purpose: those are the merges this branch performed. A merge that arrived
 * *inside* one of the merged branches is that branch's own history, and its files are already
 * attributed to it by the diff below — counting it here as well would let an integration branch
 * inherit a declaration nobody wrote on this PR.
 *
 * @returns {{merge: string, parents: string[]}[]}
 */
function mergeParents(base, head) {
  const merges = gitLines('rev-list', '--merges', '--first-parent', `${base}..${head}`);
  return merges.map((merge) => {
    const line = git('rev-list', '--parents', '-n', '1', merge).trim().split(/\s+/);
    return { merge, parents: line.slice(1) };
  });
}

function integrationMode(args, body, base, head) {
  const parsed = parseIntegrationOwnership(body);
  if (!parsed.ok) {
    console.error(`FAIL: ${parsed.reason}`);
    console.error(
      '\n      An integration PR declares its own globs on the "Owns globs:" line and one',
    );
    console.error(
      '      "Merged <ref>: <globs>" line per branch it merged, repeating the globs that',
    );
    console.error(
      '      branch declared on its own PR. See docs/adr/W1-INT-02-the-ownership-gate-learns-',
    );
    console.error('      about-merges.md.');
    return 1;
  }

  let graph;
  let changed;
  try {
    graph = mergeParents(base ?? 'HEAD~1', head ?? 'HEAD');
    changed = gitDiffFiles(base, head);
  } catch (err) {
    console.error(`FAIL: could not read the commit graph (${err.message}).`);
    console.error('      Check out with fetch-depth: 0 so the merge base and every parent exist.');
    return 1;
  }

  if (graph.length === 0) {
    console.error(
      `FAIL: no merge commit on the first-parent path of ${base ?? 'HEAD~1'}..${head ?? 'HEAD'}.`,
    );
    console.error('      --integration attributes files to the parent a merge introduced them');
    console.error('      from; with no merge there is nothing to attribute, and this branch');
    console.error('      should be checked with --pr instead.');
    return 1;
  }

  // Resolve every declared ref once, so a body naming a branch that was never merged is an
  // error rather than a declaration that quietly covers nothing.
  const declaredBySha = new Map();
  for (const entry of parsed.merged) {
    let sha;
    try {
      sha = git('rev-parse', `${entry.ref}^{commit}`).trim();
    } catch {
      console.error(`FAIL: "Merged ${entry.ref}:" names a ref this repository cannot resolve.`);
      return 1;
    }
    declaredBySha.set(sha, entry);
  }

  const parents = [];
  const undeclared = [];
  for (const { merge, parents: shas } of graph) {
    const first = shas[0];
    for (const sha of shas.slice(1)) {
      const entry = declaredBySha.get(sha);
      if (!entry) {
        undeclared.push(`${sha} (merged by ${merge.slice(0, 7)})`);
        continue;
      }
      const mergeBase = git('merge-base', first, sha).trim();
      parents.push({
        ref: entry.ref,
        sha,
        globs: entry.globs,
        files: gitDiffFiles(mergeBase, sha),
      });
    }
  }

  if (undeclared.length > 0) {
    console.error(`FAIL: ${undeclared.length} merged parent(s) that the PR body does not declare:`);
    for (const p of undeclared) console.error(`  ${p}`);
    console.error(
      '\n      Every branch this PR merged needs a "Merged <ref>: <globs>" line. A merge whose',
    );
    console.error(
      '      declaration is missing would otherwise carry its files in unattributed, which is',
    );
    console.error('      precisely the hole this mode exists to close.');
    return 1;
  }

  const declaredShas = new Set(parents.map((p) => p.sha));
  const unmerged = [...declaredBySha.entries()].filter(([sha]) => !declaredShas.has(sha));
  if (unmerged.length > 0) {
    console.error(`FAIL: ${unmerged.length} declared branch(es) that this PR did not merge:`);
    for (const [sha, entry] of unmerged) console.error(`  ${entry.ref} (${sha.slice(0, 7)})`);
    console.error('\n      The body and the commit graph disagree about what was merged.');
    return 1;
  }

  console.log(`Declared Owns globs: ${parsed.globs.length ? parsed.globs.join(', ') : '(none)'}`);
  console.log(`Merged branches (${parents.length}), with the files each introduced:`);
  for (const p of parents) {
    console.log(`  ${p.ref} @ ${p.sha.slice(0, 7)} — ${p.files.length} file(s)`);
    console.log(`    owns: ${p.globs.length ? p.globs.join(', ') : '(none)'}`);
  }
  console.log(`Changed files (${changed.length}):`);
  for (const f of changed) console.log(`  ${f}`);

  const violations = findIntegrationViolations(parsed.globs, parents, changed);
  if (violations.length) {
    console.error(`\nFAIL: ${violations.length} file(s) this merge cannot account for:`);
    for (const v of violations) console.error(`  ${v.file} — ${v.why}`);
    return 1;
  }
  const attributed = changed.filter((f) => !matchAny(parsed.globs, f)).length;
  console.log(
    `\nok: every changed file is accounted for — ${changed.length - attributed} inside the integrator's own globs, ${attributed} attributed to the merged branch that introduced them.`,
  );
  return 0;
}

function prMode(args) {
  const arg = (name) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };

  let body = null;
  let base = arg('--base');
  let head = arg('--head');
  let sawPullRequestEvent = false;

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const event = JSON.parse(readFileSync(eventPath, 'utf8'));
      const pr = event.pull_request;
      if (pr) {
        sawPullRequestEvent = true;
        body = pr.body ?? '';
        base ??= pr.base?.sha;
        head ??= pr.head?.sha;
      }
    } catch (err) {
      console.error(`Could not read GITHUB_EVENT_PATH: ${err.message}`);
      return 1;
    }
  }
  if (body === null && !process.stdin.isTTY) {
    const stdin = readStdin().trim();
    if (stdin) body = stdin;
  }

  if (body === null || body.trim() === '') {
    // A pull_request event with an empty body is a PR that skipped the mandatory template.
    // That is a failure, not a reason to wave the diff through.
    if (sawPullRequestEvent) {
      console.error('FAIL: the pull request body is empty.');
      console.error(
        '      The Ownership section in CONTRIBUTING.md makes the template — including the',
      );
      console.error('      "## Ownership" section — mandatory; §2.3 cannot be checked without it.');
      return 1;
    }
    // No PR at all (a push build, or a local run). This is a diff gate over a PR body, so
    // there is nothing to check — announced rather than passed silently (§9.3 gate 5).
    console.log(
      'NOTICE: no pull-request body available (this is not a pull_request event and stdin was empty).',
    );
    console.log(
      '        The ownership gate has nothing to check here and did NOT run. In CI it is',
    );
    console.log(
      "        guarded by `if: github.event_name == 'pull_request'` so this path is not a",
    );
    console.log('        silent pass on a real PR.');
    return 0;
  }

  // Both modes read the PR body and the diff range the same way; only the rule differs. The
  // choice is made by an explicit flag and never by inspecting the head commit: "does this
  // commit have two parents?" as the gate's own off switch is the alternative W0-INT-01
  // rejected, and a merge commit is trivial to manufacture.
  if (args.includes('--integration')) return integrationMode(args, body, base, head);

  const parsed = parseOwnership(body);
  if (!parsed.ok) {
    console.error(`FAIL: ${parsed.reason}`);
    console.error(
      '\n      The Ownership section is parsed with CRLF normalised and fenced and indented code',
    );
    console.error(
      '      blocks removed; exactly one section and exactly one "Owns globs:" line are required,',
    );
    console.error(
      '      and any declaration that reaches across the whole repository is refused however it is spelt.',
    );
    console.error('      See the Ownership section in CONTRIBUTING.md for the template.');
    return 1;
  }
  const globs = parsed.globs;

  let changed;
  try {
    changed = gitDiffFiles(base, head);
  } catch (err) {
    console.error(`FAIL: could not compute the diff (${err.message}).`);
    console.error('      Check out with fetch-depth: 0 so the merge base is present.');
    return 1;
  }

  console.log(`Declared Owns globs: ${globs.length ? globs.join(', ') : '(none)'}`);
  console.log(`Changed files (${changed.length}):`);
  for (const f of changed) console.log(`  ${f}`);

  const violations = findViolations(globs, changed);
  if (violations.length) {
    console.error(`\nFAIL: ${violations.length} file(s) changed outside the declared Owns globs:`);
    for (const f of violations) console.error(`  ${f}`);
    console.error(
      "\nEither the PR is editing another task's files, or its Ownership section is wrong.",
    );
    return 1;
  }
  console.log('\nok: every changed file is inside the declared Owns globs.');
  return 0;
}

// ── Self-test ───────────────────────────────────────────────────────────────────────────

function selfTest() {
  let failed = 0;
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok)
      console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const noRoot = { root: null };
  const m = (g, f) => matchGlob(g, f, noRoot);
  const x = (a, b, files = []) => globsIntersect(a, b, files, noRoot).intersects;

  console.log('glob matcher');
  check('** matches a nested file', m('.github/**', '.github/workflows/ci.yml'), true);
  check('** matches a direct child', m('.github/**', '.github/x.md'), true);
  check('** does not escape its prefix', m('.github/**', 'scripts/x.mjs'), false);
  check(
    'exact path matches itself',
    m('scripts/check-file-ownership.mjs', 'scripts/check-file-ownership.mjs'),
    true,
  );
  check(
    'exact path matches nothing else',
    m('scripts/check-file-ownership.mjs', 'scripts/check-licenses.mjs'),
    false,
  );
  check(
    '* stays inside one segment',
    m('packages/*/package.json', 'packages/core/package.json'),
    true,
  );
  check(
    '* does not cross a slash',
    m('packages/*/package.json', 'packages/core/src/package.json'),
    false,
  );
  check(
    '? matches exactly one character',
    m('apps/we?/next.config.ts', 'apps/web/next.config.ts'),
    true,
  );
  check(
    '? does not match two characters',
    m('apps/we?/next.config.ts', 'apps/webx/next.config.ts'),
    false,
  );
  check(
    '? does not match zero characters',
    m('apps/we?/next.config.ts', 'apps/we/next.config.ts'),
    false,
  );
  check('brace list, first branch', m('*.{json,mjs}', 'package.json'), true);
  check('brace list, second branch', m('*.{json,mjs}', 'eslint.config.mjs'), true);
  check('brace list rejects others', m('*.{json,mjs}', 'index.ts'), false);
  check('mid-path ** spans segments', m('apps/**/index.ts', 'apps/web/server/index.ts'), true);
  check('mid-path ** spans zero segments', m('apps/**/index.ts', 'apps/index.ts'), true);
  check('leading dot is literal', m('a.b/**', 'axb/c'), false);
  check(
    'matchAny over a glob list',
    matchAny(['.github/**', 'scripts/a.mjs'], 'scripts/a.mjs', noRoot),
    true,
  );

  console.log('\nliteral prefix');
  check('prefix of a ** glob', literalPrefix('packages/core/**'), 'packages/core');
  check('prefix stops at the first wildcard', literalPrefix('packages/*/src/**'), 'packages');
  check('prefix of an exact path', literalPrefix('scripts/a.mjs'), 'scripts/a.mjs');
  check(
    'disjoint roots do not overlap',
    literalPrefixOverlap('apps/web/**', 'apps/runner/**'),
    false,
  );
  check(
    'nested prefixes overlap',
    literalPrefixOverlap('packages/core/**', 'packages/core/src/db/**'),
    true,
  );

  console.log('\nintersection detector');
  check('identical globs intersect', x('.github/**', '.github/**'), true);
  check(
    'nested globs intersect with no files on disk',
    x('packages/core/**', 'packages/core/src/db/**'),
    true,
  );
  check('sibling directories are disjoint', x('apps/web/**', 'apps/runner/**'), false);
  check(
    'the two globs of this task are disjoint',
    x('.github/**', 'scripts/check-file-ownership.mjs'),
    false,
  );
  check(
    'sibling scripts are disjoint',
    x('scripts/check-file-ownership.mjs', 'scripts/check-licenses.mjs'),
    false,
  );
  check(
    'a * glob and a deeper ** glob are disjoint',
    x('packages/core/*.json', 'packages/core/src/**'),
    false,
  );
  check(
    'a * glob and a same-depth ** glob intersect',
    x('packages/core/*.json', 'packages/core/**'),
    true,
  );
  check('wildcard package globs intersect', x('packages/*/src/**', 'packages/gateway/**'), true);
  check(
    'brace lists intersect on one branch',
    x('apps/{web,runner}/**', 'apps/runner/src/**'),
    true,
  );
  check(
    'brace lists disjoint on every branch',
    x('apps/{web,runner}/**', 'packages/cli/**'),
    false,
  );
  check(
    'overlap found only via the repo tree',
    x('**/*.ts', 'apps/runner/src/index.ts', ['apps/runner/src/index.ts']),
    true,
  );
  check(
    'no overlap when the tree is empty and prefixes differ',
    x('apps/**/*.ts', 'packages/**/*.ts', []),
    false,
  );
  check('root ** owns everything', x('**', 'apps/web/**'), true);

  console.log('\nPR-body extraction');
  // `parses` collapses a result to the globs, or to the string 'REJECTED' — the reason text
  // is prose and asserting on it would make these fixtures brittle.
  const parses = (b) => {
    const r = parseOwnership(b);
    return r.ok ? r.globs : 'REJECTED';
  };
  const body = [
    '## Ownership',
    'Owns globs: `.github/**`, `scripts/check-file-ownership.mjs`',
    'Files touched outside Owns: none',
    '',
    '## Declared gaps',
    'None.',
  ].join('\n');
  check('globs read from the Ownership section', parses(body), [
    '.github/**',
    'scripts/check-file-ownership.mjs',
  ]);
  check('a body without the section is rejected', parses('## Task\nW0-INF-02'), 'REJECTED');
  check(
    'an Owns line in another section is ignored',
    parses('## Task\nOwns globs: `**`'),
    'REJECTED',
  );
  check(
    '"none" is an empty declaration, not a missing one',
    parses('## Ownership\nOwns globs: none'),
    [],
  );
  check(
    'the section ends at the next heading',
    parses('## Ownership\nOwns globs: `docs/**`\n\n## Declared gaps\nOwns globs: `**`'),
    ['docs/**'],
  );

  // THE BYPASS FIXTURE. Verified against a real GITHUB_EVENT_PATH payload before this
  // guard existed: the gate read the QUOTED `**` and passed every changed file. The plan
  // documents quote the ownership template in exactly this shape, so any author who
  // copies it into their PR body reproduces it. This must never regress.
  const quotedTemplate = [
    'The Ownership section of CONTRIBUTING.md says a PR body must look like this:',
    '',
    '```markdown',
    '## Ownership',
    'Owns globs: `**`',
    'Files touched outside Owns: none',
    '```',
    '',
    '## Ownership',
    'Owns globs: `.github/**`',
    'Files touched outside Owns: none',
    '',
    '## Declared gaps',
    'None.',
  ].join('\n');
  check('a fenced quote of the template cannot supply the globs', parses(quotedTemplate), [
    '.github/**',
  ]);
  check('a tilde-fenced quote is stripped too', parses(quotedTemplate.replace(/```/g, '~~~~')), [
    '.github/**',
  ]);
  check(
    'an indented quote is stripped too',
    parses(
      [
        '    ## Ownership',
        '    Owns globs: `**`',
        '',
        '## Ownership',
        'Owns globs: `apps/web/**`',
      ].join('\n'),
    ),
    ['apps/web/**'],
  );
  check(
    'a body whose ONLY Ownership section is fenced is rejected',
    parses(['```markdown', '## Ownership', 'Owns globs: `**`', '```'].join('\n')),
    'REJECTED',
  );
  check(
    'an unterminated fence fails closed',
    parses(['```markdown', '## Ownership', 'Owns globs: `**`'].join('\n')),
    'REJECTED',
  );
  check(
    'two real Ownership sections are ambiguous, not first-wins',
    parses('## Ownership\nOwns globs: `**`\n\n## Ownership\nOwns globs: `.github/**`'),
    'REJECTED',
  );
  check(
    'two Owns lines in one section are ambiguous',
    parses('## Ownership\nOwns globs: `**`\nOwns globs: `.github/**`'),
    'REJECTED',
  );
  check(
    'a section with no Owns line is rejected',
    parses('## Ownership\nFiles touched outside Owns: none'),
    'REJECTED',
  );
  check('a bare ** declaration is refused', parses('## Ownership\nOwns globs: `**`'), 'REJECTED');
  check(
    'an unquoted ** declaration is refused',
    parses('## Ownership\nOwns globs: **'),
    'REJECTED',
  );
  check(
    'a ** hidden among real globs is refused',
    parses('## Ownership\nOwns globs: `.github/**`, `**`'),
    'REJECTED',
  );
  check(
    'the ./** and **/* spellings are refused too',
    parses('## Ownership\nOwns globs: `./**`, `**/*`'),
    'REJECTED',
  );
  check('a single * is refused', parses('## Ownership\nOwns globs: `*`'), 'REJECTED');
  check(
    'a legitimate ** suffix is still allowed',
    parses('## Ownership\nOwns globs: `.github/**`'),
    ['.github/**'],
  );

  // ROUND-2 FIXTURES — the whole-repo guard used to be a blacklist of spellings, so these two
  // synonyms walked straight through it while matchGlob resolved them as whole-repo claims.
  // `**/**` matches every path; `**/*.*` matches every path whose last segment contains a dot,
  // which is every tracked path here bar extensionless LICENSE — not literally every path, but
  // a file in every area of the tree, which is question (a) answered yes. The guard is now
  // semantic (ownsEverything), and these pin that it stays semantic.
  check('the **/** spelling is refused', parses('## Ownership\nOwns globs: `**/**`'), 'REJECTED');
  check('the **/*.* spelling is refused', parses('## Ownership\nOwns globs: `**/*.*`'), 'REJECTED');
  check(
    'the **/**/** spelling is refused',
    parses('## Ownership\nOwns globs: `**/**/**`'),
    'REJECTED',
  );
  check(
    'a **/** hidden among real globs is refused',
    parses('## Ownership\nOwns globs: `docs/**`, `**/**`'),
    'REJECTED',
  );
  // A brace list is one glob, so `**` can be hidden inside one. Splitting the line correctly
  // (splitTopLevel) is what lets ownsEverything see the `**` branch at all.
  // ROUND-3 FIXTURES — these two answer questions (a) and (b) NO, because no root probe
  // matches them, yet each owns every file in every subdirectory at any depth. The guard let
  // them through until question (c) was added. Question (c) is the narrow one: a `*/**`
  // declaration would still fail a diff that touches package.json, so it is not "no gate at
  // all" the way `**` is — it is an author owning everything but the root.
  check('the */** spelling is refused', parses('## Ownership\nOwns globs: `*/**`'), 'REJECTED');
  check(
    'the **/*/** spelling is refused',
    parses('## Ownership\nOwns globs: `**/*/**`'),
    'REJECTED',
  );
  check(
    'a ** hidden inside a brace list is refused',
    parses('## Ownership\nOwns globs: `{**,docs}`'),
    'REJECTED',
  );
  check(
    'a ** branch beside a real one is refused',
    parses('## Ownership\nOwns globs: `{docs,**}/**`'),
    'REJECTED',
  );
  // ...and it cannot be walked around by splitting one `**` into innocent-looking pieces.
  // Built from the tracked tree, not typed out: a hand-written list of directories here would
  // start passing — silently, as a fixture that no longer covers the repo — the day someone
  // adds a top-level directory. `areaGlobs` is one `<dir>/**` per tracked top-level directory.
  const areaGlobs = trackedAreaNames().map((d) => `${d}/**`);
  const ownsLine = (gs) => `## Ownership\nOwns globs: ${gs.map((g) => `\`${g}\``).join(', ')}`;
  check(
    'globs that only together cover the repo are refused',
    // Not one of these is a whole-repo claim on its own — `*.*` misses LICENSE, and each
    // directory glob misses every other directory. Together they leave nothing out.
    parses(ownsLine(['*.*', ...areaGlobs])),
    'REJECTED',
  );
  // THE ONE-DIRECTORY ESCAPE HATCH. This slot used to hold a single fixture asserting that
  // `*.*` plus every directory but the FIRST was accepted — it pinned the hole rather than
  // the guard, and it only ever exercised one directory. The shape is written out for every
  // tracked directory in turn instead, and derived, so a directory added tomorrow arrives
  // with its own case and nobody has to remember to add one. Gated at three directories
  // because below that "all but one" and "one" are the same claim, which is exactly why
  // question (a) also wants two areas reached.
  const areaNames = trackedAreaNames();
  const without = (...omit) => ['*.*', ...areaGlobs.filter((g) => !omit.includes(g.slice(0, -3)))];
  if (areaNames.length >= 3) {
    for (const dir of areaNames) {
      check(`every area except ${dir} is refused too`, parses(ownsLine(without(dir))), 'REJECTED');
    }
  }
  // The other side of the same line, so the spread cannot silently widen from "all but one"
  // to "all but two": leaving two directories out is a scoped declaration and must parse.
  // Each directory appears in an omitted pair with its neighbour, so a widening fails here
  // for every directory rather than for whichever one someone happened to write down.
  for (let i = 0; i < areaNames.length; i++) {
    const pair = [areaNames[i], areaNames[(i + 1) % areaNames.length]];
    const gs = without(...pair);
    check(
      `every area except ${[...new Set(pair)].join(' and ')} still parses`,
      parses(ownsLine(gs)),
      gs,
    );
  }
  // ...and the ordinary declaration — one area, with and without the shared root — must parse
  // for every directory, not just for the two that happen to be spelt out further down.
  for (const dir of areaNames) {
    check(`${dir}/** alone still parses`, parses(ownsLine([`${dir}/**`])), [`${dir}/**`]);
    check(`${dir}/** with the root files still parses`, parses(ownsLine(['*.*', `${dir}/**`])), [
      '*.*',
      `${dir}/**`,
    ]);
  }
  // The other half of the bargain: real, scoped declarations must still pass. If one of
  // these ever starts failing, the probe spread has been drawn too wide, not too narrow.
  check(
    'a whole top-level app is still allowed',
    parses('## Ownership\nOwns globs: `apps/web/**`'),
    ['apps/web/**'],
  );
  check(
    'a wildcard package glob is still allowed',
    parses('## Ownership\nOwns globs: `packages/*/src/**`'),
    ['packages/*/src/**'],
  );
  // A brace list contains a comma, so the Owns line must be split at brace depth 0 only.
  // `.split(',')` produced `*.{json` and `mjs}`, two globs that match nothing at all.
  check(
    'a scoped root brace list is still allowed',
    parses('## Ownership\nOwns globs: `*.{json,mjs}`'),
    ['*.{json,mjs}'],
  );
  check(
    'a brace list is one glob, not two',
    parses('## Ownership\nOwns globs: `apps/{web,runner}/**`, `docs/**`'),
    ['apps/{web,runner}/**', 'docs/**'],
  );
  check(
    'a brace list still matches both branches',
    matchAny(
      parseOwnership('## Ownership\nOwns globs: `apps/{web,runner}/**`').globs,
      'apps/runner/src/index.ts',
      noRoot,
    ),
    true,
  );
  check("this task's own two globs are still allowed", parses(body), [
    '.github/**',
    'scripts/check-file-ownership.mjs',
  ]);

  // ROUND-4 FIXTURES — the guard used to run on the RAW spelling while enforcement ran on the
  // normalised one, so a bare directory name (which normalizeGlob expands to `dir/**` against
  // the real tree) was invisible to the guard. The first fixture is the bypass that found it:
  // it is the `**`-spelt set two lines below, which the guard has always refused. Both sets
  // are derived from the tracked tree for the reason the probes are: typed out, they named the
  // six directories of this branch and silently stopped covering the repository one commit
  // later, when W0-DOC-01's `.claude/workflows/` made a seventh — at which point the "bypass"
  // fixture asserted nothing and passed by not being a whole-repo claim at all.
  check(
    'bare directory names cannot walk around the whole-repo guard',
    parses(ownsLine([...trackedAreaNames(), '*.*'])),
    'REJECTED',
  );
  check(
    'the same claim spelt with /** is refused as before',
    parses(ownsLine([...areaGlobs, '*.*'])),
    'REJECTED',
  );
  check(
    'a bare `.` is a whole-repo claim once normalised',
    parses('## Ownership\nOwns globs: `.`'),
    'REJECTED',
  );
  // A bare directory is still a legitimate way to write a scoped claim; it comes back in the
  // form enforcement will actually match, so what is printed is what is checked.
  check(
    'a single bare directory is normalised, not refused',
    parses('## Ownership\nOwns globs: `docs`'),
    ['docs/**'],
  );

  // Markdown emphasis around the label. `**Owns globs**:` always worked; `**Owns globs:**` did
  // not — the closing run was captured as part of the first glob, producing a glob that matched
  // nothing and a failure that blamed the author's files.
  check(
    'a bold label with the colon inside is parsed',
    parses('## Ownership\n**Owns globs:** `docs/**`'),
    ['docs/**'],
  );
  check(
    'a bold label with the colon outside is parsed',
    parses('## Ownership\n**Owns globs**: `docs/**`'),
    ['docs/**'],
  );
  check('a bulleted bold label is parsed', parses('## Ownership\n- **Owns globs:** `docs/**`'), [
    'docs/**',
  ]);
  // ...and stripping it must never eat a leading `**` that is part of the glob.
  check(
    'a bold label does not swallow a leading ** glob',
    parses('## Ownership\n**Owns globs:** `apps/**`, `docs/**`'),
    ['apps/**', 'docs/**'],
  );
  check(
    'an unemphasised leading ** glob is untouched',
    parses('## Ownership\nOwns globs: `**/*.ts`'),
    ['**/*.ts'],
  );

  // The shipped template ships with a placeholder. Leaving it in is a fail either way, but it
  // must be reported as "you did not fill the template in", not as "your files are stolen".
  check(
    'an unfilled template placeholder is named as such',
    parses('## Ownership\nOwns globs: <globs from the task card>'),
    'REJECTED',
  );

  console.log('\nwhole-repo detection (semantic, not by spelling)');
  const owns_all = (...gs) => Boolean(ownsEverything(gs));
  check('** owns everything', owns_all('**'), true);
  check('* owns everything (it misses nothing at the root)', owns_all('*'), true);
  check('**/* owns everything', owns_all('**/*'), true);
  check('./** owns everything', owns_all('./**'), true);
  check('**/** owns everything', owns_all('**/**'), true);
  check('**/*.* owns everything', owns_all('**/*.*'), true);
  check('**/?* owns everything', owns_all('**/?*'), true);
  check('a dotfile alone is not enough to be caught', owns_all('.gitignore'), false);
  check('.github/** does not own everything', owns_all('.github/**'), false);
  check('a deep glob does not own everything', owns_all('packages/core/src/db/**'), false);
  check('*/** owns everything below the root', owns_all('*/**'), true);
  check('**/*/** owns everything below the root', owns_all('**/*/**'), true);
  // The pair that keeps question (c) from swallowing honest declarations: enumerating the
  // directories that exist today does not reach one added tomorrow, so it is a scoped claim;
  // `*/**` does reach it, so it is not. Both sides are derived from the tree for the same
  // reason the probes are — a typed-out list here would stop describing the repository the
  // first time one of these tasks adds a top-level directory.
  check(
    'every tracked top-level dir, minus the root, is not everything',
    owns_all(...areaGlobs),
    false,
  );
  check(
    'all but one of those directories, still without the root, is not everything either',
    owns_all(...areaGlobs.slice(1)),
    false,
  );
  check('a lone *.* is not everything either', owns_all('*.*'), false);
  check('but the directories and the root together are', owns_all(...areaGlobs, '*.*'), true);
  // ...and so is the root plus all of them but one — question (a) counts the misses, so the
  // last directory on the line is not a way out of it. Derived, and asserted for each
  // directory in turn under "the one-directory escape hatch" above; this is the unit-level
  // spelling of the same property.
  if (areaGlobs.length >= 3) {
    check(
      'the root plus all but one of them is everything too',
      owns_all(...areaGlobs.slice(1), '*.*'),
      true,
    );
  }
  check(
    'the probe areas are the tracked top-level directories',
    trackedAreaNames(),
    [
      ...new Set(
        trackedFiles()
          .filter((f) => f.includes('/'))
          .map((f) => f.slice(0, f.indexOf('/'))),
      ),
    ].sort(),
  );
  check(
    'tracked UTF-8 paths are read verbatim instead of as Git-quoted byte escapes',
    trackedFiles().includes('tests/e2e/fixtures/日本語ファイル.txt'),
    true,
  );
  check(
    'machine-readable Git path lists preserve UTF-8 and embedded newlines',
    nulSeparatedPaths('日本語ファイル.txt\0directory/line\nbreak.txt\0'),
    ['日本語ファイル.txt', 'directory/line\nbreak.txt'],
  );

  console.log('\nCRLF PR bodies');
  // GitHub stores the body exactly as the author's client sent it, so a PR opened from a
  // Windows editor arrives CRLF. Before normalisation OWNS_LINE's `(.*)$` could not span the
  // trailing \r and this parsed as "the section has no Owns globs: line" — fail-closed, but
  // with a reason that blamed the author for a line they had written correctly.
  const crlf = (b) => b.replace(/\n/g, '\r\n');
  check('a CRLF body parses like an LF one', parses(crlf(body)), [
    '.github/**',
    'scripts/check-file-ownership.mjs',
  ]);
  check('a CRLF fenced quote is still stripped', parses(crlf(quotedTemplate)), ['.github/**']);
  check(
    'a CRLF whole-repo declaration is still refused',
    parses(crlf('## Ownership\nOwns globs: `**`')),
    'REJECTED',
  );
  check('a lone-CR body parses too', parses(body.replace(/\n/g, '\r')), [
    '.github/**',
    'scripts/check-file-ownership.mjs',
  ]);
  check(
    'a CRLF "none" is an empty declaration',
    parses(crlf('## Ownership\nOwns globs: none')),
    [],
  );

  console.log('\nownership enforcement');
  const owns = ['.github/**', 'scripts/check-file-ownership.mjs'];
  const v = (files) => findViolations(owns, files, noRoot);
  check(
    'an in-bounds diff has no violations',
    v([
      '.github/workflows/ci.yml',
      '.github/pull_request_template.md',
      'scripts/check-file-ownership.mjs',
    ]),
    [],
  );
  check(
    'an out-of-bounds file is caught',
    v(['.github/workflows/ci.yml', 'packages/core/src/index.ts']),
    ['packages/core/src/index.ts'],
  );
  check('a sibling script is caught', v(['scripts/check-licenses.mjs']), [
    'scripts/check-licenses.mjs',
  ]);
  check('a root manifest edit is caught', v(['package.json', 'pnpm-lock.yaml']), [
    'package.json',
    'pnpm-lock.yaml',
  ]);
  check('a near-miss path is caught', v(['github/workflows/ci.yml']), ['github/workflows/ci.yml']);

  console.log('\nintegration mode — parsing an integration PR body');
  const integrationBody = [
    '## Ownership',
    'Owns globs: `docs/integration/W1a-manifest.md`, `docs/adr/W1a-INT-*.md`',
    '- Merged `aw/w1-05-run-api`: `apps/web/app/api/runs/**`, `apps/web/server/runs/**`',
    '- **Merged aw/w1-06-agent-crud**: apps/web/app/api/agents/**, apps/web/server/agents/**',
    '',
    '## Declared gaps',
    'Owns globs: this line is in another section and must not be read',
  ].join('\n');
  const integ = parseIntegrationOwnership(integrationBody);
  check('the integrator’s own globs are read', integ.ok && integ.globs, [
    'docs/integration/W1a-manifest.md',
    'docs/adr/W1a-INT-*.md',
  ]);
  check(
    'one entry per merged branch, refs unquoted and emphasis stripped',
    integ.ok && integ.merged.map((m) => m.ref),
    ['aw/w1-05-run-api', 'aw/w1-06-agent-crud'],
  );
  check('a merged branch’s globs are read', integ.ok && integ.merged[1].globs, [
    'apps/web/app/api/agents/**',
    'apps/web/server/agents/**',
  ]);
  check(
    'an integration body with no Merged line is refused',
    parseIntegrationOwnership('## Ownership\nOwns globs: `docs/**`\n').ok,
    false,
  );
  check(
    'a Merged line that claims the repository is refused, like any other declaration',
    parseIntegrationOwnership('## Ownership\nOwns globs: `docs/adr/**`\nMerged aw/x: `**`\n').ok,
    false,
  );

  console.log('\nintegration mode — attributing files to the parent that introduced them');
  // The shape of Wave 1a's own integration branch: the integrator wrote three files, and five
  // branches brought in eighty. `parents` is what the commit graph yields; the rule under test is
  // what is done with it.
  const parentsFixture = [
    {
      ref: 'aw/w1-05-run-api',
      globs: ['apps/web/app/api/runs/**', 'docs/adr/README.md'],
      files: ['apps/web/app/api/runs/[id]/route.ts', 'docs/adr/README.md'],
    },
    {
      ref: 'aw/w1-06-agent-crud',
      globs: ['apps/web/app/api/agents/**', 'docs/adr/README.md'],
      files: ['apps/web/app/api/agents/route.ts', 'docs/adr/README.md'],
    },
  ];
  const iv = (files) =>
    findIntegrationViolations(
      ['docs/integration/W1a-manifest.md'],
      parentsFixture,
      files,
      noRoot,
    ).map((x) => x.file);
  check(
    'a file the integrator wrote is accounted for by its own globs',
    iv(['docs/integration/W1a-manifest.md']),
    [],
  );
  check(
    'a merged branch’s file is accounted for by that branch’s globs',
    iv(['apps/web/app/api/runs/[id]/route.ts', 'apps/web/app/api/agents/route.ts']),
    [],
  );
  check(
    'a generated file introduced by two parents needs only one of them to vouch',
    iv(['docs/adr/README.md']),
    [],
  );
  check(
    'a file no parent introduced and the integrator did not declare FAILS',
    iv(['apps/web/instrumentation.ts']),
    ['apps/web/instrumentation.ts'],
  );
  check(
    'a file its own parent did not declare FAILS, even though the merge carried it',
    findIntegrationViolations(
      ['docs/integration/W1a-manifest.md'],
      [{ ref: 'aw/x', globs: ['apps/web/app/api/runs/**'], files: ['packages/core/src/db.ts'] }],
      ['packages/core/src/db.ts'],
      noRoot,
    ).map((x) => x.file),
    ['packages/core/src/db.ts'],
  );
  check(
    'the two failures are told apart, because they call for different repairs',
    findIntegrationViolations(
      ['docs/integration/W1a-manifest.md'],
      parentsFixture,
      ['apps/web/instrumentation.ts'],
      noRoot,
    )[0].why.includes('no merged parent introduced it'),
    true,
  );
  check(
    'an empty declaration vouches for nothing — the reach guard is not the only guard',
    findIntegrationViolations(
      [],
      [{ ref: 'aw/x', globs: [], files: ['apps/web/app/api/runs/[id]/route.ts'] }],
      ['apps/web/app/api/runs/[id]/route.ts'],
      noRoot,
    ).map((x) => x.file),
    ['apps/web/app/api/runs/[id]/route.ts'],
  );

  console.log('\nwave-script parsing');
  const script = [
    'export const ownership = {',
    "  Foundation: { 'W1-DB-01': ['migrations/**'] },",
    '  Implement: {',
    "    'W1-RN-01': ['apps/runner/**'],",
    "    'W1-UI-01': ['apps/web/app/**'], // trailing comma and comment tolerated",
    '  },',
    '}',
    "phase('Verify')",
    '// Owns W1-QA-01: packages/core/src/**',
    '// Owns W1-QA-02: packages/gateway/src/**, apps/{web,runner}/e2e/**',
    '// Owns nothing in particular here: this line carries no task id',
  ].join('\n');
  const parsed = parsePlan(script);
  check('levels are discovered', [...parsed.keys()], ['Foundation', 'Implement', 'Verify']);
  check('object-literal globs are read', parsed.get('Implement').get('W1-RN-01'), [
    'apps/runner/**',
  ]);
  check('comment globs take the phase as their level', parsed.get('Verify').get('W1-QA-01'), [
    'packages/core/src/**',
  ]);
  check(
    'two tasks land at the comment level',
    [...parsed.get('Verify').keys()],
    ['W1-QA-01', 'W1-QA-02'],
  );
  check('a comment brace list is one glob, not two', parsed.get('Verify').get('W1-QA-02'), [
    'packages/gateway/src/**',
    'apps/{web,runner}/e2e/**',
  ]);

  const clashing = [
    "export const ownership = { Implement: { 'A': ['packages/core/**'], 'B': ['packages/core/src/db/**'] } }",
  ].join('\n');
  const c = parsePlan(clashing).get('Implement');
  check('a clashing plan is parsed', [...c.keys()], ['A', 'B']);
  check(
    'and its clash is detected',
    globsIntersect(c.get('A')[0], c.get('B')[0], [], noRoot).intersects,
    true,
  );

  console.log(`\n${failed === 0 ? 'SELF-TEST PASSED' : `SELF-TEST FAILED (${failed} case(s))`}`);
  return failed ? 1 : 0;
}

// ── Entry point ─────────────────────────────────────────────────────────────────────────

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    // The header block, from the line after the shebang up to the `/* global */` pragma that
    // ends it — found by that landmark rather than by a line number. A hardcoded `slice(1, 30)`
    // was here, and adding a mode to the header silently truncated the help text mid-sentence:
    // the usage text is derived from the file, so its extent must be too.
    const lines = readFileSync(import.meta.filename, 'utf8').split('\n');
    const end = lines.findIndex((l) => l.startsWith('/* global'));
    if (end === -1) {
      console.error(
        'This file no longer carries the "/* global" line that ends its header block, so --help ' +
          'cannot tell where the usage text stops. Restore it, or teach main() the new landmark.',
      );
      return 1;
    }
    console.log(
      lines
        .slice(1, end)
        .join('\n')
        .replace(/^\/\/ ?/gm, '')
        .trimEnd(),
    );
    return 0;
  }
  if (args.includes('--self-test')) return selfTest();
  if (args.includes('--pr') || args.includes('--integration')) return prMode(args);
  return planMode(args.filter((a) => a !== '--plan'));
}

// Only exit when run as a program. Importing this module (from a test, or from another
// script) must not terminate the host process — the exported functions above are the API.
// Compared through realpathSync, not path.resolve alone: `import.meta.filename` is already
// symlink-resolved, so on a checkout reached through a symlinked path the two spellings differ,
// main() never runs and the process exits 0 — a gate that passes by doing nothing. Falls back
// to the plain resolve when a path cannot be realpath'd.
const samePath = (a, b) => {
  const real = (p) => {
    try {
      return realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
};
const invokedDirectly = Boolean(process.argv[1]) && samePath(process.argv[1], import.meta.filename);
if (invokedDirectly) process.exit(main(process.argv));
