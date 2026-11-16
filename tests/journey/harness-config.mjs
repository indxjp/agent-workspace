import { URL } from 'node:url';
import { parseArgs } from 'node:util';
import { JourneyFailure } from './harness-failure.mjs';

/**
 * The directory `JOURNEY_WORK_DIR` names, or `null` when it is unset or blank: a blank value would
 * otherwise resolve to the current directory and write the run's files into it.
 *
 * @param {string | undefined} value
 */
export function workDirectoryOf(value) {
  return value === undefined || value.trim() === '' ? null : value;
}

/**
 * The registry `JOURNEY_REGISTRY` names (issue #608), or `null` when it is unset or blank: the run
 * then packs this checkout and publishes it to its own Verdaccio. A value is the post-publish
 * smoke, `https://registry.npmjs.org/`, and must be an `http:` or `https:` URL with no credentials,
 * or the run stops naming the variable.
 *
 * @param {string | undefined} value
 */
export function registryOf(value) {
  if (value === undefined || value.trim() === '') return null;
  const url = URL.canParse(value.trim()) ? new URL(value.trim()) : null;
  if (
    url === null ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new JourneyFailure(
      'JOURNEY_REGISTRY must be an http(s) registry URL without credentials',
    );
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

/**
 * A JSON object whose every value is a string, such as `harness.mjs snapshot`'s output read back
 * from the container. Anything else is refused naming `what`.
 *
 * @param {string} json @param {string} what
 * @returns {Record<string, string>}
 */
export function stringMapOf(json, what) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new JourneyFailure(`${what} printed no JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new JourneyFailure(`${what} printed no JSON object`);
  }
  /** @type {Record<string, string>} */
  const map = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new JourneyFailure(`${what}: ${key} is not a string`);
    map[key] = value;
  }
  return map;
}

/**
 * How the journey talks to the model (issue #609): the fake on the host's loopback by default, or
 * with `--live` the real Anthropic API under `ANTHROPIC_API_KEY`, the repository secret the
 * `journey-live` workflow passes. Anything else on the command line is refused.
 *
 * @param {readonly string[]} argv the arguments after the script
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {{ live: false } | { live: true, apiKey: string }}
 */
export function journeyMode(argv, env) {
  /** @type {boolean | undefined} */
  let live;
  try {
    ({
      values: { live },
    } = parseArgs({ args: [...argv], options: { live: { type: 'boolean' } }, strict: true }));
  } catch (error) {
    throw new JourneyFailure(
      `usage: node tests/journey/run.mjs [--live] (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (live !== true) return { live: false };
  const apiKey = env['ANTHROPIC_API_KEY']?.trim() ?? '';
  if (apiKey === '') {
    throw new JourneyFailure(
      '--live needs ANTHROPIC_API_KEY: an Owner must add the repository secret ANTHROPIC_API_KEY',
    );
  }
  return { live: true, apiKey };
}

/**
 * `--first-hour` (issue #700) runs the stopwatch in place of the journey: split it from `argv`
 * before `journeyMode`, which refuses anything but `--live`.
 *
 * @param {readonly string[]} argv
 */
export function splitFirstHour(argv) {
  return {
    firstHour: argv.includes('--first-hour'),
    rest: argv.filter((a) => a !== '--first-hour'),
  };
}

/**
 * The text a widget test must also see in stub mode only (the fake's own wording, which the real
 * model never says), as the spec's `JOURNEY_EXPECT_TEXT`; nothing under `--live`.
 *
 * @param {boolean} live @param {string} text
 * @returns {Record<string, string>}
 */
export function stubExpectation(live, text) {
  return live ? {} : { JOURNEY_EXPECT_TEXT: text };
}

/**
 * The commands of the first ```sh block of a Markdown page (its fence may carry meta, such as
 * `claim="run"`, tests/docs-claims), as the page writes them: trailing
 * `# comments` and comment-only lines dropped, each `a && b` line split into `a` and `b`. The
 * first-hour stopwatch (issue #700) runs these unchanged, so a docs change changes the test. The one
 * exception is `export NAME=<placeholder>` where the placeholder ends in `...` (the page's
 * `export ANTHROPIC_API_KEY=sk-ant-...`): it is not a command, the harness supplies the real
 * variable (the fake API's key) in the environment, and every other command is kept.
 *
 * @param {string} mdx
 */
export function quickstartCommands(mdx) {
  const block = /^```sh(?: [^\r\n]*)?\r?\n([\s\S]*?)^```/mu.exec(mdx);
  if (block?.[1] === undefined) throw new JourneyFailure('the page has no ```sh block');
  return block[1]
    .split(/\r?\n/u)
    .map((line) => line.replace(/(^|\s+)#.*$/u, '').trim())
    .filter((line) => line !== '' && !/^export \w+=\S*\.\.\.$/u.test(line))
    .flatMap((line) => line.split(/\s+&&\s+/u));
}
