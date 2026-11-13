import { describe, expect, it } from 'vitest';

import { planAppend } from './streams.js';

describe('planAppend', () => {
  it('updates a key the stream already holds in place, and inserts nothing for it', () => {
    const plan = planAppend([{ entryKey: 'a', entry: { v: 2 } }], new Map([['a', 3]]), 8);
    expect(plan).toEqual({ updates: [{ sequence: 3, entry: { v: 2 } }], inserts: [] });
  });

  it('numbers fresh entries from the first free sequence, one row per repeated key', () => {
    const plan = planAppend(
      [{ entryKey: 'b', entry: { v: 1 } }, { entry: { v: 2 } }, { entryKey: 'b', entry: { v: 3 } }],
      new Map(),
      5,
    );
    expect(plan).toEqual({
      updates: [],
      inserts: [
        { sequence: 5, entryKey: 'b', entry: { v: 3 } },
        { sequence: 6, entryKey: null, entry: { v: 2 } },
      ],
    });
  });

  it('updates placed keys in order and numbers only the fresh ones in a mixed batch', () => {
    const plan = planAppend(
      [
        { entryKey: 'a', entry: { v: 1 } },
        { entryKey: 'b', entry: { v: 2 } },
        { entryKey: 'a', entry: { v: 3 } },
      ],
      new Map([['a', 3]]),
      8,
    );
    expect(plan).toEqual({
      updates: [
        { sequence: 3, entry: { v: 1 } },
        { sequence: 3, entry: { v: 3 } },
      ],
      inserts: [{ sequence: 8, entryKey: 'b', entry: { v: 2 } }],
    });
  });

  it('plans nothing for an empty batch', () => {
    expect(planAppend([], new Map(), 1)).toEqual({ updates: [], inserts: [] });
  });
});
