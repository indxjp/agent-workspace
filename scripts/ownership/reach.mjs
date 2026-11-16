import { requiredValue } from './invariants.mjs';
import { matchGlob } from './globs.mjs';
import { trackedFiles } from './repository.mjs';

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
  /** @type {Map<string,string[]>} */
  const dirs = new Map();
  for (const f of files) {
    const slash = f.indexOf('/');
    if (slash === -1) {
      root.push(f);
      continue;
    }
    const dir = f.slice(0, slash);
    if (!dirs.has(dir)) dirs.set(dir, []);
    requiredValue(dirs.get(dir), 'directory was initialized').push(f);
  }
  /** @param {string} a @param {string} b */
  const shallowestFirst = (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1);
  const named = [...dirs.keys()].sort().map((dir) => {
    const paths = requiredValue(dirs.get(dir), 'directory came from the map keys').sort(
      shallowestFirst,
    );
    return {
      dir,
      probes: [
        ...new Set([
          requiredValue(paths[0], 'directory has a tracked path'),
          requiredValue(paths[paths.length - 1], 'directory has a tracked path'),
        ]),
      ],
    };
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
/** @type {import('./types.mjs').RepositoryAreas|null} */
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
/** @param {readonly string[]} globs
 * @param {import('./types.mjs').GlobOptions} [opts]
 * @returns {false|string} */
export function ownsEverything(globs, opts = { root: null }) {
  /** @param {string} p */
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
    return `it matches a file at the repository root and in every area of the tree except ${requiredValue(missed[0], 'one directory was missed').dir} (root, ${reachedDirs.join(', ')}). Leaving one directory out of a claim on all ${reachedDirs.length} of the others is still a claim on the tree — and a directory added tomorrow would serve as the exception just as well`;
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
