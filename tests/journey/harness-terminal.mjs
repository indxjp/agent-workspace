import { URL } from 'node:url';
import { JourneyFailure } from './harness-failure.mjs';

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

/** The ready screen's app row (issue #1510): `app       http://127.0.0.1:3100`, the app's origin. */
const APP_LINE = /^app\s+(https?:\/\/[^/\s]+)\/?$/u;

/** The ready screen's console row: `console   http://127.0.0.1:3000`, the runtime's origin. */
const CONSOLE_LINE = /^console\s+(https?:\/\/[^/\s]+)\/?$/u;

/**
 * One line `aw dev` printed, as the journey reads it: the ready screen's `try <url>` and
 * `embed <script …>` rows, the older `ready <url>`, `try: <url>` and `widget: <script …>` lines,
 * `signed in as <email> (workspace <slug>)`, C6's
 * `model connection: default (anthropic)`, the sync summary `synced: …`, the console rows
 * `console <url>` and `sign in as <email>`, and the `app <url>` row of a project with an app.
 * Any other line is `null`.
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
  const app = APP_LINE.exec(text);
  if (app?.[1] !== undefined) return { kind: /** @type {const} */ ('app'), origin: app[1] };
  const consoleRow = CONSOLE_LINE.exec(text);
  if (consoleRow?.[1] !== undefined)
    return { kind: /** @type {const} */ ('console'), origin: consoleRow[1] };
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
