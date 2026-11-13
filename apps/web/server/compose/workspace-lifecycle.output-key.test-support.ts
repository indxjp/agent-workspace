import { describe, expect, it } from 'vitest';
import { runOutputKey } from './workspace-lifecycle';

describe('runOutputKey', () => {
  it.each([
    ['run-1', 'report.md', undefined, 'runs/run-1/outputs/report.md'],
    ['run-1', 'a/b/c.txt', undefined, 'runs/run-1/outputs/a/b/c.txt'],
    ['run-1', 'ws/s1/outputs/a.md', 'ws/s1/outputs', 'runs/run-1/outputs/a.md'],
    ['run-1', 'ws/s1/outputs/a.md', 'ws/s1/outputs/', 'runs/run-1/outputs/a.md'],
  ])('maps %s %s (base %s) to %s', (runId, path, base, expected) => {
    expect(runOutputKey(runId, path, base)).toBe(expected);
  });

  it.each([
    ['outside the base', 'ws/s2/outputs/a.md', 'ws/s1/outputs'],
    ['a sibling that only shares the base as a prefix', 'ws/s1/outputs2/a.md', 'ws/s1/outputs'],
    ['the base itself', 'ws/s1/outputs', 'ws/s1/outputs'],
    ['an empty remainder', 'ws/s1/outputs/', 'ws/s1/outputs'],
  ])('refuses %s', (_name, path, base) => {
    expect(() => runOutputKey('run-1', path, base)).toThrow();
  });
});
