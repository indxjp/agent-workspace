/**
 * Pure helpers of the platforms journey: the verdict list of an export reduced to what a golden
 * pins (path, verdict, code), and its comparison with the committed golden.
 */

const VERDICTS = new Set(['native', 'mapped', 'dropped']);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} left @param {string} right */
function byCodeUnit(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The `FieldVerdict[]` of an export as golden entries, sorted by `path` with `note` removed.
 *
 * @param {unknown} report
 * @returns {import('./verdicts.d.mts').GoldenVerdict[]}
 */
export function normaliseVerdicts(report) {
  if (!Array.isArray(report)) throw new TypeError('the verdict report is not an array');
  const entries = report.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`verdict ${String(index)} is not an object`);
    const { path, verdict, code } = entry;
    if (typeof path !== 'string' || path === '') {
      throw new TypeError(`verdict ${String(index)} has no path`);
    }
    if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) {
      throw new TypeError(`verdict ${String(index)} (${path}) has an unknown verdict`);
    }
    if (code !== undefined && typeof code !== 'string') {
      throw new TypeError(`verdict ${String(index)} (${path}) has a code that is not a string`);
    }
    return { path, verdict, ...(code === undefined ? {} : { code }) };
  });
  // Array#sort is stable, so entries with one path keep the order the translator emitted.
  return entries.sort((left, right) => byCodeUnit(left.path, right.path));
}

/** @param {import('./verdicts.d.mts').GoldenVerdict} entry */
function describeEntry(entry) {
  return `${entry.verdict}${entry.code === undefined ? '' : ` (${entry.code})`}`;
}

/** @param {readonly import('./verdicts.d.mts').GoldenVerdict[]} list */
function groupByPath(list) {
  /** @type {Map<string, import('./verdicts.d.mts').GoldenVerdict[]>} */
  const groups = new Map();
  for (const entry of list) groups.set(entry.path, [...(groups.get(entry.path) ?? []), entry]);
  return groups;
}

/**
 * One message per differing path: `+ added`, `- removed` or `~ changed`; `[]` when equal. A path
 * listed twice is compared entry by entry.
 *
 * @param {readonly import('./verdicts.d.mts').GoldenVerdict[]} actual
 * @param {readonly import('./verdicts.d.mts').GoldenVerdict[]} golden
 */
export function compareWithGolden(actual, golden) {
  const now = groupByPath(actual);
  const before = groupByPath(golden);
  const messages = [];
  for (const [path, entries] of now) {
    const expected = before.get(path) ?? [];
    for (const [index, entry] of entries.entries()) {
      const previous = expected[index];
      if (previous === undefined) messages.push(`+ ${path}: ${describeEntry(entry)} is new`);
      else if (previous.verdict !== entry.verdict || previous.code !== entry.code) {
        messages.push(`~ ${path}: ${describeEntry(previous)} -> ${describeEntry(entry)}`);
      }
    }
  }
  for (const [path, expected] of before) {
    for (const entry of expected.slice((now.get(path) ?? []).length)) {
      messages.push(`- ${path}: ${describeEntry(entry)} is gone`);
    }
  }
  return messages;
}

/**
 * @param {readonly string[]} listed the ids `aw platforms list` prints
 * @param {readonly string[]} goldenIds the ids that have a golden file
 */
export function assertIdSet(listed, goldenIds) {
  const have = new Set(goldenIds);
  const want = new Set(listed);
  const missing = listed.filter((id) => !have.has(id));
  const extra = goldenIds.filter((id) => !want.has(id));
  if (missing.length === 0 && extra.length === 0) return;
  const parts = [];
  if (missing.length > 0) parts.push(`no golden for platform ${missing.join(', ')}`);
  if (extra.length > 0) parts.push(`golden without a platform: ${extra.join(', ')}`);
  throw new Error(parts.join('; '));
}

/** Key names only, never values, so a parse failure can be logged without leaking response data. */
function topLevelKeys(/** @type {unknown} */ list) {
  if (isRecord(list)) return Object.keys(list).sort().join(', ');
  if (list === null) return 'null';
  return Array.isArray(list) ? 'array' : typeof list;
}

/**
 * One page of `GET /v1/agents` or `GET /v1/environments` (header `anthropic-beta:
 * managed-agents-2026-04-01`), reduced to what the live lane reads: `data[].{id, name, archived_at}`
 * and the opaque `next_page` cursor. Per https://platform.claude.com/docs/en/api/beta/agents/list
 * and https://platform.claude.com/docs/en/api/beta/environments/list, `next_page` is an optional
 * string or null: absent or null is the last page; any other type fails closed. Every error names
 * the top-level keys of the response, never their values. The shapes are committed as
 * `fixtures/agents-list.json` and `fixtures/environments-list.json`.
 *
 * @param {unknown} list
 * @param {'agents' | 'environments'} [noun] which list the page belongs to, for the error text
 * @returns {import('./verdicts.d.mts').AgentsPage}
 */
