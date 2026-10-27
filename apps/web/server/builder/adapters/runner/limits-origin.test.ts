import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const WEB = path.resolve(import.meta.dirname, '../../../..');
const TRIAL_ADAPTER = path.join('server', 'builder', 'adapters', 'runner', 'production.ts');
const EVALUATION_HANDLER = path.join('server', 'evaluations', 'handlers.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** The text of every `startRunOnSession(...)` call in `source`, by balanced parentheses. */
function startCalls(source: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(/startRunOnSession\(/g)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (depth > 0 && end < source.length) {
      const char = source[end];
      depth += char === '(' ? 1 : char === ')' ? -1 : 0;
      end += 1;
    }
    calls.push(source.slice(match.index, end));
  }
  return calls;
}

// The real guard is the strict-body test in runs/api.test.ts: `parseStartRunBody` rejects a `limits`
// key, so no request can carry one. This test only scans the text of the `startRunOnSession(...)`
// calls, to name the callers that pass `limits`; it cannot see a call made any other way.
describe('the run-limits override has one origin', () => {
  it('is passed to startRunOnSession by the trial adapter and the evaluation handler, and by no route', () => {
    const withLimits = ['server', 'app']
      .flatMap((dir) => sourceFiles(path.join(WEB, dir)))
      .filter((file) => !file.endsWith(path.join('runs', 'service.ts')))
      .filter((file) => startCalls(readFileSync(file, 'utf8')).some((c) => /\blimits\b/.test(c)))
      .map((file) => path.relative(WEB, file));
    expect(withLimits).toEqual([TRIAL_ADAPTER, EVALUATION_HANDLER]);
  });
});
