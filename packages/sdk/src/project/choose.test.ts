import { describe, expect, it } from 'vitest';

import {
  chooseFromMenu,
  confirmMenu,
  initialMenuState,
  keyAction,
  MenuCancelledError,
  menuAnswer,
  physicalRows,
  reduceMenu,
  renderMenu,
  type MenuSpec,
} from './choose.js';

const single: MenuSpec = {
  title: 'Pick one',
  options: [{ value: 'a', hint: 'first' }, { value: 'b' }, { value: 'c' }],
  initial: ['b'],
};
const multi: MenuSpec = {
  title: 'Pick some',
  options: [{ value: 'x' }, { value: 'y' }, { value: 'z' }, { value: 'none' }],
  max: 2,
  initial: ['none'],
};
const plain = (_format: string, text: string): string => text;

describe('reduceMenu', () => {
  it('starts on the recommended option and wraps the cursor', () => {
    let state = initialMenuState(single);
    expect(state.cursor).toBe(1);
    state = reduceMenu(reduceMenu(state, 'down', single), 'down', single);
    expect(state.cursor).toBe(0);
    expect(reduceMenu(state, 'up', single).cursor).toBe(2);
  });

  it('answers the option under the cursor for a single choice, and ignores toggle', () => {
    const state = reduceMenu(initialMenuState(single), 'toggle', single);
    expect(menuAnswer(state, single)).toStrictEqual(['b']);
  });

  it('toggles a multi, keeps none alone and honours max', () => {
    let state = initialMenuState(multi);
    expect(state.cursor).toBe(3);
    const at = (cursor: number) => ({ ...state, cursor });
    state = reduceMenu(at(0), 'toggle', multi);
    expect(state.picked).toStrictEqual(['x']);
    state = reduceMenu(at(1), 'toggle', multi);
    state = reduceMenu(at(2), 'toggle', multi);
    expect(menuAnswer(state, multi)).toStrictEqual(['x', 'y']);
    state = reduceMenu(at(3), 'toggle', multi);
    expect(menuAnswer(state, multi)).toStrictEqual(['none']);
    state = reduceMenu(at(0), 'toggle', multi);
    expect(menuAnswer(state, multi)).toStrictEqual(['x']);
    state = reduceMenu(at(0), 'toggle', multi);
    expect(menuAnswer(state, multi)).toStrictEqual([]);
  });
});

describe('keyAction', () => {
  it('maps arrows, k/j, space, enter and the cancelling keys', () => {
    expect(keyAction(undefined, { name: 'up' })).toBe('up');
    expect(keyAction('k', { name: 'k' })).toBe('up');
    expect(keyAction('j', { name: 'j' })).toBe('down');
    expect(keyAction(' ', { name: 'space' })).toBe('toggle');
    expect(keyAction('\r', { name: 'return' })).toBe('accept');
    expect(keyAction('\x03', { name: 'c', ctrl: true })).toBe('cancel');
    expect(keyAction('\x1b', { name: 'escape' })).toBe('cancel');
    expect(keyAction('q', { name: 'q' })).toBeUndefined();
  });
});

describe('renderMenu', () => {
  it('marks the cursor, the recommendation and shows hints, aligned', () => {
    expect(renderMenu(single, initialMenuState(single), plain)).toStrictEqual([
      '? Pick one (up/down move, enter accepts)',
      '  ( ) a                first',
      '> (*) b (recommended)',
      '  ( ) c',
    ]);
  });

  it('shows checkboxes for a multi', () => {
    const lines = renderMenu(multi, initialMenuState(multi), plain);
    expect(lines[0]).toContain('space toggles (up to 2)');
    expect(lines[4]).toBe('> [x] none (recommended)');
  });
});

type Listener = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => void;

class FakeInput {
  raw: boolean[] = [];
  listeners: Listener[] = [];
  setRawMode(raw: boolean): void {
    this.raw.push(raw);
  }
  resume(): void {}
  pause(): void {}
  listenerCount(): number {
    return this.listeners.length;
  }
  on(event: string, listener: Listener): void {
    if (event === 'keypress') this.listeners.push(listener);
  }
  off(_event: string, listener: Listener): void {
    this.listeners = this.listeners.filter((each) => each !== listener);
  }
  press(name: string, ctrl = false): void {
    for (const listener of this.listeners) listener(undefined, { name, ctrl });
  }
}

