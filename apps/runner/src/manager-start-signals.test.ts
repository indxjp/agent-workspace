import { expect, it, vi } from 'vitest';
import { createShutdownSignalHandler } from './manager-start.js';

function harness(shutdown: () => Promise<'clean' | 'sandboxes-left'>) {
  const written: string[] = [];
  const exits: number[] = [];
  const handler = createShutdownSignalHandler(
    shutdown,
    (code) => {
      exits.push(code);
    },
    { write: (chunk: string | Uint8Array) => written.push(String(chunk)) > 0 },
  );
  return { handler, written, exits };
}

it('createShutdownSignalHandler > exits 2 and names the failure when the shutdown rejects', async () => {
  const { handler, written, exits } = harness(() => Promise.reject(new Error('gate exploded')));
  handler('SIGTERM');
  await vi.waitFor(() => {
    expect(exits).toEqual([2]);
  });
  expect(written.join('')).toContain('runner manager: shutdown failed: gate exploded');
});

it.each([
  ['clean', 0],
  ['sandboxes-left', 2],
] as const)('createShutdownSignalHandler > exits with the %s outcome', async (outcome, code) => {
  const { handler, exits } = harness(() => Promise.resolve(outcome));
  handler('SIGINT');
  await vi.waitFor(() => {
    expect(exits).toEqual([code]);
  });
});

it('createShutdownSignalHandler > leaves at once on a second signal without running the shutdown again', () => {
  const shutdown = vi.fn(() => new Promise<'clean'>(() => undefined));
  const { handler, exits } = harness(shutdown);
  handler('SIGTERM');
  handler('SIGTERM');
  expect(exits).toEqual([2]);
  expect(shutdown).toHaveBeenCalledTimes(1);
});
