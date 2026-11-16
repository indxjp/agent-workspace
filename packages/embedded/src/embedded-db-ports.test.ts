import {
  EMBEDDED_DATABASE_PORT,
  EmbeddedDatabasePortError,
  loopbackPortState,
  probeLoopbackListener,
  resolveEmbeddedDatabasePort,
} from './embedded-db.js';
import { describe, expect, it } from 'vitest';

import { holdLoopbackPort, closeServer } from './loopback.fixture.test-support.js';

describe('probeLoopbackListener', () => {
  it('answers listening for a port a server holds, and none once it is freed', async () => {
    const { server, port } = await holdLoopbackPort();
    try {
      await expect(probeLoopbackListener(port)).resolves.toBe('listening');
    } finally {
      await closeServer(server);
    }
    await expect(probeLoopbackListener(port)).resolves.toBe('none');
  });
});

describe('loopbackPortState', () => {
  it('answers listening for a port a server holds, and free once it is freed', async () => {
    const { server, port } = await holdLoopbackPort();
    try {
      await expect(loopbackPortState(port)).resolves.toBe('listening');
    } finally {
      await closeServer(server);
    }
    await expect(loopbackPortState(port)).resolves.toBe('free');
  });
});

describe('resolveEmbeddedDatabasePort', () => {
  it('defaults to a port outside every ephemeral range (#556)', () => {
    expect(EMBEDDED_DATABASE_PORT).toBe(25432);
    // Linux's default ephemeral range starts at 32768; Windows' and macOS' at 49152.
    expect(EMBEDDED_DATABASE_PORT).toBeLessThan(32_768);
    expect(EMBEDDED_DATABASE_PORT).toBeGreaterThanOrEqual(1024);
  });

  it.each([{}, { AW_DATABASE_PORT: '' }, { AW_DATABASE_PORT: '   ' }])(
    'uses the default when AW_DATABASE_PORT is unset or blank (%j)',
    (env) => {
      expect(resolveEmbeddedDatabasePort(env)).toBe(EMBEDDED_DATABASE_PORT);
    },
  );

  it.each([
    ['26000', 26_000],
    ['1024', 1024],
    ['65535', 65_535],
  ])('accepts AW_DATABASE_PORT=%s', (value, port) => {
    expect(resolveEmbeddedDatabasePort({ AW_DATABASE_PORT: value })).toBe(port);
  });

  it.each(['0', '80', '1023', '65536', '70000', '12a', ' 1', '1e4', '-1', '123456', '2.5'])(
    'refuses AW_DATABASE_PORT=%j without echoing it',
    (value) => {
      let caught: unknown;
      try {
        resolveEmbeddedDatabasePort({ AW_DATABASE_PORT: value });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EmbeddedDatabasePortError);
      expect(caught).toMatchObject({
        code: 'invalid_port',
        port: undefined,
        message: 'AW_DATABASE_PORT must be a whole number from 1024 to 65535',
      });
    },
  );

  // A database port equal to a service port used to start PostgreSQL on it, and the service then
  // failed about a minute later with a bare "port <n> is already in use".
  it.each([
    [{ AW_DATABASE_PORT: '3000' }, 3000, 'PORT'],
    [{ AW_DATABASE_PORT: '24100', PORT: '24100' }, 24_100, 'PORT'],
    [{ AW_DATABASE_PORT: '4000' }, 4000, 'GATEWAY_PORT'],
    [{ AW_DATABASE_PORT: '24101', GATEWAY_PORT: ' 24101 ' }, 24_101, 'GATEWAY_PORT'],
    [{ AW_DATABASE_PORT: '8080' }, 8080, 'RUNNER_PORT'],
    [{ RUNNER_PORT: String(EMBEDDED_DATABASE_PORT) }, EMBEDDED_DATABASE_PORT, 'RUNNER_PORT'],
  ] as const)('refuses %j (port %s) as a clash with %s', (env, port, variable) => {
    let caught: unknown;
    try {
      resolveEmbeddedDatabasePort(env);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EmbeddedDatabasePortError);
    expect(caught).toMatchObject({
      code: 'port_conflict',
      port,
      message:
        `port ${String(port)} is both the embedded PostgreSQL's port and ${variable}: set ` +
        `AW_DATABASE_PORT (or ${variable}) in .env so the two differ`,
    });
  });

  it.each([
    { AW_DATABASE_PORT: '3000', PORT: '3100' },
    { AW_DATABASE_PORT: '26000', PORT: '3000', GATEWAY_PORT: '4000', RUNNER_PORT: '8080' },
    { PORT: 'not-a-port' },
  ])('accepts a database port that differs from every service port (%j)', (env) => {
    expect(() => resolveEmbeddedDatabasePort(env)).not.toThrow();
  });
});
