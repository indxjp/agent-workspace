#!/usr/bin/env node
/* global console */
/**
 * The slice-1 exit test's pure helpers (S1-19, issue #457): what `run.mjs` and `widget.e2e.mjs`
 * decide, kept apart from what they run so that `harness.test.ts` can prove each refusal. It uses
 * node builtins only, because `run.mjs` copies it into the clean container, where nothing of this
 * repository is installed.
 *
 * Every refusal throws {@link JourneyFailure}, whose message names the reason. The fake provider's
 * key is compared, never printed, and {@link redact} removes it from every captured log.
 *
 * It is also a tiny CLI for use inside the container:
 *
 *   node harness.mjs snapshot <dir>   prints {relativePath: sha256} of <dir>, tool-owned paths left out
 *   JOURNEY_SECRET=… node harness.mjs find <dir>…
 *                                     prints the files holding the secret, SEALED_PATHS left out;
 *                                     the secret comes from the environment, never an argument
 *
 * S2-08 (issue #550) adds the slice-2 checks: B2's and B3's budgets, the tool call, the ceiling's
 * server refusal and the secret's absence.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * The exit criterion's budget, in seconds: `npm create` to an answering widget in ten minutes or
 * less (plan §1). It is a constant on purpose: no option, variable or report field can raise it.
 */
export const JOURNEY_BUDGET_SECONDS = 600;

/** B2's budget (S2-08): a colour written to `surfaces/main.ts` shows in the launcher within 60 s. */
export const JOURNEY_LOOK_CHANGE_BUDGET_SECONDS = 60;

/** B3's budget (S2-08): an OpenAPI document becomes a tool the widget answers with in 900 s. */
export const JOURNEY_TOOL_BUDGET_SECONDS = 900;

/** The only budgets a report may be checked against: no other value is accepted anywhere. */
const BUDGETS = [
  JOURNEY_BUDGET_SECONDS,
  JOURNEY_LOOK_CHANGE_BUDGET_SECONDS,
  JOURNEY_TOOL_BUDGET_SECONDS,
];

/** @param {number} seconds */
function declaredBudget(seconds) {
  if (!BUDGETS.includes(seconds)) {
    throw new JourneyFailure(
      `${String(seconds)} s is not a journey budget; the budgets are ${BUDGETS.join(', ')} s`,
    );
  }
  return seconds;
}

/**
 * What `npm install` and `aw dev` own inside the project: the installed packages, npm's lockfile
 * and the local runtime's state directory. A path that ends with `/` is a directory, compared by
 * prefix; any other is one file. Everything else in `demo/` must stay as `npm create` wrote it.
 * `.aw/` holds the runtime log (`.aw/logs/runtime.log`); the template's `.gitignore` lists it.
 */
export const TOOL_OWNED_PATHS = ['node_modules/', 'package-lock.json', '.agent-workspace/', '.aw/'];

/** The one surface a new project has (C4). */
const SURFACE_NAME = 'main';

/**
 * What the widget renders for an unset `theme.colour` (`SURFACE_DEFAULTS.colour` in
 * `packages/react/src/theme.ts`), and also the brand-colour question's recommended
 * answer (`packages/contracts/src/setup.ts`). A launcher in this colour proves nothing about
 * `surfaces/main.ts`, so the journey answers the question with {@link JOURNEY_BRAND_COLOUR}.
 */
export const DEFAULT_SURFACE_COLOUR = '#2f5fd0';

/** The brand colour the journey types at `npm create`'s question: not the default. */
export const JOURNEY_BRAND_COLOUR = '#c0392b';

/** Below this, a command cannot run: a deadline this close is reported as run out. */
export const MIN_COMMAND_MS = 5_000;

/** A refusal of the journey: the message names what failed. */
export class JourneyFailure extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'JourneyFailure';
  }
}

