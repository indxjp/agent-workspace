import process from 'node:process';

import { runSandbox } from './sandbox.js';

const DEFAULT_DIRECTORY = '/workspace';
const DEFAULT_PORT = 8788;

const stop = new AbortController();
process.on('SIGTERM', () => {
  stop.abort();
});

try {
  const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is not a port');
  const host = await runSandbox({
    directory: process.env['TOOL_HOST_DIR'] ?? DEFAULT_DIRECTORY,
    host: process.env['HOST'] ?? '0.0.0.0',
    port,
    stderr: (text) => process.stderr.write(text),
    signal: stop.signal,
  });
  await host.closed;
  // Ending without being asked to means the host died: let the container stop so the runner sees it.
  process.exit(stop.signal.aborted ? 0 : 1);
} catch (error) {
  if (stop.signal.aborted) process.exit(0);
  process.stderr.write(`tool-host: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
