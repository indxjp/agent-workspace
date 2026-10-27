import process from 'node:process';
import { vi } from 'vitest';

/**
 * Test support: records what the web logger actually writes (the redacted JSON line), not what its
 * callers passed. An `Error` handed to a spy serialises as `{}`, so only the written line can prove
 * that a secret did not reach the log. `vi.restoreAllMocks()` also restores it.
 */
export function captureLog(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const record = (chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  };
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation(record),
    vi.spyOn(process.stderr, 'write').mockImplementation(record),
  ];
  return {
    text: () => lines.join(''),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