describe('chooseFromMenu', () => {
  it('resolves on enter, restores the terminal and leaves one answer line', async () => {
    const input = new FakeInput();
    let out = '';
    const done = chooseFromMenu(single, input, { write: (t) => (out += t) }, true);
    input.press('down');
    input.press('return');
    await expect(done).resolves.toStrictEqual(['c']);
    expect(input.raw).toStrictEqual([true, false]);
    expect(input.listeners.length).toBe(0);
    expect(out.endsWith('v Pick one c\n')).toBe(true);
  });

  it('cuts summaries to a narrow terminal and erases by physical rows, not logical lines', async () => {
    const narrow: MenuSpec = {
      title: 'Pick a thing from this fairly long list of things',
      options: [
        { value: 'alpha', hint: 'a summary far longer than the terminal is wide' },
        { value: 'beta' },
      ],
      initial: ['alpha'],
    };
    const columns = 40;
    const lines = renderMenu(narrow, initialMenuState(narrow), plain, columns);
    expect(lines[1]?.length).toBeLessThan(columns);
    expect(lines[1]).toContain('…');
    // The title is longer than the terminal, so it wraps onto more than one row.
    const rows = physicalRows(lines, columns);
    expect(rows).toBeGreaterThan(lines.length);

    const input = new FakeInput();
    let out = '';
    const done = chooseFromMenu(narrow, input, { columns, write: (t) => (out += t) }, true);
    input.press('down');
    input.press('return');
    await done;
    const esc = String.fromCharCode(27);
    // The redraw climbs the first drawing's rows, and the final erase the second drawing's, whose
    // cursor is on `beta` and so has no whole summary below it.
    const after = renderMenu(narrow, { cursor: 1, picked: ['alpha'] }, plain, columns);
    const rowsAfter = physicalRows(after, columns);
    expect(rowsAfter).toBeLessThan(rows);
    expect(out.split(`${esc}[${String(rows)}A${esc}[J`).length - 1).toBe(1);
    expect(out.split(`${esc}[${String(rowsAfter)}A${esc}[J`).length - 1).toBe(1);
    expect(out).not.toContain(`${esc}[${String(lines.length)}A`);
  });

  it('shows the cut summary of the option under the cursor whole, below the menu (BH061-053)', () => {
    const hint = 'a summary far longer than the terminal is wide';
    const spec: MenuSpec = {
      title: 'Pick',
      options: [
        { value: 'alpha', hint },
        { value: 'beta', hint: 'short' },
      ],
      initial: ['alpha'],
    };
    expect(renderMenu(spec, initialMenuState(spec), plain, 40).at(-1)).toBe(`  ${hint}`);
    expect(renderMenu(spec, { cursor: 1, picked: ['alpha'] }, plain, 40)).toHaveLength(3);
    expect(renderMenu(spec, initialMenuState(spec), plain)).toHaveLength(3);
  });

  it('counts a plain line as one row and ignores colour codes when wrapping', () => {
    const esc = String.fromCharCode(27);
    expect(physicalRows(['abc', ''], 80)).toBe(2);
    expect(physicalRows([`${esc}[2m${'x'.repeat(10)}${esc}[22m`], 10)).toBe(1);
    expect(physicalRows(['x'.repeat(11)], 10)).toBe(2);
  });

  it('counts a wide character as two columns, so a Japanese path wraps when it should', () => {
    expect(physicalRows(['日本語日本'], 10)).toBe(1);
    expect(physicalRows(['日本語日本語'], 10)).toBe(2);
    expect(physicalRows(['C:\\Users\\日本太郎\\my-agent'], 20)).toBe(2);
  });

  it('cancels on an aborted signal, restores the terminal and detaches', async () => {
    const input = new FakeInput();
    const controller = new AbortController();
    const done = chooseFromMenu(single, input, { write: () => undefined }, true, controller.signal);
    controller.abort();
    await expect(done).rejects.toBeInstanceOf(MenuCancelledError);
    expect(input.raw).toStrictEqual([true, false]);
    expect(input.listeners.length).toBe(0);

    const already = new FakeInput();
    await expect(
      chooseFromMenu(single, already, { write: () => undefined }, true, controller.signal),
    ).rejects.toBeInstanceOf(MenuCancelledError);
    expect(already.raw).toStrictEqual([]);
  });

  it('says (nothing) when a multi is accepted empty, never none', async () => {
    const input = new FakeInput();
    let out = '';
    const done = chooseFromMenu(multi, input, { write: (t) => (out += t) }, true);
    input.press('space'); // untoggles the preselected none
    input.press('return');
    await expect(done).resolves.toStrictEqual([]);
    expect(out.endsWith('v Pick some (nothing)\n')).toBe(true);
  });

  it('rejects on Ctrl-C and still restores the terminal', async () => {
    const input = new FakeInput();
    const done = chooseFromMenu(single, input, { write: () => undefined }, true);
    input.press('c', true);
    await expect(done).rejects.toBeInstanceOf(MenuCancelledError);
    expect(input.raw).toStrictEqual([true, false]);
    expect(input.listeners.length).toBe(0);
  });
});

describe('confirmMenu', () => {
  it('defaults to yes and reads no', async () => {
    const seen: string[][] = [];
    const ask = (answer: string) => (spec: MenuSpec) => {
      seen.push([...spec.initial]);
      return Promise.resolve([answer]);
    };
    await expect(confirmMenu(ask('yes'), 'Write?')).resolves.toBe(true);
    await expect(confirmMenu(ask('no'), 'Write?')).resolves.toBe(false);
    expect(seen[0]).toStrictEqual(['yes']);
  });
});
