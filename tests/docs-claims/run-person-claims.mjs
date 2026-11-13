/**
 * @typedef {import('./run.d.mts').Machine} Machine
 * @typedef {import('./run.d.mts').Row} Row
 */
import { performance } from 'node:perf_hooks';
import { CLI_PAGE } from './run-config.mjs';
import { lineOf } from './run-plans.mjs';

async function recordPersonRow(rows, { needle, what, check, unavailable = null }) {
  const where = `${CLI_PAGE}:${String(lineOf(CLI_PAGE, needle))}`;
  if (unavailable !== null) {
    rows.push({ where, state: 'run', what, result: `n/a (${unavailable})` });
    return;
  }
  const started = performance.now();
  let problem;
  try {
    problem = await check();
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  rows.push({
    where,
    state: 'run',
    what,
    result: problem === null ? 'pass' : 'FAIL: not what the page says',
    seconds: (performance.now() - started) / 1000,
    detail: problem ?? undefined,
  });
}

/**
 * The "running without a person" rows of `cli/overview.mdx`, on the real `aw` binary.
 *
 * @param {Machine} machine
 * @returns {Promise<Row[]>}
 */
export async function personRows(machine) {
  const env = { AGENT_WORKSPACE_URL: 'http://127.0.0.1:9' };
  const dir = machine.resolve(machine.claims, 'aw-without-a-person');
  await machine.mkdir(dir);
  /** @param {string} command @param {number} timeoutMs */
  const aw = (command, timeoutMs) => machine.exec(command, { cwd: dir, env, timeoutMs });
  /** @type {Row[]} */
  const rows = [];

  await recordPersonRow(rows, {
    needle: '| `aw init`',
    what: 'aw init, no terminal, no --yes: exit 1, fix: aw init --yes, no file',
    check: async () => {
      const result = await aw('aw init', machine.commandMs);
      const listing = (await machine.list(dir)).join(' ');
      if (result.status !== 1) return `exit ${String(result.status)}, not 1\n${result.output}`;
      if (!result.output.includes('fix: aw init --yes'))
        return `no "fix: aw init --yes" line\n${result.output}`;
      if (listing !== '') return `it wrote ${listing}`;
      return null;
    },
  });
  // Every machine's environment has CI=true, which is what the page's row is about.
  await recordPersonRow(rows, {
    needle: '| `aw login`',
    what: 'CI=true aw login: exit 1, fix: set AGENT_WORKSPACE_API_KEY',
    check: async () => {
      const result = await aw('aw login', machine.commandMs);
      if (result.status !== 1) return `exit ${String(result.status)}, not 1\n${result.output}`;
      if (!result.output.includes('fix: set AGENT_WORKSPACE_API_KEY')) {
        return `no "fix: set AGENT_WORKSPACE_API_KEY" line\n${result.output}`;
      }
      return null;
    },
  });
  await recordPersonRow(rows, {
    needle: '--api-key-stdin',
    what: 'aw --api-key-stdin on a pipe that stays silent: exit 2 after ten seconds',
    check: async () => {
      // A fifo held open by this shell: stdin is a pipe that never writes and never closes.
      const result = await aw(
        'f=$(mktemp -u); mkfifo "$f"; exec 3<>"$f"; s=$(date +%s); aw agents list --api-key-stdin < "$f"; c=$?; echo "exit=$c seconds=$(( $(date +%s) - s ))"',
        machine.commandMs,
      );
      const seen = /exit=(\d+) seconds=(\d+)/u.exec(result.output);
      const code = Number(seen?.[1]);
      const seconds = Number(seen?.[2]);
      if (seen === null || code !== 2 || seconds < 9 || seconds > 20) {
        return `expected exit 2 after about ten seconds\n${result.output}`;
      }
      return null;
    },
    unavailable: machine.fifo ? null : 'needs a POSIX fifo',
  });
  return rows;
}
