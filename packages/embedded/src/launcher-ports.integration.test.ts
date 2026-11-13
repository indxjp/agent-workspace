import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DATABASE_PORT } from './launcher-ports.test-support.js';

import { afterAll, beforeAll, expect, it } from 'vitest';
import { PORT_TAKEN_TIMEOUT_MS, startMessage } from './launcher-api.test-support.js';
import { freePorts, holdPort } from './launcher-ports.test-support.js';
import { ForkedRuntime, STOP_TIMEOUT_MS, bin } from './launcher-process.test-support.js';

/**
 * A taken embedded PostgreSQL port used to hang the runtime for good: the postmaster exited, and
 * `embedded-postgres` then waited for an exit event that never came again, so neither `failed` nor
 * `ready` was ever sent. It must now answer `failed` naming the port, and exit 1, promptly.
 */

let projectDir = '';
let holder: Server | null = null;
let runtime: ForkedRuntime | null = null;

beforeAll(async () => {
  if (!existsSync(bin)) {
    throw new Error(`run pnpm --filter @indx-workspace/embedded build first; missing: ${bin}`);
  }
  projectDir = mkdtempSync(path.join(tmpdir(), 'embedded-launcher-port-'));
  holder = await holdPort(DATABASE_PORT);
});

/** A stale holder (a postmaster an earlier failed run left) would turn this into a real start. */
function expectPortHeld(): void {
  expect(
    holder,
    `port ${String(DATABASE_PORT)} was already taken before this suite could hold it`,
  ).not.toBeNull();
}

afterAll(async () => {
  await runtime?.dispose();
  const held = holder;
  if (held !== null) await new Promise<void>((resolve) => held.close(() => resolve()));
  if (projectDir !== '') {
    rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}, STOP_TIMEOUT_MS);

it(
  'answers start with failed naming the port, and exits 1',
  async () => {
    expectPortHeld();
    const ports = await freePorts();
    runtime = new ForkedRuntime(projectDir, ports);
    await runtime.send(startMessage(projectDir, ports));
    const exit = await runtime.ended(PORT_TAKEN_TIMEOUT_MS);

    expect(runtime.messages).toStrictEqual([
      {
        type: 'failed',
        message:
          'the local runtime cannot start; nothing was started. These ports are not free:\n' +
          `  port ${String(DATABASE_PORT)} (embedded PostgreSQL) is already in use: ` +
          'stop the process that holds it, or set AW_DATABASE_PORT in .env to a free port below 49152',
      },
    ]);
    expect(exit).toStrictEqual({ code: 1, signal: null });
  },
  PORT_TAKEN_TIMEOUT_MS + 10_000,
);
