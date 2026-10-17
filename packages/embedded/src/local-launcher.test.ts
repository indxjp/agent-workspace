import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EmbeddedDatabasePortError, EmbeddedDatabasePortInUseError } from './embedded-db.js';
import { HAND_SET_POLICY_WARNING } from './local-environment.js';
import {
  type LauncherSignal,
  type LocalLauncherDeps,
  runLocalLauncher,
  runtimeProfileConflictWarning,
  runtimeProfileUnenforceableWarning,
  signInLine,
} from './local-launcher.js';
import { RUNTIME_DIRECTORY } from './local-secrets.js';
import { createRuntimeLock, RUNTIME_PID_FILE } from './runtime-lock.js';
import type { LocalRuntimeChannel } from './runtime-messages.js';

const TOKEN = `ak_live_${'t'.repeat(22)}_${'K'.repeat(43)}`;
const WORKSPACE_ID = '0b9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e';
const ADMIN_ID = '1c9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e';
const URL_ = 'http://127.0.0.1:3100';

interface Directory {
  readonly marker: 'directory';
}

let projectDir = '';

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'embedded-launcher-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function harness(overrides: Partial<LocalLauncherDeps<Directory>> = {}) {
  const events: string[] = [];
  const sent: unknown[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const signals = new Map<LauncherSignal, () => void>();
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const env: Record<string, string | undefined> = {};
  let exited: (code: number) => void = () => undefined;
  const exitCode = new Promise<number>((resolve) => {
    exited = resolve;
  });

  const channel: LocalRuntimeChannel = {
    send: (message) => {
      sent.push(message);
      if (typeof message === 'object' && message !== null && 'type' in message) {
        events.push(`send:${String(message.type)}`);
      }
      return Promise.resolve();
    },
    onMessage: (listener) => {
      messageListeners.push(listener);
      return () => void messageListeners.splice(messageListeners.indexOf(listener), 1);
    },
    onDisconnect: (listener) => {
      disconnectListeners.push(listener);
      return () => void disconnectListeners.splice(disconnectListeners.indexOf(listener), 1);
    },
  };

  const deps: LocalLauncherDeps<Directory> = {
    channel,
    env,
    stdout: (chunk) => void stdout.push(chunk),
    stderr: (chunk) => void stderr.push(chunk),
    chdir: (directory) => void events.push(`chdir:${directory}`),
    loadDotEnv: () => undefined,
    portState: () => Promise.resolve('free'),
    startWorkspace: (options) => {
      events.push(`startWorkspace:${String(options.web?.dir)}`);
      return Promise.resolve({
        url: URL_,
        seed: { workspaceId: WORKSPACE_ID, adminUserId: ADMIN_ID },
        close: () => {
          events.push('workspace.close');
          return Promise.resolve();
        },
      });
    },
    assertServerServesContracts: () => Promise.resolve(),
    openDatabaseRoot: () =>
      Promise.resolve({
        directory: { marker: 'directory' },
        resolveMembership: (email: string, slug: string) => {
          events.push(`resolveMembership:${email}:${slug}`);
          return Promise.resolve({ workspaceId: WORKSPACE_ID, userId: ADMIN_ID, role: 'owner' });
        },
        close: () => {
          events.push('root.close');
          return Promise.resolve();
        },
      }),
    prepareLocalRuntimeProfile: (workspaceId, root) => {
      events.push(`prepareProfile:${workspaceId}:${root.directory.marker}`);
      return Promise.resolve({ kind: 'created' as const, profile: { driver: 'local' } });
    },
    issueLocalCredential: (input, issueDeps) => {
      events.push(
        `issue:${input.workspaceId}:${input.userId}:${Object.keys(input).length}:${issueDeps.directory.marker}`,
      );
      return Promise.resolve({
        token: TOKEN,
        expiresAt: new Date('2026-10-03T00:00:00.000Z'),
        revoke: () => {
          events.push('revoke');
          return Promise.resolve('revoked' as const);
        },
      });
    },
    onSignal: (signal, listener) => void signals.set(signal, listener),
    claimSignals: () => void events.push('claimSignals'),
    exit: (code) => {
      events.push(`exit:${String(code)}`);
      exited(code);
    },
    webDir: '/runtime/dist/web',
    migrationsDir: '/runtime/dist/migrations',
    startTimeoutMs: 1000,
    ...overrides,
  };

  const deliver = (message: unknown) => {
    for (const listener of [...messageListeners]) listener(message);
  };
  const deliverStart = (dir = projectDir) => {
    deliver({
      type: 'start',
      projectDir: dir,
      environment: { port: 3100, bootstrapAdmin: 'Dev@Localhost.test' },
    });
  };

  return {
    deps,
    env,
    events,
    sent,
    stdout,
    stderr,
    exitCode,
    signal: (name: LauncherSignal) => signals.get(name)?.(),
    disconnect: () => {
      for (const listener of [...disconnectListeners]) listener();
    },
    run: async (dir?: string) => {
      const result = runLocalLauncher(deps);
      await Promise.resolve();
      deliverStart(dir);
      return result;
    },
    /** Start the launcher and deliver `message` in place of a valid start. */
    runWith: async (message: unknown) => {
      const result = runLocalLauncher(deps);
      await Promise.resolve();
      deliver(message);
      return result;
    },
    /** Start the launcher and deliver nothing yet. */
    launch: () => runLocalLauncher(deps),
    deliverStart,
  };
}