const READY_LINE = /^ready (https?:\/\/\S+)$/u;
const SIGNED_IN_LINE = /^signed in as \S+ \(workspace [^()\s]+\)$/u;
// The ready screen's plain rows (`try       <url>`, `embed     <script ...>`, packages/aw/src/dev/format.ts)
// and the older `try: <url>` / `widget: <script ...>` lines.
const WIDGET_LINE =
  /^(?:widget:|embed)\s+<script src="(https?:\/\/[^"\s]+\/p\/s\/[^"/\s]+\/widget\.js)" async><\/script>$/u;
const TRY_LINE = /^try:?\s+(https?:\/\/\S+\/p\/s\/[^/\s]+\/try)$/u;
const MODEL_CONNECTION_LINE = /^model connection: default \(anthropic\)$/u;
/** `aw dev`'s sync summary (`packages/aw/src/dev/format.ts`): `synced: "assistant" version 3 …`. */
const SYNCED_LINE = /^synced: \S/u;
/**
 * The ready screen's console row (`packages/aw/src/dev/format.ts`): the bootstrap admin's email.
 * The password is never printed (BH061-011); the next row names the file that keeps it.
 */
const ADMIN_SIGN_IN_LINE = /^sign in as (\S+@\S+)$/u;

/**
 * One line `aw dev` printed, as the journey reads it: the ready screen's `try <url>` and
 * `embed <script …>` rows, the older `ready <url>`, `try: <url>` and `widget: <script …>` lines,
 * `signed in as <email> (workspace <slug>)`, C6's
 * `model connection: default (anthropic)`, the sync summary `synced: …`, and the console row
 * `sign in as <email>`. Any other line is `null`.
 *
 * @param {string} line
 */
export function parseDevLine(line) {
  const text = line.replace(/\r$/u, '').trim();
  const ready = READY_LINE.exec(text);
  if (ready?.[1] !== undefined) return { kind: /** @type {const} */ ('ready'), url: ready[1] };
  if (SIGNED_IN_LINE.test(text)) return { kind: /** @type {const} */ ('signedIn') };
  const widget = WIDGET_LINE.exec(text);
  if (widget?.[1] !== undefined) return { kind: /** @type {const} */ ('widget'), src: widget[1] };
  const tryPage = TRY_LINE.exec(text);
  if (tryPage?.[1] !== undefined) return { kind: /** @type {const} */ ('try'), url: tryPage[1] };
  if (MODEL_CONNECTION_LINE.test(text)) return { kind: /** @type {const} */ ('modelConnection') };
  if (SYNCED_LINE.test(text)) return { kind: /** @type {const} */ ('synced') };
  const admin = ADMIN_SIGN_IN_LINE.exec(text);
  if (admin?.[1] !== undefined)
    return { kind: /** @type {const} */ ('adminSignIn'), email: admin[1] };
  return null;
}

/**
 * The server origin a parsed dev line proves ready, or `null`. The ready screen has no `ready <url>`
 * line; its `try` and `embed` rows carry the origin and print once the runtime is up.
 *
 * @param {ReturnType<typeof parseDevLine>} parsed
 */
export function devOrigin(parsed) {
  if (parsed?.kind === 'ready') return parsed.url;
  if (parsed?.kind === 'try') return new URL(parsed.url).origin;
  if (parsed?.kind === 'widget') return new URL(parsed.src).origin;
  return null;
}

const HEX_COLOUR = /^#[0-9a-f]{6}$/u;

/**
 * The brand colour the renderer wrote into `surfaces/main.ts` (C4: `theme.colour`, printed as
 * `colour: '#rrggbb',`), lower-cased.
 *
 * @param {string} text the file's contents
 */
export function colourOfSurfaceSource(text) {
  const match = /^\s*colour:\s*'(#[0-9a-fA-F]{6})',?\s*$/mu.exec(text);
  if (match?.[1] === undefined) {
    throw new JourneyFailure('surfaces/main.ts names no theme colour (colour: #rrggbb)');
  }
  return match[1].toLowerCase();
}

/**
 * The colour `surfaces/main.ts` names is the one the journey answered, and that answer differs from
 * what the widget renders without a theme, so the launcher's colour can tell the two apart.
 *
 * @param {string} fileHex the colour read from `surfaces/main.ts` @param {string} answeredHex
 */
export function assertBrandColour(fileHex, answeredHex) {
  const answered = answeredHex.toLowerCase();
  if (answered === DEFAULT_SURFACE_COLOUR) {
    throw new JourneyFailure(
      `the brand colour ${answeredHex} is the widget's default, so the launcher cannot prove it`,
    );
  }
  if (fileHex.toLowerCase() !== answered) {
    throw new JourneyFailure(
      `surfaces/main.ts names ${fileHex}, not the answered brand colour ${answeredHex}`,
    );
  }
}

/** @param {string} hex a `#rrggbb` colour */
function rgbOf(hex) {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}

/**
 * The launcher's computed background (`rgb(r, g, b)`, or `rgba(…, 1)`) must be the colour
 * `surfaces/main.ts` names.
 *
 * @param {string} expectedHex @param {string} computedCss
 */
export function assertLauncherColour(expectedHex, computedCss) {
  const expected = expectedHex.toLowerCase();
  if (!HEX_COLOUR.test(expected)) {
    throw new JourneyFailure(`surfaces/main.ts's colour ${expectedHex} is not #rrggbb`);
  }
  const match = /^rgba?\(\s*(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})(?:,\s*(?:1|1\.0+))?\s*\)$/u.exec(
    computedCss,
  );
  const actual = match === null ? null : [match[1], match[2], match[3]].map(Number);
  const wanted = rgbOf(expected);
  if (actual === null || actual.some((channel, index) => channel !== wanted[index])) {
    throw new JourneyFailure(
      `launcher colour ${computedCss} is not surfaces/main.ts's ${expectedHex}`,
    );
  }
}

/**
 * The fake provider answered `nonce` on `POST /v1/messages`, and the request carried `apiKey`:
 * the key the journey generated, so the reply came through the `default` model connection. The
 * key is compared, never printed.
 *
 * @param {readonly import('../generated-project/fake-anthropic.mjs').FakeRequestRecord[]} requests
 * @param {string} nonce @param {string} apiKey
 */
export function assertReplyRecorded(requests, nonce, apiKey) {
  const answered = requests.filter(
    (request) =>
      request.method === 'POST' &&
      request.path === '/v1/messages' &&
      request.reply !== null &&
      request.reply.includes(`Fake Anthropic reply to ${nonce}`),
  );
  if (answered.length === 0) throw new JourneyFailure(`the fake provider never answered ${nonce}`);
  if (!answered.some((request) => request.apiKey === apiKey)) {
    throw new JourneyFailure(
      `the fake provider answered ${nonce}, but never under the generated key`,
    );
  }
}

/**
 * @param {string} relative a `/`-separated path relative to the snapshot root
 * @param {readonly string[]} excluded
 */
function isExcluded(relative, excluded) {
  return excluded.some((entry) =>
    entry.endsWith('/')
      ? relative === entry.slice(0, -1) || relative.startsWith(entry)
      : relative === entry,
  );
}

/** @param {string | Buffer} contents */
function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

/**
 * Calls `visit` for everything under `dir` that is not a directory (relative `/`-separated path,
 * absolute path, its `lstat`); an excluded directory is not entered and a link is not followed.
 *
 * @param {string} dir @param {readonly string[]} excluded
 * @param {(relative: string, absolute: string, stat: import('node:fs').Stats) => void} visit
 */
function walkFiles(dir, excluded, visit) {
  /** @param {string} relative */
  const walk = (relative) => {
    const absolute = relative === '' ? dir : path.join(dir, ...relative.split('/'));
    for (const name of readdirSync(absolute)) {
      const child = relative === '' ? name : `${relative}/${name}`;
      if (isExcluded(child, excluded)) continue;
      const childPath = path.join(absolute, name);
      const stat = lstatSync(childPath);
      if (stat.isDirectory()) walk(child);
      else visit(child, childPath, stat);
    }
  };
  walk('');
}

/** @param {string} left @param {string} right */
function byPath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every file under `dir`, as `{relativePath: sha256}` sorted by path. A symbolic link is hashed
 * by its target and not followed; an excluded directory is not entered.
 *
 * @param {string} dir @param {readonly string[]} [excluded]
 * @returns {Record<string, string>}
 */