export function agentsPage(list, noun = 'agents') {
  const keys = ` (top-level keys: ${topLevelKeys(list)})`;
  if (!isRecord(list) || !Array.isArray(list['data'])) {
    throw new TypeError(`the ${noun} list has no data array${keys}`);
  }
  const nextPage = list['next_page'] ?? null;
  if (nextPage !== null && typeof nextPage !== 'string') {
    throw new TypeError(
      `the ${noun} list has a next_page that is neither a string, null nor absent${keys}`,
    );
  }
  const agents = list['data'].map((entry, index) => {
    if (!isRecord(entry) || typeof entry['id'] !== 'string' || typeof entry['name'] !== 'string') {
      throw new TypeError(`${noun} entry ${String(index)} has no string id and name${keys}`);
    }
    const archived = entry['archived_at'];
    if (archived !== undefined && archived !== null && typeof archived !== 'string') {
      throw new TypeError(
        `${noun} entry ${String(index)} has an archived_at that is not a string${keys}`,
      );
    }
    return { id: entry['id'], name: entry['name'], archived: typeof archived === 'string' };
  });
  return { agents, nextPage };
}

/**
 * The resources `ant apply` recorded in `claude-lock.json` (`resources["./agents/<f>.md"] = { kind,
 * id }`), sorted into what the live lane can remove: agent, skill and environment ids, and anything
 * else. The kind is taken from the `./agents/`, `./skills/` or `./environments/` path, else the
 * entry's unverified `kind`.
 *
 * @param {string} text
 * @returns {import('./verdicts.d.mts').LockResources}
 */
export function lockResources(text) {
  const lock = /** @type {unknown} */ (JSON.parse(text));
  if (!isRecord(lock) || !isRecord(lock['resources'])) {
    throw new TypeError('the lock file has no resources object');
  }
  /** @type {import('./verdicts.d.mts').LockResources} */
  const found = { agents: [], skills: [], environments: [], other: [] };
  for (const [key, entry] of Object.entries(lock['resources'])) {
    if (!isRecord(entry) || typeof entry['id'] !== 'string') {
      throw new TypeError(`lock resource ${key} has no string id`);
    }
    const kind = key.startsWith('./agents/')
      ? 'agent'
      : key.startsWith('./skills/')
        ? 'skill'
        : key.startsWith('./environments/')
          ? 'environment'
          : typeof entry['kind'] === 'string'
            ? entry['kind']
            : 'unknown';
    if (kind === 'agent') found.agents.push(entry['id']);
    else if (kind === 'skill') found.skills.push(entry['id']);
    else if (kind === 'environment') found.environments.push(entry['id']);
    else found.other.push(`${kind} ${entry['id']} (${key})`);
  }
  return found;
}

/**
 * The `ant` commands that remove what a lock file records, in reverse dependency order (agents,
 * then skills, then environments), and one problem per kind it cannot remove (fail closed, naming
 * the kind and id). VERIFY, read 2026-10-13, not yet confirmed by a dispatched run:
 * - https://platform.claude.com/docs/en/api/cli/beta/agents/archive
 *   (`ant beta:agents archive --agent-id <id>`)
 * - https://platform.claude.com/docs/en/api/cli/beta/skills/delete
 *   (`ant beta:skills delete --skill-id <id>`)
 * - https://platform.claude.com/docs/en/api/cli/beta/environments/delete
 *   (`ant beta:environments delete --environment-id <id>`)
 *
 * @param {import('./verdicts.d.mts').LockResources} resources
 * @returns {import('./verdicts.d.mts').CleanupPlan}
 */
export function cleanupPlan(resources) {
  return {
    commands: [
      ...resources.agents.map((id) => ['beta:agents', 'archive', '--agent-id', id]),
      ...resources.skills.map((id) => ['beta:skills', 'delete', '--skill-id', id]),
      ...resources.environments.map((id) => [
        'beta:environments',
        'delete',
        '--environment-id',
        id,
      ]),
    ],
    problems: resources.other.map((other) => `not removed, unknown kind: ${other}`),
  };
}

/**
 * The active (not archived) agent whose name is exactly `name`; `awpt-123` never matches `awpt-1234`.
 *
 * @param {unknown} list one page of the agents list
 * @param {string} name
 */
export function findAgentByName(list, name) {
  return agentsPage(list).agents.find((agent) => agent.name === name && !agent.archived);
}
