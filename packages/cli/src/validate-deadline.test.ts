import { createServer, type Socket } from 'node:net';
import { expect, it } from 'vitest';

import { liveProfileProbes } from './validate.js';

/** A server that accepts but never answers proves cancellation ends the driver's own wait. */
it('abandons a relational probe that never answers, and releases its pool', async () => {
  const server = createServer();
  const accepted = new Promise<Socket>((resolve) => {
    server.once('connection', (socket) => {
      // Accept the driver's startup packet and answer nothing. Draining is what lets this side
      // notice the close; a paused socket with unread bytes never reports one.
      socket.resume();
      resolve(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP port');

  const controller = new AbortController();
  // The pool's own bound is far away, so the signal is demonstrably what ends the wait.
  const probe = liveProfileProbes(30_000).relational(
    `postgres://agent_workspace:pw@127.0.0.1:${address.port}/agent_workspace`,
    controller.signal,
  );

  try {
    const socket = await accepted;
    controller.abort(new Error('the run deadline passed'));
    await expect(probe).rejects.toThrow(/the run deadline passed/u);
    // The probe returned, and the socket it opened does not outlive it.
    await new Promise<void>((resolve) => {
      if (socket.destroyed) {
        resolve();
        return;
      }
      socket.once('close', () => resolve());
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);

it('carries the run signal into every object-store request', async () => {
  const controller = new AbortController();
  controller.abort(new Error('the run deadline passed'));
  await expect(
    liveProfileProbes(250).objects(
      {
        backend: 's3',
        bucket: 'agent-workspace',
        region: 'us-east-1',
        // Port 1 is never listening; the aborted signal is what must end this, not a timeout.
        endpoint: 'http://127.0.0.1:1',
        accessKeyId: 'agent_workspace',
        secretAccessKey: 'object-store-secret',
        forcePathStyle: true,
      },
      controller.signal,
    ),
    // Pinned to the abort, not to any rejection: port 1 refuses the connection on its own, so a
    // bare assertion would stay green if `abortSignal: signal` were dropped from the request.
  ).rejects.toThrow(/Request aborted/u);
}, 10_000);
