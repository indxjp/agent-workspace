import { describe, expect, it } from 'vitest';

import { deepEqual, diff } from './diff.js';

describe('deepEqual', () => {
  it('ignores the order of object keys but not of array items', () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });

  it('tells apart a missing key, null, an array and an object', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual({ a: [1] }, { a: [1, 2] })).toBe(false);
  });
});

describe('diff', () => {
  it('gives no change for equal values', () => {
    expect(diff({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([]);
  });

  it('names each added, removed and changed path, in key order', () => {
    expect(
      diff(
        { agent: { name: 'a', model: 'x' }, tools: ['one', 'two'] },
        { agent: { name: 'b', limits: {} }, tools: ['one'] },
        'definition',
      ),
    ).toEqual([
      { op: '+', path: 'definition.agent.limits' },
      { op: '-', path: 'definition.agent.model' },
      { op: '~', path: 'definition.agent.name' },
      { op: '-', path: 'definition.tools.1' },
    ]);
  });

  it('reports a whole value added or replaced at the root', () => {
    expect(diff(undefined, { a: 1 })).toEqual([{ op: '+', path: '(root)' }]);
    expect(diff({ a: 1 }, undefined)).toEqual([{ op: '-', path: '(root)' }]);
    expect(diff([1], { a: 1 })).toEqual([{ op: '~', path: '(root)' }]);
  });
});
