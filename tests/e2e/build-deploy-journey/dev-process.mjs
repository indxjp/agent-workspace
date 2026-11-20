/* global console */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { JourneyFailure, devOrigin, parseDevLine } from '../../journey/harness.mjs';

/** Local `aw dev`: lines parsed as the other journeys do; stopped through its process group. */
export function startDev(project, env) {
  const child = spawn(path.join(project, 'node_modules/.bin/aw'), ['dev'], {
    cwd: project,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { log: '', ready: null, synced: 0, exited: false };
  let pending = '';
  const read = (/** @type {Buffer} */ chunk) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = parseDevLine(line);
      // The launcher's one-time admin password is neither echoed nor kept for failure messages.
      if (parsed?.kind !== 'adminSignIn') {
        console.log(line);
        state.log += `${line}\n`;
      }
      state.ready ??= devOrigin(parsed);
      if (parsed?.kind === 'synced') state.synced += 1;
    }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  const closed = new Promise((resolve) =>
    child.once('close', () => {
      state.exited = true;
      resolve(undefined);
    }),
  );
  return {
    state,
    async untilSynced(timeoutMs) {
      const until = Date.now() + timeoutMs;
      while (state.ready === null || state.synced === 0) {
        if (state.exited) throw new JourneyFailure(`aw dev exited early\n${state.log}`);
        if (Date.now() > until)
          throw new JourneyFailure(`aw dev was not synced in time\n${state.log}`);
        await delay(500);
      }
    },
    async stop() {
      if (child.pid !== undefined && !state.exited) process.kill(-child.pid, 'SIGTERM');
      await Promise.race([closed, delay(30_000)]);
      if (child.pid !== undefined && !state.exited) process.kill(-child.pid, 'SIGKILL');
    },
  };
}