export function snapshotTree(dir, excluded = TOOL_OWNED_PATHS) {
  /** @type {[string, string][]} */
  const entries = [];
  walkFiles(dir, excluded, (relative, absolute, stat) => {
    entries.push([
      relative,
      stat.isSymbolicLink()
        ? sha256(`symlink:${readlinkSync(absolute)}`)
        : sha256(readFileSync(absolute)),
    ]);
  });
  entries.sort(([left], [right]) => byPath(left, right));
  return Object.fromEntries(entries);
}

/**
 * What the secret check leaves out of a project: the installed packages, which hold no secret of
 * the run, and the sealed store, the embedded PostgreSQL that keeps the connector's credential
 * sealed (`packages/embedded/src/embedded-db.ts`). Transcripts and the rest of `.agent-workspace/`
 * are read.
 */
export const SEALED_PATHS = ['node_modules/', '.agent-workspace/postgres/'];

/**
 * The regular files under `dir` whose bytes contain `secret`, sorted, the excluded paths left out;
 * no link is followed and no socket or pipe (a running runtime's) is opened. A blank secret is
 * refused: it would be found everywhere and prove nothing.
 *
 * @param {string} dir @param {string} secret @param {readonly string[]} [excluded]
 */
export function filesContaining(dir, secret, excluded = SEALED_PATHS) {
  if (secret === '') throw new JourneyFailure('the secret check was given no secret');
  const needle = Buffer.from(secret, 'utf8');
  /** @type {string[]} */
  const found = [];
  walkFiles(dir, excluded, (relative, absolute, stat) => {
    if (stat.isFile() && readFileSync(absolute).includes(needle)) found.push(relative);
  });
  return found.sort(byPath);
}

/**
 * None of `places` (`{ name: text }`: a log, an environment, a request body) contains `secret`, or
 * the run fails naming each place it is in, never the secret itself.
 *
 * @param {Readonly<Record<string, string>>} places @param {string} secret
 */
export function assertSecretAbsent(places, secret) {
  if (secret === '') throw new JourneyFailure('the secret check was given no secret');
  const holding = Object.keys(places).filter((name) => places[name]?.includes(secret));
  if (holding.length > 0) {
    throw new JourneyFailure(`the token appears in: ${holding.join(', ')}`);
  }
}

/**
 * What changed between two snapshots, each list sorted.
 *
 * @param {Readonly<Record<string, string>>} before @param {Readonly<Record<string, string>>} after
 */
export function diffTrees(before, after) {
  const added = Object.keys(after).filter((file) => !Object.hasOwn(before, file));
  const removed = Object.keys(before).filter((file) => !Object.hasOwn(after, file));
  const changed = Object.keys(after).filter(
    (file) => Object.hasOwn(before, file) && before[file] !== after[file],
  );
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

/**
 * Nothing but the tool-owned paths changed in the project `label` names (`demo`, `demo-tools`)
 * since `npm create` wrote it: the journey edits no file by hand, and neither may anything it runs.
 * Every changed path is listed. `allowedAdded` names the developer's own input files (B3a's OpenAPI
 * document), which may be added but, like every other file, never changed once they are there.
 *
 * @param {string} label @param {Readonly<Record<string, string>>} before
 * @param {Readonly<Record<string, string>>} after @param {readonly string[]} [allowedAdded]
 */
export function assertUnchanged(label, before, after, allowedAdded = []) {
  const diff = diffTrees(before, after);
  const { changed, removed } = diff;
  const added = diff.added.filter((file) => !allowedAdded.includes(file));
  if (added.length + changed.length + removed.length === 0) return;
  const lines = [
    ...added.map((file) => `  added: ${file}`),
    ...changed.map((file) => `  changed: ${file}`),
    ...removed.map((file) => `  removed: ${file}`),
  ];
  throw new JourneyFailure(`${label}/ changed after init:\n${lines.join('\n')}`);
}

/** @param {number} seconds */
function tenths(seconds) {
  return Math.round(seconds * 10) / 10;
}

/**
 * Rounded up to a tenth, so that a rounded total never understates the measurement: 600.04 s is
 * recorded as 600.1 s, over the budget wherever it is read.
 *
 * @param {number} seconds
 */
function tenthsUp(seconds) {
  return Math.ceil(seconds * 10 - 1e-9) / 10;
}

/**
 * The timing record of one timed block against its fixed budget. `wallSeconds` is the block's
 * wall-clock time (for B1, from the start of `npm create` to the answer), the harness's work
 * between the steps included; it is the total the budget is checked against, rounded up. Each
 * step's own seconds are kept beside it. It takes the steps and the wall clock alone; anything
 * else (a budget among them) is refused, and `budgetSeconds` must be one of the declared budgets.
 *
 * @param {{ steps: readonly { name: string, seconds: number }[], wallSeconds: number }} input
 * @param {number} [budgetSeconds]
 */
export function timingsReport(input, budgetSeconds = JOURNEY_BUDGET_SECONDS) {
  const budget = declaredBudget(budgetSeconds);
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'steps' || keys[1] !== 'wallSeconds') {
    throw new JourneyFailure(
      `timingsReport takes only steps and wallSeconds; the budget is fixed at ${String(budget)} s`,
    );
  }
  if (input.steps.length === 0) throw new JourneyFailure('the journey measured no step');
  for (const step of input.steps) {
    if (!Number.isFinite(step.seconds) || step.seconds < 0) {
      throw new JourneyFailure(`step ${step.name} has no valid duration`);
    }
  }
  const stepsTotal = input.steps.reduce((sum, step) => sum + step.seconds, 0);
  if (!Number.isFinite(input.wallSeconds) || input.wallSeconds < stepsTotal - 1e-6) {
    throw new JourneyFailure('the wall-clock time is shorter than the sum of the steps');
  }
  const totalSeconds = tenthsUp(input.wallSeconds);
  return {
    budgetSeconds: budget,
    totalSeconds,
    stepsSeconds: tenths(stepsTotal),
    withinBudget: totalSeconds <= budget,
    steps: input.steps.map((step) => ({ name: step.name, seconds: tenths(step.seconds) })),
  };
}

