import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters, styleText } from 'node:util';

/** One entry of a menu: the answer it stands for and, optionally, a one-line summary. */
export interface MenuOption {
  readonly value: string;
  readonly hint?: string;
}

/** One question as a menu. `max` set makes it a multi-select of up to `max`; `initial` is preselected. */
export interface MenuSpec {
  readonly title: string;
  readonly options: readonly MenuOption[];
  readonly max?: number;
  /** The recommended answer(s): preselected, marked, and where the cursor starts. */
  readonly initial: readonly string[];
}

/** Shows `spec` and resolves with the chosen value(s); rejects with {@link MenuCancelledError}. */
export type Choose = (spec: MenuSpec) => Promise<readonly string[]>;

/** The person pressed Ctrl-C, Ctrl-D or Escape at a menu. */
export class MenuCancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'MenuCancelledError';
  }
}

export type MenuAction = 'up' | 'down' | 'toggle' | 'accept' | 'cancel';

export interface MenuState {
  readonly cursor: number;
  readonly picked: readonly string[];
}

/** `none` is the one value a multi-select takes alone, as `SetupAnswersSchema` requires. */
const EXCLUSIVE = 'none';

export function initialMenuState(spec: MenuSpec): MenuState {
  const first = spec.options.findIndex((option) => spec.initial.includes(option.value));
  return { cursor: Math.max(first, 0), picked: spec.initial };
}

/** The pure key-to-state step: moves the cursor (wrapping) and toggles a multi's picks. */
export function reduceMenu(state: MenuState, action: MenuAction, spec: MenuSpec): MenuState {
  const count = spec.options.length;
  if (action === 'up') return { ...state, cursor: (state.cursor + count - 1) % count };
  if (action === 'down') return { ...state, cursor: (state.cursor + 1) % count };
  if (action !== 'toggle' || spec.max === undefined) return state;
  const value = spec.options[state.cursor]?.value;
  if (value === undefined) return state;
  if (state.picked.includes(value)) {
    return { ...state, picked: state.picked.filter((picked) => picked !== value) };
  }
  if (value === EXCLUSIVE) return { ...state, picked: [value] };
  const others = state.picked.filter((picked) => picked !== EXCLUSIVE);
  return others.length >= spec.max ? state : { ...state, picked: [...others, value] };
}

/** What Enter answers: the option under the cursor, or a multi's picks in menu order. */
export function menuAnswer(state: MenuState, spec: MenuSpec): readonly string[] {
  if (spec.max === undefined) return [spec.options[state.cursor]?.value ?? ''];
  return spec.options.map((option) => option.value).filter((v) => state.picked.includes(v));
}

/** A keypress as the action it means; `undefined` for a key the menu ignores. */
export function keyAction(
  text: string | undefined,
  key: { readonly name?: string; readonly ctrl?: boolean } | undefined,
): MenuAction | undefined {
  if (key?.ctrl === true && (key.name === 'c' || key.name === 'd')) return 'cancel';
  switch (key?.name) {
    case 'up':
    case 'k':
      return 'up';
    case 'down':
    case 'j':
      return 'down';
    case 'space':
      return 'toggle';
    case 'return':
    case 'enter':
      return 'accept';
    case 'escape':
      return 'cancel';
    default:
      return text === ' ' ? 'toggle' : undefined;
  }
}

const RECOMMENDED = ' (recommended)';

/** `text` cut to `max` characters, ending in an ellipsis when it was cut. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** East Asian wide and fullwidth ranges: Hangul Jamo, CJK and kana, Hangul, fullwidth forms. */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦\u{20000}-\u{3fffd}]/u;

/** Terminal columns `text` takes: a wide character counts 2, any other 1. */
function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += WIDE.test(character) ? 2 : 1;
  return width;
}

/** The rows `lines` take on a terminal `columns` wide: a longer line wraps onto more rows. */
export function physicalRows(lines: readonly string[], columns: number): number {
  return lines.reduce(
    (rows, line) =>
      rows + Math.max(1, Math.ceil(displayWidth(stripVTControlCharacters(line)) / columns)),
    0,
  );
}

type Paint = (format: 'bold' | 'cyan' | 'dim' | 'green', text: string) => string;

