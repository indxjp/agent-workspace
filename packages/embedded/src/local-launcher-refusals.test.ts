import path from 'node:path';

import { expect, it } from 'vitest';

import { EmbeddedDatabasePortError, EmbeddedDatabasePortInUseError } from './embedded-db.js';
import { harness, projectDir } from './launcher.test-support.js';

it('answers an invalid start message with failed and exits 1', async () => {
  const h = harness();
  await expect(h.runWith({ type: 'start', projectDir: 1 })).resolves.toBe(1);
  expect(h.sent).toStrictEqual([
    { type: 'failed', message: 'the local runtime received an invalid start message' },
  ]);
  expect(h.events).toStrictEqual(['send:failed']);
});

it('names a .env it cannot read instead of a bare error class', async () => {
  const dotEnv = path.join(projectDir, '.env');
  const h = harness({
    loadDotEnv: () => {
      throw Object.assign(new TypeError('EISDIR: illegal operation on a directory'), {
        code: 'EISDIR',
      });
    },
  });
  await expect(h.run()).resolves.toBe(1);
  expect(h.sent).toStrictEqual([
    { type: 'failed', message: `${dotEnv} could not be read; it must be a readable .env file` },
  ]);
  expect(h.events.some((event) => event.startsWith('startWorkspace'))).toBe(false);
});

it('refuses an invalid WORKSPACE_SLUG before starting the workspace', async () => {
  const h = harness();
  h.env['WORKSPACE_SLUG'] = 'Bad Slug';
  await expect(h.run()).resolves.toBe(1);
  expect(h.sent).toHaveLength(1);
  expect(JSON.stringify(h.sent[0])).toContain('WORKSPACE_SLUG');
  expect(JSON.stringify(h.sent[0])).not.toContain('Bad Slug');
  expect(h.events.some((event) => event.startsWith('startWorkspace'))).toBe(false);
});

it('reports a taken embedded PostgreSQL port with the port and what to do', async () => {
  const h = harness({
    startWorkspace: () => Promise.reject(new EmbeddedDatabasePortInUseError(25_432)),
  });
  await expect(h.run()).resolves.toBe(1);
  expect(h.sent).toStrictEqual([
    {
      type: 'failed',
      message:
        'port 25432 is already in use: another process holds it (for example another ' +
        "project's aw dev, or a PostgreSQL a killed run left behind); stop it, or set " +
        'AW_DATABASE_PORT in .env to another free port below 49152',
    },
  ]);
});

// #660: busy ports were reported one start at a time, naming neither the service nor the setting.
it('reports every busy port in one failed message, with its role and setting, and starts nothing', async () => {
  const probed: number[] = [];
  const h = harness({
    portState: (port) => {
      probed.push(port);
      if (port === 3100) return Promise.resolve('listening');
      return Promise.resolve(port === 4100 ? 'none' : 'free');
    },
  });
  await expect(h.run()).resolves.toBe(1);
  // #664: web port 3100 moves the gateway, runner and database by 100 from 4000 / 8080 / 25432.
  expect(probed.toSorted((left, right) => left - right)).toStrictEqual([3100, 4100, 8180, 25_532]);
  expect(h.sent).toStrictEqual([
    {
      type: 'failed',
      message: [
        'the local runtime cannot start; nothing was started. These ports are not free:',
        '  port 3100 (web) is already in use: stop the process that holds it, or set environments.local.port in agent-workspace.yaml to a free port below 49152',
        '  port 4100 (gateway) cannot be bound on 127.0.0.1, but no process is listening on it: the operating system reserves it; set GATEWAY_PORT in .env to a free port below 49152',
      ].join('\n'),
    },
  ]);
  expect(h.events.some((event) => event.startsWith('startWorkspace'))).toBe(false);
});

it('checks the ports .env moves the services to, and skips the database DATABASE_URL replaces', async () => {
  const probed: number[] = [];
  const h = harness({
    loadDotEnv: () => {
      h.env['GATEWAY_PORT'] = '4500';
      h.env['RUNNER_PORT'] = '8500';
      h.env['DATABASE_URL'] = 'postgresql://user:pass@127.0.0.1:5432/db';
    },
    portState: (port) => {
      probed.push(port);
      return Promise.resolve(port === 8500 ? 'unknown' : 'free');
    },
  });
  await expect(h.run()).resolves.toBe(1);
  expect(probed.toSorted((left, right) => left - right)).toStrictEqual([3100, 4500, 8500]);
  expect(h.sent).toStrictEqual([
    {
      type: 'failed',
      message:
        'the local runtime cannot start; nothing was started. These ports are not free:\n' +
        '  port 8500 (runner) cannot be bound on 127.0.0.1, and whether a process holds it could not be determined: stop whatever holds it, or set RUNNER_PORT in .env to a free port below 49152',
    },
  ]);
});

// #556: a port the OS reserves (WSL2 mirrored networking) is not reported as "already in use".
it('reports a reserved embedded PostgreSQL port as reserved, not in use', async () => {
  const h = harness({
    startWorkspace: () => Promise.reject(new EmbeddedDatabasePortError('port_reserved', 54_329)),
  });
  await expect(h.run()).resolves.toBe(1);
  expect(h.sent).toHaveLength(1);
  const message = JSON.stringify(h.sent[0]);
  expect(message).toContain('port 54329 cannot be bound on 127.0.0.1');
  expect(message).toContain('AW_DATABASE_PORT');
  expect(message).not.toContain('already in use');
});
