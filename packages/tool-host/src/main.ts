import process from 'node:process';

import { INTAKE_KEY_MIN_LENGTH, INTAKE_KEY_VARIABLE, runIntakeSandbox } from './intake.js';
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
  const options = {
    directory: process.env['TOOL_HOST_DIR'] ?? DEFAULT_DIRECTORY,
    host: process.env['HOST'] ?? '0.0.0.0',
    port,
    stderr: (text: string) => process.stderr.write(text),
    signal: stop.signal,
  };
  const intakeKey = process.env[INTAKE_KEY_VARIABLE];
  if (intakeKey !== undefined && intakeKey.length < INTAKE_KEY_MIN_LENGTH) {
    throw new Error(
      `${INTAKE_KEY_VARIABLE} must be at least ${String(INTAKE_KEY_MIN_LENGTH)} characters`,
    );
  }
  const host =
    intakeKey === undefined
      ? await runSandbox(options)
      : await runIntakeSandbox({ ...options, intakeKey });
  await host.closed;
  // Ending without being asked to means the host died: let the container stop so the runner sees it.
  process.exit(stop.signal.aborted ? 0 : 1);
} catch (error) {
  if (stop.signal.aborted) process.exit(0);
  process.stderr.write(`tool-host: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
