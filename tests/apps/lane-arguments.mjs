import { LANE_STEPS, LANE_SCENARIOS } from './lane-config.mjs';

/**
 * The command line: every `--app <id>` (default: every registered app) and the steps `--skip`
 * names. Throws naming the first argument it does not take.
 *
 * @param {readonly string[]} argv @param {readonly string[]} registered
 * @returns {{ apps: string[], skip: Set<string> }}
 */
export function parseLaneArgs(argv, registered) {
  /** @type {string[]} */
  const apps = [];
  const skip = new Set();
  for (let at = 0; at < argv.length; at += 2) {
    const [flag, value] = [argv[at], argv[at + 1]];
    if (value === undefined || (flag !== '--app' && flag !== '--skip')) {
      throw new Error('usage: node tests/apps/lane.mjs [--app <id>]... [--skip <step>[,<step>]]');
    }
    if (flag === '--app') {
      if (!registered.includes(value)) throw new Error(`${value} is not a registered app`);
      apps.push(value);
      continue;
    }
    for (const step of value.split(',')) {
      if (!LANE_STEPS.includes(step) && !LANE_SCENARIOS.includes(step)) {
        throw new Error(`${step} is not a lane step`);
      }
      skip.add(step);
    }
  }
  return { apps: apps.length === 0 ? [...registered] : apps, skip };
}