/** The menu's lines: pure, so the exact text is tested. */
export function renderMenu(
  spec: MenuSpec,
  state: MenuState,
  paint: Paint,
  columns = Infinity,
): readonly string[] {
  const multi = spec.max !== undefined;
  const width = Math.max(...spec.options.map((option) => option.value.length));
  const help = multi
    ? `up/down move, space toggles (up to ${String(spec.max)}), enter accepts`
    : 'up/down move, enter accepts';
  const lines = [`${paint('cyan', '?')} ${paint('bold', spec.title)} ${paint('dim', `(${help})`)}`];
  spec.options.forEach((option, index) => {
    const here = index === state.cursor;
    let mark = here ? '(*)' : '( )';
    if (multi) mark = state.picked.includes(option.value) ? '[x]' : '[ ]';
    const tag = spec.initial.includes(option.value) ? RECOMMENDED : '';
    // Padded before painting, so the hints line up whether or not a row carries the tag.
    const recommended = paint(
      'green',
      option.hint === undefined ? tag : tag.padEnd(RECOMMENDED.length),
    );
    const label = `${mark} ${option.value.padEnd(width)}`;
    // A summary is cut to the terminal's width, so a row never wraps and the redraw stays exact.
    const room = columns - 1 - (2 + label.length + RECOMMENDED.length + 2);
    const hint =
      option.hint === undefined || room < 4 ? '' : paint('dim', `  ${truncate(option.hint, room)}`);
    lines.push(
      `${here ? paint('cyan', '>') : ' '} ${here ? paint('cyan', label) : label}${recommended}${hint}`,
    );
  });
  // A cut summary is shown whole for the option under the cursor, on a line of its own, so no
  // summary is unreadable on a narrow terminal (BH061-053); `physicalRows` counts its wrap.
  const current = spec.options[state.cursor]?.hint;
  const room = columns - 1 - (2 + 4 + width + RECOMMENDED.length + 2);
  if (current !== undefined && current.length > room) lines.push(`  ${paint('dim', current)}`);
  return lines;
}

type KeypressListener = (
  text: string | undefined,
  key: { readonly name?: string; readonly ctrl?: boolean },
) => void;

interface MenuInput {
  setRawMode?(raw: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: string, listener: KeypressListener): unknown;
  off(event: string, listener: KeypressListener): unknown;
}

interface MenuOutput {
  /** The terminal's width, when it has one (`process.stdout.columns`). */
  readonly columns?: number | undefined;
  write(text: string): unknown;
}

/**
 * Runs `spec` as a raw-mode menu on `input`/`output`, restoring the terminal however it ends, and
 * leaves one line behind: the question and the answer. `plain` drops colour (`NO_COLOR`); an aborted `signal` (SIGTERM) cancels the menu like Ctrl-C.
 *
 * @throws {MenuCancelledError} on Ctrl-C, Ctrl-D or Escape.
 */
export function chooseFromMenu(
  spec: MenuSpec,
  input: MenuInput,
  output: MenuOutput,
  plain = false,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  if (signal?.aborted === true) return Promise.reject(new MenuCancelledError());
  const paint: Paint = plain
    ? (_format, text) => text
    : (format, text) => styleText(format, text, { validateStream: false });
  emitKeypressEvents(input as never);
  input.setRawMode?.(true);
  input.resume();
  let state = initialMenuState(spec);
  let drawn = 0;
  const draw = (): void => {
    const lines = renderMenu(spec, state, paint, output.columns);
    const erase = drawn > 0 ? `\x1b[${String(drawn)}A\x1b[J` : '';
    output.write(`${erase}${lines.join('\n')}\n`);
    drawn = physicalRows(lines, output.columns ?? Infinity);
  };
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      finish();
      reject(new MenuCancelledError());
    };
    const finish = (): void => {
      signal?.removeEventListener('abort', onAbort);
      input.off('keypress', onKey);
      input.setRawMode?.(false);
      input.pause();
      output.write(`\x1b[${String(drawn)}A\x1b[J`);
    };
    const onKey: KeypressListener = (text, key) => {
      const action = keyAction(text, key);
      if (action === undefined) return;
      if (action === 'cancel') {
        finish();
        reject(new MenuCancelledError());
      } else if (action === 'accept') {
        const answer = menuAnswer(state, spec);
        finish();
        const shown = answer.join(', ') || '(nothing)';
        output.write(`${paint('green', 'v')} ${spec.title} ${paint('cyan', shown)}\n`);
        resolve(answer);
      } else {
        state = reduceMenu(state, action, spec);
        draw();
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    input.on('keypress', onKey);
    draw();
  });
}

/** A Yes/No menu defaulting to Yes; `false` for No. */
export async function confirmMenu(choose: Choose, title: string): Promise<boolean> {
  const [answer] = await choose({
    title,
    options: [{ value: 'yes' }, { value: 'no' }],
    initial: ['yes'],
  });
  return answer === 'yes';
}
