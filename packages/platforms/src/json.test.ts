import { describe, expect, it } from 'vitest';
import { prettyJson } from './json.js';

describe('prettyJson', () => {
  it('collapses a string array onto one line', () => {
    expect(prettyJson({ a: ['x', 'y'] })).toBe('{\n  "a": ["x", "y"]\n}\n');
  });

  it('collapses an array whose item holds an escaped quote or comma', () => {
    expect(prettyJson({ a: ['say "hi", ok', 'b'] })).toBe(
      '{\n  "a": ["say \\"hi\\", ok", "b"]\n}\n',
    );
  });

  it('keeps object and mixed arrays multi-line', () => {
    expect(prettyJson({ a: [{ b: 1 }] })).toBe('{\n  "a": [\n    {\n      "b": 1\n    }\n  ]\n}\n');
    expect(prettyJson({ a: ['x', 1] })).toBe('{\n  "a": [\n    "x",\n    1\n  ]\n}\n');
  });

  it('keeps an empty array as []', () => {
    expect(prettyJson({ a: [] })).toBe('{\n  "a": []\n}\n');
  });
});