/** @typedef {ReturnType<typeof timingsReport>} TimingsReport */

/**
 * `journey: <label> <n> s (budget <b> s)`, `<n>` the wall clock: `journey: total 165.1 s (budget
 * 600 s)` for B1, `journey: B2 look change 12.3 s (budget 60 s)` for B2.
 *
 * @param {TimingsReport} report @param {string} [label]
 */
export function totalLine(report, label = 'total') {
  return `journey: ${label} ${String(report.totalSeconds)} s (budget ${String(declaredBudget(report.budgetSeconds))} s)`;
}

/**
 * The record as a Markdown table, for `$GITHUB_STEP_SUMMARY`.
 *
 * @param {TimingsReport} report @param {string} [title]
 */
export function stepSummaryMarkdown(report, title = 'Slice-1 journey') {
  const budget = declaredBudget(report.budgetSeconds);
  return [
    `### ${title} (budget ${String(budget)} s)`,
    '',
    '| Step | Seconds |',
    '| --- | ---: |',
    ...report.steps.map((step) => `| ${step.name} | ${String(step.seconds)} |`),
    `| Sum of the steps | ${String(report.stepsSeconds)} |`,
    `| **Total (wall clock)** | **${String(report.totalSeconds)}** |`,
    '',
    "The total is the block's wall-clock time (for the slice-1 journey, from the start of " +
      "`npm create` to the answer), the harness's work between the steps included, rounded up " +
      'to a tenth of a second.',
    '',
    report.totalSeconds <= budget ? 'Within budget.' : 'Over budget.',
    '',
  ].join('\n');
}

/**
 * The timing record of a run that stopped inside a timed step: the steps that finished, the one
 * that failed with the seconds it ran before it failed, and the wall clock up to the failure. It is
 * written in place of {@link timingsReport}'s record, so the timings the workflow keeps "always"
 * exist for a red run too. It carries no total and no budget verdict: nothing was answered.
 *
 * @param {{ steps: readonly { name: string, seconds: number }[], failed: { name: string, seconds: number }, elapsedSeconds: number }} input
 * @param {number} [budgetSeconds]
 */
export function unfinishedTimingsReport(input, budgetSeconds = JOURNEY_BUDGET_SECONDS) {
  const budget = declaredBudget(budgetSeconds);
  const measured = [...input.steps, input.failed];
  for (const step of measured) {
    if (!Number.isFinite(step.seconds) || step.seconds < 0) {
      throw new JourneyFailure(`step ${step.name} has no valid duration`);
    }
  }
  const stepsTotal = measured.reduce((sum, step) => sum + step.seconds, 0);
  if (!Number.isFinite(input.elapsedSeconds) || input.elapsedSeconds < stepsTotal - 1e-6) {
    throw new JourneyFailure('the wall-clock time is shorter than the sum of the steps');
  }
  return {
    budgetSeconds: budget,
    finished: /** @type {const} */ (false),
    elapsedSeconds: tenthsUp(input.elapsedSeconds),
    failedStep: { name: input.failed.name, seconds: tenths(input.failed.seconds) },
    steps: input.steps.map((step) => ({ name: step.name, seconds: tenths(step.seconds) })),
  };
}

/** @typedef {ReturnType<typeof unfinishedTimingsReport>} UnfinishedTimingsReport */

/**
 * B1's unfinished `journey-timings.json` record: the unfinished report and which `model` answered
 * (`fake` or `live`), so a failed live run's record is told apart from a failed stub run's.
 *
 * @param {UnfinishedTimingsReport} report @param {'fake' | 'live'} model
 */
export function unfinishedJourneyRecord(report, model) {
  return { ...report, model };
}

/**
 * An unfinished record as Markdown, for `$GITHUB_STEP_SUMMARY`.
 *
 * @param {UnfinishedTimingsReport} report @param {string} [title]
 */
export function unfinishedSummaryMarkdown(report, title = 'Slice-1 journey') {
  return [
    `### ${title} (budget ${String(declaredBudget(report.budgetSeconds))} s): failed`,
    '',
    '| Step | Seconds |',
    '| --- | ---: |',
    ...report.steps.map((step) => `| ${step.name} | ${String(step.seconds)} |`),
    `| ${report.failedStep.name} (failed) | ${String(report.failedStep.seconds)} |`,
    `| **Wall clock until the failure** | **${String(report.elapsedSeconds)}** |`,
    '',
    'The journey stopped inside a timed step, so no total is checked against the budget.',
    '',
  ].join('\n');
}

/**
 * The total is at most `seconds`, one of the declared budget constants (B1's
 * {@link JOURNEY_BUDGET_SECONDS} by default) and never read from the report, or the run fails
 * naming the slowest step.
 *
 * @param {TimingsReport} report @param {number} [seconds]
 */
export function assertWithinBudget(report, seconds = JOURNEY_BUDGET_SECONDS) {
  const budget = declaredBudget(seconds);
  if (report.totalSeconds <= budget) return;
  const slowest = report.steps.reduce((worst, step) =>
    step.seconds > worst.seconds ? step : worst,
  );
  throw new JourneyFailure(
    `the journey took ${String(report.totalSeconds)} s, over the ${String(budget)} s budget; ` +
      `the slowest step was ${slowest.name} (${String(slowest.seconds)} s)`,
  );
}

/**
 * What is left before `deadline`, for one command's timeout. With less than
 * {@link MIN_COMMAND_MS} left, the run stops naming `variable`, the cap that ran out, instead of
 * starting a command that would be killed at once.
 *
 * @param {number} deadline epoch milliseconds @param {number} now epoch milliseconds
 * @param {string} variable
 */
export function remainingMs(deadline, now, variable) {
  const left = deadline - now;
  if (left < MIN_COMMAND_MS) throw new JourneyFailure(`the run ran out of ${variable}`);
  return left;
}

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

