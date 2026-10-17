import { describe, expect, it } from 'vitest';

import { EmbeddedDatabasePortError, EmbeddedDatabasePortInUseError } from './embedded-db.js';
import { LocalRuntimeEnvironmentError, LocalRuntimePortsBusyError } from './local-environment.js';
import { LocalSecretsError } from './local-secrets.js';
import { EmbeddedDatabaseError } from './postmaster.js';
import {
  collisionPort,
  failureMessage,
  LocalLauncherError,
  LocalRuntimeProtocolError,
  type LocalRuntimeChannel,
  receiveStartMessage,
  sendChildMessage,
} from './runtime-messages.js';

const start = {
  type: 'start',
  projectDir: '/home/dev/project',
  environment: { port: 3000, bootstrapAdmin: 'dev@localhost.test' },
} as const;

function fakeChannel() {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const sent: unknown[] = [];
  const channel: LocalRuntimeChannel = {
    send: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
    onMessage: (listener) => {
      messageListeners.add(listener);
      return () => void messageListeners.delete(listener);
    },
    onDisconnect: (listener) => {
      disconnectListeners.add(listener);
      return () => void disconnectListeners.delete(listener);
    },
  };
  return {
    channel,
    sent,
    deliver: (message: unknown) => {
      for (const listener of [...messageListeners]) listener(message);
    },
    disconnect: () => {
      for (const listener of [...disconnectListeners]) listener();
    },
    listenerCount: () => messageListeners.size + disconnectListeners.size,
  };
}

async function failedFor(error: unknown): Promise<unknown> {
  const { channel, sent } = fakeChannel();
  await sendChildMessage(channel, { type: 'failed', message: failureMessage(error) });
  return sent[0];
}

