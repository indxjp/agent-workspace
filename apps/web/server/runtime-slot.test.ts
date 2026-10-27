import { afterEach, describe, expect, it } from 'vitest';
import { defineSlot } from './runtime-slot';

const KEY = '__agentWorkspaceSlotTestA__';
const OTHER_KEY = '__agentWorkspaceSlotTestB__';

describe('defineSlot', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, KEY);
    Reflect.deleteProperty(globalThis, OTHER_KEY);
  });

  it('is null before anything is set', () => {
    expect(defineSlot<object>(KEY).current()).toBeNull();
  });

  it('returns the very value that was set', () => {
    const slot = defineSlot<object>(KEY);
    const value = {};
    slot.set(value);
    expect(slot.current()).toBe(value);
  });

  it('clear() empties the slot and removes the globalThis property', () => {
    const slot = defineSlot<object>(KEY);
    slot.set({});
    slot.clear();
    expect(slot.current()).toBeNull();
    expect(Reflect.has(globalThis, KEY)).toBe(false);
  });

  it('shares state between two slots with the same key (two module graphs)', () => {
    const value = {};
    defineSlot<object>(KEY).set(value);
    expect(defineSlot<object>(KEY).current()).toBe(value);
  });

  it('getOrCreate() installs init() once and returns the same instance afterwards', () => {
    const slot = defineSlot<Map<string, number>>(KEY);
    let calls = 0;
    const init = (): Map<string, number> => {
      calls += 1;
      return new Map();
    };
    const first = slot.getOrCreate(init);
    expect(slot.getOrCreate(init)).toBe(first);
    expect(slot.current()).toBe(first);
    expect(calls).toBe(1);
  });

  it('getOrCreate() returns a value that was already set without calling init', () => {
    const slot = defineSlot<object>(KEY);
    const value = {};
    slot.set(value);
    expect(
      slot.getOrCreate(() => {
        throw new Error('init must not run');
      }),
    ).toBe(value);
  });

  it('getOrCreate() shares the created value between two slots with the same key', () => {
    const created = defineSlot<object>(KEY).getOrCreate(() => ({}));
    expect(defineSlot<object>(KEY).getOrCreate(() => ({}))).toBe(created);
  });

  it('keeps different keys apart', () => {
    defineSlot<object>(KEY).set({});
    expect(defineSlot<object>(OTHER_KEY).current()).toBeNull();
  });
});
