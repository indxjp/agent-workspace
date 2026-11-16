import { isRecord, requiredValue } from './invariants.mjs';
/* global console, process */
import { existsSync, readFileSync } from 'node:fs';

import { findIntegrationViolations, parseIntegrationOwnership, parseOwnership } from './body.mjs';
import { findViolations, matchAny } from './globs.mjs';
import { git, gitDiffFiles, mergeParents, readStdin } from './repository.mjs';

/** @param {string} body
 * @param {string|undefined} base
 * @param {string|undefined} head */
function integrationMode(body, base, head) {
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
    console.error(
      `FAIL: could not read the commit graph (${err instanceof Error ? err.message : String(err)}).`,
    );
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
    const first = requiredValue(shas[0], 'a merge has a first parent');
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

/** @param {string[]} args */
export function prMode(args) {
  /** @param {string} name */
  const arg = (name) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };

  let body = null;
  let base = arg('--base');
  let head = arg('--head');
  let sawPullRequestEvent = false;

  const eventPath = process.env['GITHUB_EVENT_PATH'];
  if (eventPath && existsSync(eventPath)) {
    try {
      /** @type {unknown} */
      const event = JSON.parse(readFileSync(eventPath, 'utf8'));
      if (!isRecord(event)) throw new Error('GitHub event must be an object');
      const pr = event['pull_request'];
      if (pr) {
        sawPullRequestEvent = true;
        if (!isRecord(pr)) throw new Error('pull_request must be an object');
        body = optionalText(pr['body'], 'pull_request.body') ?? '';
        base ??= commitSha(pr['base']);
        head ??= commitSha(pr['head']);
      }
    } catch (err) {
      console.error(
        `Could not read GITHUB_EVENT_PATH: ${err instanceof Error ? err.message : String(err)}`,
      );
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
  if (args.includes('--integration')) return integrationMode(body, base, head);

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
    console.error(
      `FAIL: could not compute the diff (${err instanceof Error ? err.message : String(err)}).`,
    );
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

/** @param {unknown} value @param {string} field @returns {string|undefined} */
function optionalText(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(field + ' must be text');
  return value;
}
/** @param {unknown} value @returns {string|undefined} */
function commitSha(value) {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('commit reference must be an object');
  return optionalText(value['sha'], 'commit sha');
}
