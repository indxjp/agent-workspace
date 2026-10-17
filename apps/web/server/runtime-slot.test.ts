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

  it('keeps different keys apart', () => {
    defineSlot<object>(KEY).set({});
    expect(defineSlot<object>(OTHER_KEY).current()).toBeNull();
  });
});