describe('receiveStartMessage', () => {
  it('resolves a valid start and removes its listeners', async () => {
    const fake = fakeChannel();
    const received = receiveStartMessage(fake.channel, { timeoutMs: 1000 });
    fake.deliver(start);
    await expect(received).resolves.toStrictEqual(start);
    expect(fake.listenerCount()).toBe(0);
  });

  it.each([
    ['an unknown key', { ...start, extra: true }],
    ['a wrong type', { ...start, environment: { ...start.environment, port: '3000' } }],
    [
      'a message travelling the wrong way',
      { type: 'ready', url: 'http://127.0.0.1:3000', contractsVersion: '0.2.1' },
    ],
    ['a malformed value', 'start'],
  ])('refuses %s, which becomes a failed message', async (_name, message) => {
    const fake = fakeChannel();
    const received = receiveStartMessage(fake.channel, { timeoutMs: 1000 });
    fake.deliver(message);
    const error = await received.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LocalRuntimeProtocolError);
    expect(error).toMatchObject({ code: 'invalid_start' });
    expect(await failedFor(error)).toStrictEqual({
      type: 'failed',
      message: 'the local runtime received an invalid start message',
    });
  });

  it('times out when no start arrives', async () => {
    const fake = fakeChannel();
    const error = await receiveStartMessage(fake.channel, { timeoutMs: 10 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'start_timeout' });
    expect(await failedFor(error)).toMatchObject({ type: 'failed' });
    expect(fake.listenerCount()).toBe(0);
  });

  it('rejects when the channel closes first', async () => {
    const fake = fakeChannel();
    const received = receiveStartMessage(fake.channel, { timeoutMs: 1000 });
    fake.disconnect();
    await expect(received).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('rejects with stopped at once when its signal is aborted, and removes its listeners', async () => {
    const fake = fakeChannel();
    const interrupt = new AbortController();
    const received = receiveStartMessage(fake.channel, {
      timeoutMs: 60_000,
      signal: interrupt.signal,
    });
    interrupt.abort();
    await expect(received).rejects.toMatchObject({ code: 'stopped' });
    expect(fake.listenerCount()).toBe(0);

    const already = receiveStartMessage(fake.channel, {
      timeoutMs: 60_000,
      signal: interrupt.signal,
    });
    await expect(already).rejects.toMatchObject({ code: 'stopped' });
    expect(fake.listenerCount()).toBe(0);
  });
});

describe('sendChildMessage', () => {
  it('refuses a message the protocol does not allow, before sending it', async () => {
    const fake = fakeChannel();
    await expect(
      sendChildMessage(fake.channel, {
        type: 'ready',
        url: 'http://0.0.0.0:3000',
        contractsVersion: '0.2.1',
      }),
    ).rejects.toMatchObject({ code: 'invalid_outgoing' });
    expect(fake.sent).toStrictEqual([]);
  });
});

describe('failureMessage', () => {
  it('maps EADDRINUSE with a numeric port', () => {
    const error = Object.assign(
      new Error('listen EADDRINUSE: address already in use 127.0.0.1:3000'),
      {
        code: 'EADDRINUSE',
        port: 3000,
      },
    );
    expect(failureMessage(error)).toBe('port 3000 is already in use');
  });

  it('reports the embedded PostgreSQL port when it is taken, with what to do (#556)', () => {
    const message =
      'port 25432 is already in use: another process holds it (for example another ' +
      "project's aw dev, or a PostgreSQL a killed run left behind); stop it, or set " +
      'AW_DATABASE_PORT in .env to another free port below 49152';
    expect(failureMessage(new EmbeddedDatabasePortInUseError(25_432))).toBe(message);
    expect(
      failureMessage(
        new AggregateError(
          [new EmbeddedDatabasePortInUseError(25_432), new Error('cleanup')],
          'boom',
        ),
      ),
    ).toBe(message);
  });

  it('keeps every line of the busy-ports message rather than one bare port (#660)', () => {
    const error = new LocalRuntimePortsBusyError([
      {
        port: 3000,
        role: 'web',
        setting: 'environments.local.port in agent-workspace.yaml',
        state: 'listening',
      },
      { port: 4000, role: 'gateway', setting: 'GATEWAY_PORT in .env', state: 'none' },
    ]);
    expect(failureMessage(error)).toBe(error.message);
    expect(failureMessage(error).split('\n')).toHaveLength(3);
  });

  it('keeps a web, gateway or runner listener collision short (#556)', () => {
    const error = Object.assign(new Error('listen EADDRINUSE: address already in use :::3000'), {
      code: 'EADDRINUSE',
      port: 3000,
    });
    expect(failureMessage(error)).toBe('port 3000 is already in use');
  });

  it('explains a port the operating system reserves (#556)', () => {
    const message = failureMessage(
      new EmbeddedDatabasePortError('port_reserved', 54_329, {
        cause: Object.assign(new Error('listen EADDRINUSE 127.0.0.1:54329'), {
          code: 'EADDRINUSE',
          port: 54_329,
        }),
      }),
    );
    expect(message).toBe(
      'port 54329 cannot be bound on 127.0.0.1, but no process is listening on it: the operating ' +
        "system reserves it (under WSL2 mirrored networking, Windows' dynamic ports 49152-65535 " +
        'cannot be bound); set AW_DATABASE_PORT in .env to a free port below 49152, or ' +
        'DATABASE_URL to your own PostgreSQL',
    );
    expect(failureMessage(new EmbeddedDatabasePortError('invalid_port'))).toBe(
      'AW_DATABASE_PORT must be a whole number from 1024 to 65535',
    );
  });

  it('shows an inconclusive bind failure and a service-port clash as typed messages (#556)', () => {
    const unavailable = new EmbeddedDatabasePortError('port_unavailable', 25_432, {
      cause: Object.assign(new Error('listen EADDRINUSE 127.0.0.1:25432'), {
        code: 'EADDRINUSE',
        port: 25_432,
      }),
    });
    expect(failureMessage(unavailable)).toBe(
      'port 25432 cannot be bound on 127.0.0.1, and whether a process holds it could not be ' +
        'determined: another process holds it or the operating system reserves it; stop whatever ' +
        'holds it, or set AW_DATABASE_PORT in .env to a free port below 49152, or DATABASE_URL to ' +
        'your own PostgreSQL',
    );
    expect(
      failureMessage(
        new EmbeddedDatabasePortError('port_conflict', 24_100, { conflictsWith: 'PORT' }),
      ),
    ).toBe(
      "port 24100 is both the embedded PostgreSQL's port and PORT: set AW_DATABASE_PORT (or " +
        'PORT) in .env so the two differ',
    );
  });

  it('shows the embedded PostgreSQL errors’ fixed messages, never their cause (#510)', () => {
    const cause = new Error('spawn /home/dev/secret-path/postgres ENOENT postgres://u:pw@host');
    const message = failureMessage(new EmbeddedDatabaseError('postmaster_exited', { cause }));
    expect(message).toBe('the embedded PostgreSQL server exited before it was ready');
    expect(message).not.toContain('secret-path');
    expect(failureMessage(new EmbeddedDatabaseError('binary_not_found'))).toBe(
      'the embedded PostgreSQL server binary could not be found; reinstall the local runtime',
    );
  });

  it('names the .env path when it cannot be read', () => {
    expect(
      failureMessage(
        new LocalLauncherError('dotenv_unreadable', {
          cause: new Error('EISDIR'),
          file: '/p/.env',
        }),
      ),
    ).toBe('/p/.env could not be read; it must be a readable .env file');
  });

  it('finds a known error inside an AggregateError', () => {
    const inner = Object.assign(new Error('x'), { code: 'EADDRINUSE', port: 4000 });
    expect(failureMessage(new AggregateError([inner, new Error('cleanup')], 'boom'))).toBe(
      'port 4000 is already in use',
    );
  });

  // #560: an EACCES listen error used to print "the local runtime failed to start (Error)".
  const permissionDenied = (port?: number) =>
    Object.assign(
      new Error(`listen EACCES: permission denied 127.0.0.1:${String(port)} secret-detail`),
      port === undefined ? { code: 'EACCES' } : { code: 'EACCES', port },
    );

  it('explains a privileged port that may not be listened on', () => {
    const message = failureMessage(permissionDenied(80));
    expect(message).toBe(
      'permission denied to listen on port 80; ports below 1024 need elevated privileges, choose a port from 1024 to 65535',
    );
    expect(message).not.toContain('secret-detail');
  });

  it('reports a permission refusal on an unprivileged port without the privilege hint', () => {
    expect(failureMessage(permissionDenied(5000))).toBe('permission denied to listen on port 5000');
    expect(failureMessage(permissionDenied(1024))).toBe('permission denied to listen on port 1024');
  });

  it('finds a permission refusal inside an AggregateError', () => {
    expect(
      failureMessage(new AggregateError([new Error('cleanup'), permissionDenied(443)], 'boom')),
    ).toBe(
      'permission denied to listen on port 443; ports below 1024 need elevated privileges, choose a port from 1024 to 65535',
    );
  });

  it('names only the class of an EACCES error that carries no port', () => {
    expect(failureMessage(permissionDenied())).toBe('the local runtime failed to start (Error)');
  });

  it('words already_running with the port and the recorded pid, never telling to stop that pid', () => {
    const message = failureMessage(
      new LocalLauncherError('already_running', { pid: 4242, port: 8080 }),
    );
    expect(message).toBe(
      "port 8080 is already in use, and this project's local runtime may already be running (.agent-workspace/runtime.pid records process 4242); if aw dev is running in this project, stop that aw dev before running it again",
    );
    // A pid file cannot prove its process is an aw runtime (issue #560): a reused pid must not be
    // named as something to stop.
    expect(message).not.toMatch(/stop (?:it|process|4242)[^a-z]/u);
  });

  it('words already_running without a port or pid it was not given', () => {
    expect(failureMessage(new LocalLauncherError('already_running'))).toBe(
      "a port is already in use, and this project's local runtime may already be running; if aw dev is running in this project, stop that aw dev before running it again",
    );
  });

  it('finds the port of a collision, on its own or inside an AggregateError', () => {
    const inUse = Object.assign(new Error('x'), { code: 'EADDRINUSE', port: 8080 });
    expect(collisionPort(inUse)).toBe(8080);
    expect(collisionPort(new EmbeddedDatabasePortInUseError(54329))).toBe(54329);
    expect(collisionPort(new AggregateError([new Error('cleanup'), inUse], 'boom'))).toBe(8080);
    expect(collisionPort(permissionDenied(80))).toBeUndefined();
    expect(collisionPort(Object.assign(new Error('x'), { code: 'EADDRINUSE' }))).toBeUndefined();
    expect(collisionPort(new AggregateError([new Error('cleanup')], 'boom'))).toBeUndefined();
    expect(collisionPort('EADDRINUSE')).toBeUndefined();
  });

  it('uses the typed errors’ own messages', () => {
    expect(failureMessage(new LocalRuntimeEnvironmentError('conflicting_value', 'PORT'))).toContain(
      'PORT',
    );
    expect(failureMessage(new LocalSecretsError('local_secrets_invalid', '/p/s.json'))).toContain(
      '/p/s.json',
    );
  });

  it('names only the class of an untyped error, never its message', () => {
    const token = `awu_live_${'a'.repeat(22)}_${'B'.repeat(43)}`;
    class ConnectionError extends Error {}
    const message = failureMessage(new ConnectionError(`postgres://u:pw@host failed ${token}`));
    expect(message).toBe('the local runtime failed to start (ConnectionError)');
    expect(message).not.toContain(token);
    expect(failureMessage('a string')).toBe('the local runtime failed to start (string)');
  });

  it('strips control characters but keeps tabs and line feeds, and caps the length', () => {
    const error = new LocalSecretsError(
      'local_secrets_invalid',
      `/p/\u001b]52;c;x\u0007a\tb\nc\r${'x'.repeat(5000)}`,
    );
    const message = failureMessage(error);
    for (const control of ['\u001b', '\u0007', '\r']) expect(message).not.toContain(control);
    expect(message).toContain('a\tb\nc');
    expect(message.length).toBeLessThanOrEqual(4096);
  });
});