/** The control sequences (CSI, OSC and two-byte escapes) a terminal program writes around a prompt. */
const ANSI_SEQUENCE = new RegExp(
  [
    String.raw`\u001b\[[0-?]*[ -/]*[@-~]`,
    String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)`,
    String.raw`\u001b[@-Z\\-_]`,
  ].join('|'),
  'gu',
);

/**
 * Cursor Horizontal Absolute to column 1 (`ESC[G`, `ESC[0G`, `ESC[1G`): a carriage return. npm's
 * spinner draws a glyph, then `ESC[1G ESC[0K`, and the next program writes over it from column 1.
 */
const CURSOR_TO_LINE_START = new RegExp(String.raw`\u001b\[[01]?G`, 'gu');

/** `screen` as the lines a terminal shows, without control sequences (see {@link lastLineOf}). */
function linesOf(screen) {
  return screen
    .replace(CURSOR_TO_LINE_START, '\r')
    .replace(ANSI_SEQUENCE, '')
    .split(/\r?\n|\r/u);
}

/**
 * A menu repaints itself after every key: the cursor climbs back over the old frame and erases it
 * (`ESC[<n>A ESC[J`) before the new frame's title. {@link drawnMenu} marks that spot, so a frame
 * the menu drew in answer to our own keys is told from the one it first drew.
 */
const MENU_ERASE = new RegExp(String.raw`\u001b\[[0-9]+A\u001b\[J`, 'gu');
const REDRAW_MARK = '\uE000';

/** A select menu's title line (UX-A) and one of its option rows. */
const MENU_TITLE = /^\uE000?\? .+\(up\/down move, .*enter accepts\)$/u;
const MENU_ROW = /^[ >] [([][ *x][)\]] /u;
/** The whole summary of the option under the cursor, drawn below the rows when cut (BH061-053). */
const MENU_SUMMARY = /^ {2}[^ ([]/u;

/**
 * Whether `screen` ends with a whole select menu, drawn in one frame: its title, at least two
 * option rows, perhaps the cursor's summary, and the newline after the last. Enter (an empty line)
 * accepts the recommendation.
 *
 * @param {string} screen
 */
function drawnMenu(screen) {
  const lines = linesOf(screen.replace(MENU_ERASE, REDRAW_MARK));
  if (lines.at(-1) !== '') return null;
  const title = lines.findLastIndex((line) => MENU_TITLE.test(line));
  const drawn = lines.slice(title + 1, -1);
  const rows = MENU_SUMMARY.test(drawn.at(-1) ?? '') ? drawn.slice(0, -1) : drawn;
  if (title < 0 || rows.length < 2 || !rows.every((row) => MENU_ROW.test(row))) return null;
  // A repaint is our own keys taking effect, not a question to answer again.
  if ((lines[title] ?? '').startsWith(REDRAW_MARK)) return null;
  return {
    title: (lines[title] ?? '').slice(2),
    values: rows.map((row) => row.slice(6).split(' ')[0] ?? ''),
    checked: rows.map((row) => row[3] === '*' || row[3] === 'x'),
    cursor: rows.findIndex((row) => row.startsWith('>')),
  };
}

/**
 * The keys that make a drawn menu answer `wanted` (comma-separated for a multi), ending in the
 * Enter that the caller's line feed supplies: `j` moves down, a space toggles. A multi is first
 * cleared of what it should not hold, then given what it should, one lap of the menu each.
 *
 * @param {{ values: string[], checked: boolean[], cursor: number }} menu
 * @param {string} wanted
 * @param {boolean} multi
 */
function keysForMenu(menu, wanted, multi) {
  const { values, checked, cursor } = menu;
  const count = values.length;
  const picks = wanted
    .split(',')
    .map((pick) => pick.trim())
    .filter((pick) => pick !== '');
  const unknown = picks.filter((pick) => !values.includes(pick));
  if (unknown.length > 0) throw new JourneyFailure(`menu has no option ${unknown.join(', ')}`);
  if (!multi) {
    const target = values.indexOf(picks[0] ?? '');
    return 'j'.repeat((target - cursor + count) % count);
  }
  let keys = '';
  for (const wantOn of [false, true]) {
    for (let step = 0; step < count; step += 1) {
      const index = (cursor + step) % count;
      const isOn = checked[index] === true;
      const shouldBeOn = picks.includes(values[index] ?? '');
      if (isOn !== shouldBeOn && shouldBeOn === wantOn) keys += ' ';
      keys += 'j';
    }
  }
  return keys;
}

/**
 * The last line of what a terminal program printed, without control sequences: the prompt it is
 * waiting on, if it is waiting. A return to column 1 starts the line again, so text it overwrote
 * (a spinner glyph) is not part of it.
 *
 * @param {string} screen
 */
function lastLineOf(screen) {
  return linesOf(screen).at(-1) ?? '';
}

const NPM_PROCEED_PROMPT = /^Ok to proceed\? \(y\) $/u;
const CONFIRM_PROMPT = /^write these \d+ files into .+\? \[y\/N\] $/u;
const SETUP_PROMPT = /^[A-Z][^?]*\? \(.*\) \[[^\]]*\] $/u;

/**
 * What the journey types at the prompt `npm create` is waiting on, or `null` while it is not
 * waiting: `y` to npm's install question and to create's file list, the answer `answers` gives for
 * a setup question it names by its prompt text (`'What is your brand colour?'`), and an empty line
 * (the recommended answer) to every other setup question and to every select menu, which also asks
 * the file list as a Yes-default menu.
 *
 * @param {string} screen what the terminal printed since the last answer
 * @param {Readonly<Record<string, string>>} answers by the question's prompt text
 */
export function createAnswerFor(screen, answers) {
  // A select menu has its recommendation preselected: Enter takes it (UX-A), unless `answers`
  // names the question, and then the keys that reach that answer come first.
  const menu = drawnMenu(screen);
  if (menu !== null) {
    const prompt = Object.keys(answers).find((text) => menu.title.startsWith(`${text} (`));
    // The journey installs and starts the project itself, so create's offers are declined.
    if (prompt === undefined) {
      return /^(Install dependencies now|Start it now)\?/u.test(menu.title)
        ? keysForMenu(menu, 'no', false)
        : '';
    }
    return keysForMenu(menu, answers[prompt] ?? '', menu.title.includes('space toggles'));
  }
  const line = lastLineOf(screen);
  if (NPM_PROCEED_PROMPT.test(line) || CONFIRM_PROMPT.test(line)) return 'y';
  if (!SETUP_PROMPT.test(line)) return null;
  const prompt = Object.keys(answers).find((text) => line.startsWith(`${text} (`));
  return prompt === undefined ? '' : (answers[prompt] ?? '');
}

/**
 * `text` with every occurrence of `secret` replaced by `<fake key>`. A blank secret leaves the
 * text as it is.
 *
 * @param {string} text @param {string} secret
 */
export function redact(text, secret) {
  return secret === '' ? text : text.split(secret).join('<fake key>');
}

const AGENT_NAME_LINE = /^ {2}name: '([^'\\]+)',$/mu;
const AGENT_IMPORT_LINE =
  /^import \{ (defineAgent(?:, \w+)*) \} from '(@indx-workspace\/sdk\/define)';$/mu;
const AGENT_ENGINE_LINE = /^ {2}engine: '[^'\\]+',$/mu;

/**
 * The `name` of a rendered `agents/<name>.ts` (`name: '<name>',`).
 *
 * @param {string} source
 */
export function agentNameOfSource(source) {
  const match = AGENT_NAME_LINE.exec(source);
  if (match?.[1] === undefined) throw new JourneyFailure('the agent file names no agent');
  return match[1];
}

/**
 * The rendered agent file moved to engine `pi`, which has no MCP client, with one `mcp()` tool:
 * the definition every engine-capability check must refuse with `engine_capability_unsupported`.
 *
 * @param {string} source a rendered `agents/<name>.ts` @param {string} connector
 */
export function mcpAgentSource(source, connector) {
  if (!AGENT_IMPORT_LINE.test(source) || !AGENT_ENGINE_LINE.test(source)) {
    throw new JourneyFailure('the agent file is not the renderer output (import and engine line)');
  }
  return source
    .replace(AGENT_IMPORT_LINE, "import { $1, mcp } from '$2';")
    .replace(AGENT_ENGINE_LINE, `  engine: 'pi',\n  tools: [mcp('${connector}')],`);
}

/**
 * B3b's hand edit of the rendered agent file: it imports `../tools/orders` and lists it, and asks
 * `permissions: { runCommands: true }`, so the run before the ceiling offers `Bash` and the run
 * under it shows the ceiling took it away. The same anchors as {@link mcpAgentSource}.
 *
 * @param {string} source a rendered `agents/<name>.ts` with no tools and no permissions
 */
export function toolAgentSource(source) {
  if (
    !AGENT_IMPORT_LINE.test(source) ||
    !AGENT_ENGINE_LINE.test(source) ||
    /^ {2}(?:tools|permissions):/mu.test(source)
  ) {
    throw new JourneyFailure(
      'the agent file is not the renderer output without tools (import and engine line)',
    );
  }
  return source
    .replace(AGENT_IMPORT_LINE, "$&\n\nimport ordersTool from '../tools/orders';")
    .replace(
      AGENT_ENGINE_LINE,
      '$&\n  tools: [ordersTool],\n  permissions: { runCommands: true },',
    );
}

const SURFACE_COLOUR_LINE = /^(\s*colour:\s*)'#[0-9a-fA-F]{6}'(,?)$/mu;

/**
 * B2's look change: the rendered `surfaces/main.ts` with its theme colour set to `hex`.
 *
 * @param {string} source a rendered `surfaces/main.ts` @param {string} hex `#rrggbb`
 */
export function withSurfaceColour(source, hex) {
  if (!HEX_COLOUR.test(hex)) throw new JourneyFailure(`${hex} is not a #rrggbb colour`);
  if (!SURFACE_COLOUR_LINE.test(source)) {
    throw new JourneyFailure('surfaces/main.ts names no theme colour (colour: #rrggbb)');
  }
  return source.replace(SURFACE_COLOUR_LINE, `$1'${hex}'$2`);
}

/**
 * The orders API saw `GET /orders/<nonce>` with `Authorization: Bearer <token>`: the gateway
 * called the tool with the sealed credential. The token is compared, never printed.
 *
 * @param {readonly { method: string, path: string, authorization: string | null }[]} calls
 * @param {string} nonce @param {string} token
 */
export function assertToolCallSeen(calls, nonce, token) {
  const route = `/orders/${nonce}`;
  const seen = calls.filter((call) => call.method === 'GET' && call.path === route);
  if (seen.length === 0) throw new JourneyFailure(`the orders API never saw GET ${route}`);
  if (!seen.some((call) => call.authorization === `Bearer ${token}`)) {
    throw new JourneyFailure(`the orders API saw GET ${route}, but never with the token`);
  }
}

/**
 * The fake model answered `nonce` with the tool's result: its reply carries `order-data-<nonce>`,
 * which only the orders API's answer holds.
 *
 * @param {readonly { method: string, path: string, reply: string | null }[]} requests
 * @param {string} nonce
 */
export function assertToolAnswer(requests, nonce) {
  const replies = requests.filter(
    (request) =>
      request.method === 'POST' &&
      request.path === '/v1/messages' &&
      request.reply?.includes(`Fake Anthropic reply to ${nonce}`) === true,
  );
  if (replies.length === 0) throw new JourneyFailure(`the fake provider never answered ${nonce}`);
  if (!replies.some((request) => request.reply?.includes(`order-data-${nonce}`) === true)) {
    throw new JourneyFailure(
      `the fake provider answered ${nonce} without the tool's data (order-data-${nonce})`,
    );
  }
}

const ORDERS_TOOL_SUFFIX = '__getOrderByOrderNumber';

/**
 * Whether the Claude CLI offered `toolName` on the agent's turn for `nonce` (the model request
 * that also offered the orders tool), as `offered` says. A tool the run's `RunRequest` denies is
 * not offered, so `Bash` absent under the ceiling, and present before it, is "Bash denied at
 * compose".
 *
 * @param {readonly { nonce: string | null, toolNames: readonly string[] }[]} toolRequests
 * @param {string} nonce @param {string} toolName @param {boolean} offered
 */
export function assertToolOffered(toolRequests, nonce, toolName, offered) {
  const turns = toolRequests.filter(
    (request) =>
      request.nonce === nonce &&
      request.toolNames.some((name) => name.endsWith(ORDERS_TOOL_SUFFIX)),
  );
  if (turns.length === 0) {
    throw new JourneyFailure(`no model request for ${nonce} offered the orders tool`);
  }
  const seen = turns.some((request) => request.toolNames.includes(toolName));
  if (seen && !offered) {
    throw new JourneyFailure(`${toolName} was offered to the model for ${nonce} under the ceiling`);
  }
  if (!seen && offered) {
    throw new JourneyFailure(
      `${toolName} was not offered to the model for ${nonce}, so its denial would prove nothing`,
    );
  }
}

/**
 * `output` holds `<file>: 403 policy_cannot_widen [permissions.runCommands]` (a hint after `; `
 * allowed): the server's dry run refused the agent. A `<file>: local policy_cannot_widen` line is
 * a refusal computed without the server and fails the check.
 *
 * @param {string} output what `aw check` or `aw dev` printed @param {string} file
 */
export function assertServerRefusal(output, file) {
  const lines = output.split('\n').map((line) => line.replace(/\r$/u, '').trim());
  if (lines.some((line) => line.includes(`${file}: local policy_cannot_widen`))) {
    throw new JourneyFailure(`policy_cannot_widen for ${file} was computed without the server`);
  }
  const expected = `${file}: 403 policy_cannot_widen [permissions.runCommands]`;
  const found = lines.some((line) => {
    const at = line.indexOf(expected);
    if (at < 0) return false;
    const rest = line.slice(at + expected.length);
    return rest === '' || rest.startsWith(';');
  });
  if (!found) throw new JourneyFailure(`no "${expected}" line`);
}

/**
 * The id of the agent named `name` in `aw agents list --json`.
 *
 * @param {string} json @param {string} name
 */
export function agentIdOf(json, name) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new JourneyFailure('aw agents list printed no JSON');
  }
  const list = Array.isArray(parsed) ? parsed : [];
  for (const item of list) {
    if (typeof item === 'object' && item !== null && 'name' in item && item.name === name) {
      if ('id' in item && typeof item.id === 'string') return item.id;
    }
  }
  throw new JourneyFailure(`the workspace has no agent named ${name}`);
}

/** The surface path the journey opens and the widget names. */
export function tryPath() {
  return `/p/s/${SURFACE_NAME}/try`;
}

/**
 * Opens the try page as the host page and adds the one widget tag to it, as a customer's page
 * would. The try page is the surface's own chat, so it no longer carries the tag itself; the
 * loader still serves `?environment=local` (the working draft) exactly as it did there.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} baseUrl
 */
export async function openWidgetHost(page, baseUrl) {
  await page.goto(`${baseUrl}${tryPath()}`);
  await page.addScriptTag({
    url: `${baseUrl}/p/s/${SURFACE_NAME}/widget.js?environment=local`,
  });
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

/** The line a widget test prints for the first-token latency: `journey-first-token-ms <n>`. */
const FIRST_TOKEN_LINE = /journey-first-token-ms (\d+)$/u;

/**
 * The first-token latency, in seconds to a tenth, from the one `journey-first-token-ms <n>` line
 * of a widget test's output.
 *
 * @param {string} output
 */
export function firstTokenOf(output) {
  const found = output
    .split('\n')
    .map((line) => FIRST_TOKEN_LINE.exec(line.replace(/\r$/u, '').trim()))
    .filter((match) => match !== null);
  const [match] = found;
  if (match === undefined || found.length !== 1) {
    throw new JourneyFailure(
      `the widget test printed ${String(found.length)} journey-first-token-ms lines, not one`,
    );
  }
  return tenths(Number(match[1]) / 1000);
}

/**
 * `{ id, status }` of the `{ run: { id, status, … } }` body that starting and reading a run answer.
 *
 * @param {unknown} body @param {string} what
 */
export function runOf(body, what) {
  const run = typeof body === 'object' && body !== null && 'run' in body ? body.run : null;
  if (
    typeof run === 'object' &&
    run !== null &&
    'id' in run &&
    typeof run.id === 'string' &&
    'status' in run &&
    typeof run.status === 'string'
  ) {
    return { id: run.id, status: run.status };
  }
  throw new JourneyFailure(`${what} answered no run`);
}

/** @param {unknown} body the `201` of `POST /p/s/<name>/sessions` */
export function sessionTokenOf(body) {
  if (typeof body === 'object' && body !== null && 'token' in body) {
    if (typeof body.token === 'string' && body.token !== '') return body.token;
  }
  throw new JourneyFailure(`POST /p/s/${SURFACE_NAME}/sessions answered no token`);
}

/** The surface chat's messages (`surface-chat.tsx`): the visitor's, then the agent's. */
const CHAT_MESSAGES = 'ol[aria-live="polite"] > li';
const RUN_START_PATH = /^\/api\/agents\/[^/]+\/runs$/u;
const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'];
/** How long a run may take to settle after its first text shows. */
const RUN_SETTLE_MS = 120_000;

/**
 * Asks the open widget `prompt` and checks behaviour, never wording, so the fake and the real model
 * pass the same checks: the visitor's session opens (`201`), the agent's message shows text, the
 * run it started finishes `completed` (read with the session's own token), and the chat shows no
 * failure. Returns the milliseconds from Send to the agent's first text: the first-token latency
 * as the visitor sees it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').FrameLocator} chat the widget's frame, opened
 * @param {string} prompt @param {number} timeoutMs the wait for the first text
 */
export async function askWidget(page, chat, prompt, timeoutMs) {
  await chat.locator('form textarea').fill(prompt);
  /** @param {RegExp} pathname */
  const posted = (pathname) =>
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && pathname.test(new URL(response.url()).pathname),
      { timeout: timeoutMs },
    );
  const opened = posted(new RegExp(`^/p/s/${SURFACE_NAME}/sessions$`, 'u'));
  const started = posted(RUN_START_PATH);
  // A refused session starts no run; its own error is the one reported, not this wait's timeout.
  started.catch(() => undefined);
  const sent = Date.now();
  // The first Send opens the visitor's session (`POST /p/s/<name>/sessions`). A refusal there is
  // the reason no reply can come, so it is named here instead of as a timeout on the reply.
  await chat.locator('form button[type="submit"]').click();
  const session = await opened;
  if (session.status() !== 201) {
    throw new JourneyFailure(
      `POST /p/s/${SURFACE_NAME}/sessions answered ${String(session.status())}: ${await session.text()}`,
    );
  }
  const token = sessionTokenOf(await session.json());
  const start = await started;
  if (!start.ok()) {
    throw new JourneyFailure(
      `the run start answered ${String(start.status())}: ${await start.text()}`,
    );
  }
  const runId = runOf(await start.json(), 'the run start').id;
  await chat
    .locator(CHAT_MESSAGES)
    .nth(1)
    .locator('p')
    .filter({ hasText: /\S/u })
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs });
  const firstTokenMs = Date.now() - sent;
  const runUrl = new URL(`/api/runs/${runId}`, page.url()).href;
  const until = Date.now() + RUN_SETTLE_MS;
  for (;;) {
    const read = await page.request.get(runUrl, { headers: { authorization: `Bearer ${token}` } });
    if (!read.ok())
      throw new JourneyFailure(`GET /api/runs/${runId} answered ${String(read.status())}`);
    const { status } = runOf(await read.json(), `GET /api/runs/${runId}`);
    if (TERMINAL_RUN_STATUSES.includes(status)) {
      if (status !== 'completed')
        throw new JourneyFailure(`run ${runId} finished ${status}, not completed`);
      break;
    }
    if (Date.now() > until) {
      throw new JourneyFailure(
        `run ${runId} is still ${status} ${String(RUN_SETTLE_MS / 1000)} s after its first text`,
      );
    }
    await page.waitForTimeout(500);
  }
  await assertNoChatFailure(chat);
  return firstTokenMs;
}

/**
 * A failed turn as `surface-chat.tsx` shows it: the `role="alert"` after the messages, holding the
 * failure's code and message. Next's route announcer (an empty `role="alert"` live region) and the
 * local driver's banner are not it.
 */
const CHAT_FAILURE = 'ol[aria-live="polite"] ~ [role="alert"]';
/** The local driver's banner (`driver-banner.tsx`): an alert by design, never a turn's failure. */
const DRIVER_NOTICE_TESTID = 'driver-in-force';

/**
 * Throws, with its text, if the chat shows a failed turn. An alert with no text (a live region)
 * or the driver notice is never one.
 *
 * @param {{ locator(selector: string): { all(): Promise<readonly import('./harness.d.mts').ChatAlert[]> } }} chat
 */
export async function assertNoChatFailure(chat) {
  for (const alert of await chat.locator(CHAT_FAILURE).all()) {
    if ((await alert.getAttribute('data-testid')) === DRIVER_NOTICE_TESTID) continue;
    const text = (await alert.innerText()).trim();
    if (text !== '') throw new JourneyFailure(`the chat shows a failure: ${text}`);
  }
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
 * One evidence file with every secret redacted, or `null` when it is binary (a screenshot, a trace
 * archive) and holds a secret, so it cannot be redacted and must not be kept.
 *
 * @param {Buffer} bytes @param {Iterable<string>} secrets
 * @returns {Buffer | null}
 */
export function scrubbedEvidence(bytes, secrets) {
  const text = bytes.toString('utf8');
  const list = [...secrets].filter((secret) => secret !== '');
  if (Buffer.from(text, 'utf8').equals(bytes)) {
    return Buffer.from(
      list.reduce((clean, secret) => redact(clean, secret), text),
      'utf8',
    );
  }
  return list.some((secret) => bytes.includes(secret)) ? null : bytes;
}

function main() {
  const [command, ...dirs] = process.argv.slice(2);
  const secret = process.env['JOURNEY_SECRET'] ?? '';
  if (command === 'snapshot' && dirs.length === 1 && dirs[0] !== undefined) {
    console.log(JSON.stringify(snapshotTree(path.resolve(dirs[0]))));
  } else if (command === 'find' && dirs.length > 0 && secret !== '') {
    const found = dirs.flatMap((dir) =>
      filesContaining(path.resolve(dir), secret).map((file) => `${dir}/${file}`),
    );
    console.log(JSON.stringify(found));
  } else {
    console.error(
      'usage: node harness.mjs snapshot <dir> | JOURNEY_SECRET=… node harness.mjs find <dir>…',
    );
    process.exitCode = 2;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
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

/**
 * The first-hour stopwatch's record as Markdown, for `$GITHUB_STEP_SUMMARY`: a timed step shows
 * its seconds, and its target when it has one; a pending step names the issue it waits for.
 *
 * @param {readonly { id: string, name: string, seconds?: number, targetSeconds?: number, pending?: string }[]} steps
 */
export function firstHourSummaryMarkdown(steps) {
  return [
    '### First-hour stopwatch (B0)',
    '',
    '| Step | Seconds | Target | State |',
    '| --- | ---: | ---: | --- |',
    ...steps.map((step) => {
      const target = step.targetSeconds === undefined ? '' : String(step.targetSeconds);
      if (step.seconds === undefined) {
        return `| ${step.id} ${step.name} | | ${target} | pending ${step.pending ?? ''} |`;
      }
      const over = step.targetSeconds !== undefined && step.seconds > step.targetSeconds;
      return `| ${step.id} ${step.name} | ${step.seconds.toFixed(1)} | ${target} | ${over ? 'over target' : 'timed'} |`;
    }),
    '',
  ].join('\n');
}
