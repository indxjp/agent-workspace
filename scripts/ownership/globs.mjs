import { requiredValue } from './invariants.mjs';
import { existsSync, statSync } from 'node:fs';

import path from 'node:path';
import { REPO_ROOT } from './repository.mjs';

// ── Glob matching ───────────────────────────────────────────────────────────────────────
// Supported: ** (any number of path segments), * (any run within one segment), ? (one
// character within one segment), {a,b} brace lists. Nothing else — deliberately.

/** Expand `{a,b}` lists into the flat list of alternative patterns. */
/** @param {string} pattern
 * @returns {string[]} */
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
/** @param {string} body
 * @returns {string[]} */
export function splitTopLevel(body) {
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
/** @param {unknown} glob
 * @param {import('./types.mjs').GlobOptions} [options]
 * @returns {string} */
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

/** @param {string} seg */
function segmentToRegExp(seg) {
  let out = '';
  for (const ch of seg) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/** @param {string} glob */
function globToRegExp(glob) {
  const segs = glob.split('/');
  let src = '^';
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1;
    if (segs[i] === '**') {
      src += last ? '.+' : '(?:[^/]+/)*';
      continue;
    }
    src += segmentToRegExp(requiredValue(segs[i], 'glob segment index is in bounds'));
    if (!last) src += '/';
  }
  return new RegExp(src + '$');
}

/** Does `filePath` fall inside `glob`? */
/** @param {string} glob
 * @param {string} filePath
 * @param {import('./types.mjs').GlobOptions} [opts] */
export function matchGlob(glob, filePath, opts) {
  const file = String(filePath).replace(/^\.\//, '');
  return expandBraces(normalizeGlob(glob, opts)).some((g) => globToRegExp(g).test(file));
}

/** Does `filePath` fall inside any of `globs`? */
/** @param {readonly string[]} globs
 * @param {string} filePath
 * @param {import('./types.mjs').GlobOptions} [opts] */
export function matchAny(globs, filePath, opts) {
  return globs.some((g) => matchGlob(g, filePath, opts));
}

// ── Intersection of two globs ───────────────────────────────────────────────────────────

/** The leading literal path portion of a glob, i.e. everything before the first wildcard. */
/** @param {string} glob */
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
/** @param {string} a
 * @param {string} b */
export function literalPrefixOverlap(a, b) {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  const [short, long] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  if (short === '') return true;
  return long === short || long.startsWith(short + '/');
}

/** Can two single-segment patterns (`*`, `?`, literals) generate a common string? */
/** @param {string} p
 * @param {string} q
 * @returns {boolean} */
function segmentsIntersect(p, q) {
  /** @type {Map<number,boolean>} */
  const memo = new Map();
  /** @param {number} i @param {number} j @returns {boolean} */
  const go = (i, j) => {
    const key = i * (q.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
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
/** @param {string} a
 * @param {string} b
 * @returns {boolean} */
function patternsIntersect(a, b) {
  const A = a.split('/');
  const B = b.split('/');
  /** @type {Map<number,boolean>} */
  const memo = new Map();
  /** @param {number} i @param {number} j @returns {boolean} */
  const go = (i, j) => {
    const key = i * (B.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let r;
    if (i === A.length && j === B.length) r = true;
    else if (i === A.length) r = B.slice(j).every((s) => s === '**');
    else if (j === B.length) r = A.slice(i).every((s) => s === '**');
    else if (A[i] === '**') r = go(i + 1, j) || go(i, j + 1);
    else if (B[j] === '**') r = go(i, j + 1) || go(i + 1, j);
    else
      r =
        segmentsIntersect(
          requiredValue(A[i], 'left glob index is in bounds'),
          requiredValue(B[j], 'right glob index is in bounds'),
        ) && go(i + 1, j + 1);
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
/** @param {unknown} globA
 * @param {unknown} globB
 * @param {readonly string[]} [files]
 * @param {import('./types.mjs').GlobOptions} [opts]
 * @returns {import('./types.mjs').Intersection} */
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
/** @param {readonly string[]} ownedGlobs
 * @param {readonly string[]} changedFiles
 * @param {import('./types.mjs').GlobOptions} [opts] */
export function findViolations(ownedGlobs, changedFiles, opts) {
  return changedFiles.filter((f) => f && !matchAny(ownedGlobs, f, opts));
}
