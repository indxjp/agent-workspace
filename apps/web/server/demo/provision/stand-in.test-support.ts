/** Talk to a demo stand-in the way an engine does: its command, one JSON-RPC message per line. */
import { spawn } from 'node:child_process';

export type StandInAnswer = Record<string, unknown>;

/** Send `requests` to the stand-in `command`, one per line, and read one answer per request with an id. */
export async function converse(
  command: { readonly args: readonly string[] },
  requests: readonly unknown[],
): Promise<readonly StandInAnswer[]> {
  // Run with no secret and no proxy in its environment, as in a sandbox.
  const child = spawn(process.execPath, [...command.args], {
    stdio: 'pipe',
    env: { NODE_ENV: 'test' },
  });
  const wanted = requests.filter(
    (request) => (request as { id?: unknown }).id !== undefined,
  ).length;
  const lines: string[] = [];
  let buffered = '';
  const done = new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';
      lines.push(...parts.filter((part) => part !== ''));
      if (lines.length >= wanted) resolve();
    });
    child.on('error', reject);
  });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  await done;
  child.kill();
  return lines.map((line) => JSON.parse(line) as StandInAnswer);
}

/** A `tools/call` request. */
export const toolCall = (id: number, name: string, args?: unknown): unknown => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, ...(args === undefined ? {} : { arguments: args }) },
});

/** The `result` of one answer. */
export const resultOf = (answer: StandInAnswer | undefined): Record<string, unknown> =>
  answer?.['result'] as Record<string, unknown>;