/** A promise with its settle functions, for a step the test finishes by hand. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Wait until `condition` holds, polling the event loop. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!condition()) throw new Error('condition never held');
}

const WORKSPACE = {
  url: URL_,
  seed: { workspaceId: WORKSPACE_ID, adminUserId: ADMIN_ID },
};

describe('runLocalLauncher', () => {
  it('sends ready and then credential, in that order, with the seeded workspace', async () => {
    const h = harness();
    await expect(h.run()).resolves.toBe(0);
    expect(h.sent).toStrictEqual([
      { type: 'ready', url: URL_, contractsVersion: CONTRACTS_VERSION },
      {
        type: 'credential',
        token: TOKEN,
        expiresAt: '2026-10-03T00:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        workspaceSlug: 'default',
      },
    ]);
    expect(h.events).toStrictEqual([
      `chdir:${projectDir}`,
      'startWorkspace:/runtime/dist/web',
      'claimSignals',
      'send:ready',
      'resolveMembership:dev@localhost.test:default',
      // S1-22: the `local` profile is the workspace default before any key exists.
      `prepareProfile:${WORKSPACE_ID}:directory`,
      // The subject only: the issuer reads the member's role from the directory itself.
      `issue:${WORKSPACE_ID}:${ADMIN_ID}:2:directory`,
      'send:credential',
    ]);
    expect(h.env['AW_DEPLOYMENT_POSTURE']).toBe('local');
    expect(h.env['SESSION_SECRET']).toMatch(/^[0-9a-f]{64}$/u);
  });

  // UX-G (#760): after SIGKILL of `aw dev` the runtime saw the channel close, began to stop, hung in
  // a service that never closed, and then ignored every signal while spinning.
  it('exits 1 after the grace when a service never closes, whatever signal arrives', async () => {
    const h = harness({
      stopGraceMs: 20,
      startWorkspace: () =>
        Promise.resolve({
          url: URL_,
          seed: { workspaceId: WORKSPACE_ID, adminUserId: ADMIN_ID },
          close: () => new Promise<void>(() => undefined),
        }),
    });
    await h.run();
    const pidFile = path.join(projectDir, '.agent-workspace', 'runtime.pid');
    expect(existsSync(pidFile)).toBe(true);
    h.disconnect();
    h.signal('SIGTERM');
    await expect(h.exitCode).resolves.toBe(1);
    expect(existsSync(pidFile)).toBe(false);
    expect(h.stderr.join('')).toContain('did not stop within the grace');
  });

  it('revokes, closes and exits 0 on SIGINT, once', async () => {
    const h = harness();
    await h.run();
    h.signal('SIGINT');
    h.signal('SIGTERM');
    h.disconnect();
    await expect(h.exitCode).resolves.toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.events.slice(-4)).toStrictEqual(['revoke', 'root.close', 'workspace.close', 'exit:0']);
    expect(h.events.filter((event) => event === 'exit:0')).toHaveLength(1);
  });

  // S1-25 (#510): a closed terminal (SIGHUP) or Ctrl+Break (SIGBREAK) ends the process without an
  // `exit` event, so the detached postmaster would outlive it unless the launcher stops in order.
  it.each(['SIGHUP', 'SIGBREAK'] as const)(
    'revokes, closes and exits 0 on %s, once',
    async (signal) => {
      const h = harness();
      await h.run();
      h.signal(signal);
      h.signal(signal);
      await expect(h.exitCode).resolves.toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.events.slice(-4)).toStrictEqual([
        'revoke',
        'root.close',
        'workspace.close',
        'exit:0',
      ]);
      expect(h.events.filter((event) => event === 'exit:0')).toHaveLength(1);
    },
  );

  it('stops on the channel closing, and tolerates a failed revoke', async () => {
    const h = harness({
      issueLocalCredential: () =>
        Promise.resolve({
          token: TOKEN,
          expiresAt: new Date('2026-10-03T00:00:00.000Z'),
          revoke: () => Promise.reject(new Error('database gone')),
        }),
    });
    await h.run();
    h.disconnect();
    await expect(h.exitCode).resolves.toBe(0);
    expect(h.events.slice(-3)).toStrictEqual(['root.close', 'workspace.close', 'exit:0']);
    expect(h.stderr.join('')).toContain('could not be revoked');
  });

  it('warns when the key to revoke no longer exists, and stays quiet when it was already revoked', async () => {
    for (const [outcome, warned] of [
      ['missing', true],
      ['already-revoked', false],
    ] as const) {
      const h = harness({
        issueLocalCredential: () =>
          Promise.resolve({
            token: TOKEN,
            expiresAt: new Date('2026-10-03T00:00:00.000Z'),
            revoke: () => Promise.resolve(outcome),
          }),
      });
      await h.run();
      h.disconnect();
      await expect(h.exitCode).resolves.toBe(0);
      expect(h.stderr.join('').includes('was not found to revoke'), outcome).toBe(warned);
      expect(h.events.slice(-3)).toStrictEqual(['root.close', 'workspace.close', 'exit:0']);
    }
  });

  it('sends failed and releases everything when a step after ready fails', async () => {
    const h = harness({
      issueLocalCredential: () => Promise.reject(new Error(`boom ${TOKEN}`)),
    });
    await expect(h.run()).resolves.toBe(1);
    expect(h.sent).toStrictEqual([
      { type: 'ready', url: URL_, contractsVersion: CONTRACTS_VERSION },
      { type: 'failed', message: 'the local runtime failed to start (Error)' },
    ]);
    expect(h.events.slice(-2)).toStrictEqual(['root.close', 'workspace.close']);
  });

  it('refuses a seeded workspace the bootstrap admin is not a member of', async () => {
    const h = harness({
      openDatabaseRoot: () =>
        Promise.resolve({
          directory: { marker: 'directory' },
          resolveMembership: () => Promise.resolve(null),
          close: () => Promise.resolve(),
        }),
    });
    await expect(h.run()).resolves.toBe(1);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({ type: 'failed' });
    expect(JSON.stringify(h.sent[1])).toContain('WORKSPACE_SLUG');
  });

  it('refuses a membership that is not the seeded bootstrap admin, issuing nothing', async () => {
    const h = harness({
      openDatabaseRoot: () =>
        Promise.resolve({
          directory: { marker: 'directory' },
          resolveMembership: () =>
            Promise.resolve({
              workspaceId: WORKSPACE_ID,
              userId: '2c9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e',
              role: 'admin',
            }),
          close: () => Promise.resolve(),
        }),
    });
    await expect(h.run()).resolves.toBe(1);
    expect(h.sent[1]).toMatchObject({ type: 'failed' });
    expect(JSON.stringify(h.sent[1])).toContain('WORKSPACE_SLUG');
    expect(h.events.some((event) => event.startsWith('issue:'))).toBe(false);
  });

  it.each(['kept', 'adopted', 'created'] as const)(
    'continues to the credential, silently, when the local runtime profile is %s',
    async (kind) => {
      const h = harness({
        prepareLocalRuntimeProfile: () => Promise.resolve({ kind, profile: { driver: 'local' } }),
      });
      await expect(h.run()).resolves.toBe(0);
      expect(h.sent[1]).toMatchObject({ type: 'credential' });
      expect(h.stderr).toStrictEqual([]);
    },
  );

  it('warns once on a name-conflict and still starts: agents stay strictly refused', async () => {
    const h = harness({
      prepareLocalRuntimeProfile: () => Promise.resolve({ kind: 'name-conflict', name: 'local' }),
    });
    await expect(h.run()).resolves.toBe(0);
    expect(h.sent[1]).toMatchObject({ type: 'credential' });
    expect(h.stderr).toStrictEqual([runtimeProfileConflictWarning('local')]);
    expect(h.stderr[0]).toContain('cannot run until one is chosen');
    expect(h.stderr[0]?.endsWith('\n')).toBe(true);
  });

  it('warns once, naming the settings, when the local profile is unenforceable, and still starts', async () => {
    const settings = ['networkPolicy=restricted', 'allowedDomains', 'filesystem=read-only'];
    const h = harness({
      prepareLocalRuntimeProfile: () =>
        Promise.resolve({ kind: 'unenforceable', name: 'local', settings }),
    });
    await expect(h.run()).resolves.toBe(0);
    expect(h.sent[1]).toMatchObject({ type: 'credential' });
    expect(h.stderr).toStrictEqual([runtimeProfileUnenforceableWarning('local', settings)]);
    expect(h.stderr[0]).toContain('networkPolicy=restricted, allowedDomains, filesystem=read-only');
    expect(h.stderr[0]).toContain('cannot run until one is chosen');
    expect(h.stderr[0]?.endsWith('\n')).toBe(true);
  });

  it('prepares the docker profile under the docker sandbox and starts on a docker default (#786)', async () => {
    const drivers: string[] = [];
    const h = harness({
      prepareLocalRuntimeProfile: (_workspaceId, _root, driver) => {
        drivers.push(driver);
        return Promise.resolve({ kind: 'created', profile: { driver: 'docker' } });
      },
    });
    h.env['RUNTIME_DRIVER'] = 'docker';
    await expect(h.run()).resolves.toBe(0);
    expect(drivers).toStrictEqual(['docker']);
    expect(h.sent[1]).toMatchObject({ type: 'credential' });
  });

  it('keeps the local profile when no driver was asked for, though the host default is docker', async () => {
    const drivers: string[] = [];
    const seen: (string | undefined)[] = [];
    const h = harness({
      // The driver startWorkspace reports (banner, startup line) is the one runs use (BH061-050).
      startWorkspace: () => {
        seen.push(h.env['RUNTIME_DRIVER']);
        return Promise.resolve({
          url: URL_,
          seed: { workspaceId: WORKSPACE_ID, adminUserId: ADMIN_ID },
          close: () => Promise.resolve(),
        });
      },
      prepareLocalRuntimeProfile: (_workspaceId, _root, driver) => {
        drivers.push(driver);
        return Promise.resolve({ kind: 'kept', profile: { driver: 'local' } });
      },
    });
    await expect(h.run()).resolves.toBe(0);
    expect(drivers).toStrictEqual(['local']);
    expect(seen).toStrictEqual(['local']);
  });

  it.each([
    { kind: 'kept', profile: { driver: 'local' } },
    { kind: 'name-conflict', name: 'docker' },
    { kind: 'unenforceable', name: 'docker', settings: ['networkPolicy=restricted'] },
  ] as const)(
    'refuses a docker session, issuing nothing, when the default is not a docker profile ($kind)',
    async (outcome) => {
      const h = harness({ prepareLocalRuntimeProfile: () => Promise.resolve(outcome) });
      h.env['RUNTIME_DRIVER'] = 'docker';
      await expect(h.run()).resolves.toBe(1);
      expect(h.sent[1]).toMatchObject({ type: 'failed' });
      expect(JSON.stringify(h.sent[1])).toContain('the docker sandbox needs a runtime profile');
      expect(h.events.some((event) => event.startsWith('issue:'))).toBe(false);
    },
  );

  it('answers runtime_profile_not_prepared, issuing nothing, when the preparation throws', async () => {
    const h = harness({
      prepareLocalRuntimeProfile: () =>
        Promise.reject(new Error('postgres://user:secret@127.0.0.1/db is unreachable')),
    });
    await expect(h.run()).resolves.toBe(1);
    expect(h.sent).toStrictEqual([
      { type: 'ready', url: URL_, contractsVersion: CONTRACTS_VERSION },
      {
        type: 'failed',
        message:
          'the local runtime could not prepare the workspace default runtime profile named local',
      },
    ]);
    expect(h.events.some((event) => event.startsWith('issue:'))).toBe(false);
    expect(h.events.slice(-2)).toStrictEqual(['root.close', 'workspace.close']);
  });

  it('never prepares the runtime profile of a workspace the admin is not a member of', async () => {
    const h = harness({
      openDatabaseRoot: () =>
        Promise.resolve({
          directory: { marker: 'directory' },
          resolveMembership: () => Promise.resolve(null),
          close: () => Promise.resolve(),
        }),
    });
    await expect(h.run()).resolves.toBe(1);
    expect(h.events.some((event) => event.startsWith('prepareProfile:'))).toBe(false);
  });

  it('revokes the key before closing the database when a step after issuing it fails', async () => {
    const h = harness();
    const send = h.deps.channel.send.bind(h.deps.channel);
    h.deps.channel.send = (message) => {
      if (typeof message === 'object' && message !== null && 'type' in message) {
        if (message.type === 'credential') return Promise.reject(new Error('channel closed'));
      }
      return send(message);
    };
    await expect(h.run()).resolves.toBe(1);
    expect(h.events.slice(-3)).toStrictEqual(['revoke', 'root.close', 'workspace.close']);
    for (const output of [...h.stdout, ...h.stderr]) expect(output).not.toContain(TOKEN);
  });

  it('refuses a relative or missing project directory before touching anything', async () => {
    for (const dir of ['relative/project', path.join(projectDir, 'missing')]) {
      const h = harness();
      await expect(h.run(dir)).resolves.toBe(1);
      expect(h.sent).toStrictEqual([
        {
          type: 'failed',
          message: 'the project directory must be an existing absolute directory',
        },
      ]);
      expect(h.events).toStrictEqual(['send:failed']);
    }
  });

  it('prints the hand-set policy warning before starting anything when start sends no policy (#534)', async () => {
    let order: string[] = [];
    const h = harness({ stderr: (chunk) => void order.push(`stderr:${chunk}`) });
    order = h.events;
    const handSet = '{ "limits": { "maxTurns": 5 } }';
    h.env['AW_DEPLOYMENT_POLICY'] = handSet;
    await expect(h.run()).resolves.toBe(0);
    const warning = `stderr:${HAND_SET_POLICY_WARNING}\n`;
    expect(h.events.filter((event) => event.startsWith('stderr:'))).toStrictEqual([warning]);
    const started = h.events.findIndex((event) => event.startsWith('startWorkspace'));
    expect(started).toBeGreaterThan(h.events.indexOf(warning));
    expect(h.env['AW_DEPLOYMENT_POLICY']).toBe(handSet);
  });

  // ADR-0109 slice-2 amendment: the withheld check runs after `.env` is loaded, so a secret kept
  // only in `.env` is refused rather than reaching the runtime.
  it('refuses a withheld name that .env sets, after loading it and before starting anything (#534)', async () => {
    const value = 'ghp_from-dotenv-only';
    const h = harness({
      loadDotEnv: () => {
        h.events.push('loadDotEnv');
        h.env['github_token'] = value;
      },
    });
    const result = h.runWith({
      type: 'start',
      projectDir,
      environment: {
        port: 3100,
        bootstrapAdmin: 'Dev@Localhost.test',
        withheld: ['GITHUB_TOKEN'],
      },
    });
    await expect(result).resolves.toBe(1);
    expect(h.events).toContain('loadDotEnv');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ type: 'failed' });
    const failed = JSON.stringify(h.sent[0]);
    expect(failed).toContain('GITHUB_TOKEN is named by secret()');
    expect(failed).toContain('remove it from .env');
    expect(failed).not.toContain(value);
    expect(h.events.some((event) => event.startsWith('startWorkspace'))).toBe(false);
  });

  it('refuses a conflicting environment before starting anything', async () => {
    const h = harness();
    h.env['HOST'] = '0.0.0.0';
    await expect(h.run()).resolves.toBe(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ type: 'failed' });
    expect(JSON.stringify(h.sent[0])).toContain('local posture needs a loopback HOST');
    expect(h.events.some((event) => event.startsWith('startWorkspace'))).toBe(false);
  });

  it('never passes the token to a writer, even on failure', async () => {
    const ok = harness();
    await ok.run();
    ok.signal('SIGINT');
    await ok.exitCode;
    const failing = harness({ issueLocalCredential: () => Promise.reject(new Error(TOKEN)) });
    failing.deps.channel.send = () => Promise.reject(new Error('channel closed'));
    await failing.run();
    for (const output of [...ok.stdout, ...ok.stderr, ...failing.stdout, ...failing.stderr]) {
      expect(output).not.toContain(TOKEN);
    }
    expect(failing.stderr.join('')).toContain('the local runtime failed to start (Error)');
  });

  it('never prints the generated password, only where it is kept (BH061-011)', async () => {
    // The first start generates the password, the second reads it back.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const start = harness();
      await start.run();
      const line = start.stdout.join('');
      expect(line).toContain('dev@localhost.test');
      expect(line).not.toContain(String(start.env['BOOTSTRAP_ADMIN_PASSWORD']));
      expect(line).toContain(
        `the password is in ${path.join(projectDir, '.agent-workspace', 'secrets', 'local-secrets.json')}`,
      );
    }
  });
});

describe('runLocalLauncher refusals before anything starts', () => {
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
    expect(probed.toSorted((left, right) => left - right)).toStrictEqual([
      3100, 4100, 8180, 25_532,
    ]);
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
});

describe('runLocalLauncher and the runtime pid file (#560)', () => {
  const OWN_PID = 1000;
  const HOLDER_PID = 4242;
  const runnerInUse = () =>
    Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:8080'), {
      code: 'EADDRINUSE',
      port: 8080,
    });
  const pidFile = () => path.join(projectDir, RUNTIME_DIRECTORY, RUNTIME_PID_FILE);
  const recordHolder = (pid: number) => {
    mkdirSync(path.join(projectDir, RUNTIME_DIRECTORY), { recursive: true });
    writeFileSync(pidFile(), `${String(pid)}\n`);
  };
  const lock = (alive: readonly number[]) =>
    createRuntimeLock({ pid: OWN_PID, isAlive: (pid) => alive.includes(pid) });

  it('reports already_running, with the port and the recorded pid, when the runner port collides', async () => {
    recordHolder(HOLDER_PID);
    const h = harness({
      runtimeLock: lock([HOLDER_PID]),
      startWorkspace: () => Promise.reject(runnerInUse()),
    });
    await expect(h.run()).resolves.toBe(1);
    expect(h.sent).toStrictEqual([
      {
        type: 'failed',
        message:
          "port 8080 is already in use, and this project's local runtime may already be running (.agent-workspace/runtime.pid records process 4242); if aw dev is running in this project, stop that aw dev before running it again",
      },
    ]);
    // The holder's record is not ours to remove.
    expect(readFileSync(pidFile(), 'utf8')).toBe('4242\n');
  });

  it('reports already_running when the port check finds the ports taken', async () => {
    recordHolder(HOLDER_PID);
    const h = harness({
      runtimeLock: lock([HOLDER_PID]),
      portState: (port) => Promise.resolve(port === 3100 || port === 8080 ? 'listening' : 'free'),
    });
    await expect(h.run()).resolves.toBe(1);
    expect(h.sent).toStrictEqual([
      {
        type: 'failed',
        message:
          "port 3100 is already in use, and this project's local runtime may already be running (.agent-workspace/runtime.pid records process 4242); if aw dev is running in this project, stop that aw dev before running it again",
      },
    ]);
    expect(h.events.some((event) => event.startsWith('startWorkspace'))).toBe(false);
  });

  it('finds the collision inside an AggregateError too', async () => {
    recordHolder(HOLDER_PID);
    const h = harness({
      runtimeLock: lock([HOLDER_PID]),
      startWorkspace: () => Promise.reject(new AggregateError([runnerInUse()], 'start failed')),
    });
    await expect(h.run()).resolves.toBe(1);
    expect(JSON.stringify(h.sent[0])).toContain('runtime.pid records process 4242');
  });

  it('keeps "port 8080 is already in use" when no live process holds the project', async () => {
    recordHolder(HOLDER_PID);
    const h = harness({
      runtimeLock: lock([]),
      startWorkspace: () => Promise.reject(runnerInUse()),
    });
    await expect(h.run()).resolves.toBe(1);
    expect(h.sent).toStrictEqual([{ type: 'failed', message: 'port 8080 is already in use' }]);
  });

  it('never refuses a start up front because of a live holder', async () => {
    recordHolder(HOLDER_PID);
    const h = harness({ runtimeLock: lock([HOLDER_PID]) });
    await expect(h.run()).resolves.toBe(0);
    expect(h.sent[1]).toMatchObject({ type: 'credential' });
  });

  it('re-records itself over a stale record whose pid an unrelated live process reuses', async () => {
    // A hard-killed runtime left its pid behind, and an unrelated live process now has that pid.
    recordHolder(HOLDER_PID);
    let recordedDuringStart = '';
    const h = harness({
      runtimeLock: lock([HOLDER_PID]),
      startWorkspace: () => {
        recordedDuringStart = readFileSync(pidFile(), 'utf8');
        return Promise.resolve({ ...WORKSPACE, close: () => Promise.resolve() });
      },
    });
    await expect(h.run()).resolves.toBe(0);
    // The record is only read while the services start...
    expect(recordedDuringStart).toBe(`${String(HOLDER_PID)}
`);
    // ...and once every service is bound, the record names this runtime, not the unrelated process.
    expect(readFileSync(pidFile(), 'utf8')).toBe(`${String(OWN_PID)}
`);
    h.signal('SIGINT');
    await expect(h.exitCode).resolves.toBe(0);
    expect(existsSync(pidFile())).toBe(false);
  });

  it('reports a failure that is not a collision as itself, even with a live holder', async () => {
    recordHolder(HOLDER_PID);
    const h = harness({
      runtimeLock: lock([HOLDER_PID]),
      startWorkspace: () => Promise.reject(new Error('boom')),
    });
    await expect(h.run()).resolves.toBe(1);
    expect(h.sent).toStrictEqual([
      { type: 'failed', message: 'the local runtime failed to start (Error)' },
    ]);
  });

  it('records its pid while running and removes it on stop', async () => {
    const h = harness({ runtimeLock: lock([]) });
    await expect(h.run()).resolves.toBe(0);
    expect(readFileSync(pidFile(), 'utf8')).toBe(`${String(OWN_PID)}\n`);
    h.signal('SIGINT');
    await expect(h.exitCode).resolves.toBe(0);
    expect(existsSync(pidFile())).toBe(false);
  });

  it('replaces a stale record and removes its own after a failed start', async () => {
    recordHolder(HOLDER_PID);
    let recordedDuringStart = '';
    const h = harness({
      runtimeLock: lock([]),
      startWorkspace: () => {
        recordedDuringStart = readFileSync(pidFile(), 'utf8');
        return Promise.reject(runnerInUse());
      },
    });
    await expect(h.run()).resolves.toBe(1);
    expect(recordedDuringStart).toBe(`${String(OWN_PID)}\n`);
    expect(existsSync(pidFile())).toBe(false);
  });

  it('records the real process by default', async () => {
    const h = harness();
    await expect(h.run()).resolves.toBe(0);
    expect(readFileSync(pidFile(), 'utf8')).toBe(`${String(process.pid)}\n`);
    h.disconnect();
    await expect(h.exitCode).resolves.toBe(0);
    expect(existsSync(pidFile())).toBe(false);
  });
});

describe('runLocalLauncher stopping while it starts', () => {
  it('exits 0 at once on a signal before start arrives, starting nothing', async () => {
    const h = harness({ startTimeoutMs: 60_000 });
    const result = h.launch();
    await Promise.resolve();
    h.signal('SIGINT');
    await expect(result).resolves.toBe(0);
    await expect(h.exitCode).resolves.toBe(0);
    expect(h.sent).toStrictEqual([]);
    expect(h.events).toStrictEqual(['exit:0']);
  });

  it('abandons a start in progress on SIGTERM, closes the workspace when it arrives, and exits 0', async () => {
    const pending = deferred<{
      url: string;
      seed: { workspaceId: string; adminUserId: string };
      close: () => Promise<void>;
    }>();
    const h = harness({
      startWorkspace: () => {
        h.events.push('startWorkspace');
        return pending.promise;
      },
    });
    const result = h.run();
    await until(() => h.events.includes('startWorkspace'));
    h.signal('SIGTERM');
    pending.resolve({
      ...WORKSPACE,
      close: () => {
        h.events.push('workspace.close');
        return Promise.resolve();
      },
    });
    await expect(result).resolves.toBe(0);
    expect(h.sent).toStrictEqual([]);
    expect(h.events.slice(-2)).toStrictEqual(['workspace.close', 'exit:0']);
  });

  it('revokes a key that arrives after a stop during the start before closing the database', async () => {
    const pending = deferred<{
      token: string;
      expiresAt: Date;
      revoke: () => Promise<'revoked' | 'already-revoked' | 'missing'>;
    }>();
    const h = harness({
      issueLocalCredential: () => {
        h.events.push('issue');
        return pending.promise;
      },
    });
    const result = h.run();
    await until(() => h.events.includes('issue'));
    h.signal('SIGINT');
    pending.resolve({
      token: TOKEN,
      expiresAt: new Date('2026-10-03T00:00:00.000Z'),
      revoke: () => {
        h.events.push('revoke');
        return Promise.resolve('revoked' as const);
      },
    });
    await expect(result).resolves.toBe(0);
    expect(h.sent).toStrictEqual([
      { type: 'ready', url: URL_, contractsVersion: CONTRACTS_VERSION },
    ]);
    expect(h.events.slice(-4)).toStrictEqual(['revoke', 'root.close', 'workspace.close', 'exit:0']);
    for (const output of [...h.stdout, ...h.stderr]) expect(output).not.toContain(TOKEN);
  });

  it('exits 0 after the grace period when the channel closes during a start that never settles', async () => {
    const h = harness({
      stopGraceMs: 20,
      startWorkspace: () => {
        h.events.push('startWorkspace');
        return new Promise(() => undefined);
      },
    });
    const result = h.run();
    await until(() => h.events.includes('startWorkspace'));
    h.disconnect();
    await expect(result).resolves.toBe(0);
    await expect(h.exitCode).resolves.toBe(0);
    expect(h.sent).toStrictEqual([]);
  });

  it('reports failed when the start outlives its deadline', async () => {
    const h = harness({
      startupTimeoutMs: 30,
      stopGraceMs: 20,
      startWorkspace: () => new Promise(() => undefined),
    });
    await expect(h.run()).resolves.toBe(1);
    expect(h.sent).toStrictEqual([
      { type: 'failed', message: 'the local runtime did not become ready in time' },
    ]);
    expect(h.events).not.toContain('exit:0');
  });
});

describe('signInLine', () => {
  it('points at the environment when the password did not come from the file', () => {
    const line = signInLine(URL_, 'dev@localhost.test', {
      path: '/p/local-secrets.json',
      passwordFromFile: false,
    });
    expect(line).toContain('set in the environment or .env');
  });
});
