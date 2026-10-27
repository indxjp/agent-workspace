/**
 * Which runner a workflow job may start on, shared by scripts/check-workflows.mjs (this
 * repository's policy) and scripts/oss/check-public-tree.mjs (the public export's gate).
 *
 * One workflow file serves INDXDev and the public repository (docs/adr/0053, Amendment 2026-10-26):
 * a job either carries the INDXDev guard, so nowhere else ever starts it, or runs on a runner that
 * is free on a public repository.
 */

const GUARD_PREFIX = "    if: github.repository_owner == 'INDXDev'";

// A standard GitHub-hosted runner, free on a public repository. A larger runner (`-large`,
// `-xlarge`, `N-cores`), a self-hosted pool or a vendor such as Blacksmith bills the Owner, and a
// self-hosted runner would let a fork's pull request run on the Owner's machines.
const HOSTED_RUNNER = /^(?:ubuntu|windows|macos)-(?:latest|\d+(?:\.\d+)?)(?:-arm)?$/u;
// The one expression a shared job may use: INDXDev's runner, else the hosted label it names.
const INTERNAL_OR_HOSTED =
  /^\$\{\{ github\.repository_owner == 'INDXDev' && (?:'[^']+'|fromJSON\('[^']+'\)) \|\| '([^']+)' \}\}$/u;

/**
 * The jobs of a workflow, each with the lines of its body.
 * @param {string} source
 * @returns {{ id: string, lines: { text: string, number: number }[] }[]}
 */
export function workflowJobs(source) {
  /** @type {{ id: string, lines: { text: string, number: number }[] }[]} */
  const jobs = [];
  let inJobs = false;
  for (const [index, text] of source.split(/\r?\n/u).entries()) {
    if (/^jobs:\s*$/u.test(text)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^[^\s#]/u.test(text)) {
      inJobs = false;
      continue;
    }
    const id = text.match(/^ {2}([a-zA-Z0-9_-]+):\s*$/u)?.[1];
    if (id !== undefined) jobs.push({ id, lines: [] });
    else jobs.at(-1)?.lines.push({ text, number: index + 1 });
  }
  return jobs;
}

/**
 * True when every opening parenthesis outside a quoted string closes before the end, and none
 * closes early, so `(a) || (b)` is refused: `owner && (a) || (b)` would run `b` anywhere.
 * @param {string} text
 */
function isOneGroup(text) {
  if (!text.startsWith('(') || !text.endsWith(')')) return false;
  let depth = 0;
  let quoted = false;
  for (const [index, char] of [...text].entries()) {
    if (char === "'") quoted = !quoted;
    if (quoted) continue;
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && index < text.length - 1) return false;
  }
  return depth === 0 && !quoted;
}

/**
 * The job-level `if:` that keeps a job to INDXDev: the owner test alone, or ANDed with one
 * parenthesised condition.
 * @param {string} line
 */
export function isInternalGuard(line) {
  if (!line.startsWith(GUARD_PREFIX)) return false;
  const rest = line.slice(GUARD_PREFIX.length).trimEnd();
  return rest === '' || (rest.startsWith(' && ') && isOneGroup(rest.slice(4)));
}

/** @param {{ text: string }[]} lines a job's body */
export const isInternalOnlyJob = (lines) => lines.some(({ text }) => isInternalGuard(text));

/** @param {string} value a `runs-on` value as written, without a trailing comment */
export function isFreeHostedRunner(value) {
  const fallback = value.match(INTERNAL_OR_HOSTED)?.[1] ?? value;
  return HOSTED_RUNNER.test(fallback);
}
