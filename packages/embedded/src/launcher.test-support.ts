import type { LauncherDatabaseRoot } from './launcher-contract.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import { type LauncherSignal, type LocalLauncherDeps, runLocalLauncher } from './local-launcher.js';
import type { LocalRuntimeChannel } from './runtime-messages.js';

export const TOKEN = `ak_live_${'t'.repeat(22)}_${'K'.repeat(43)}`;
export const WORKSPACE_ID = '0b9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e';
export const ADMIN_ID = '1c9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e';
export const URL_ = 'http://127.0.0.1:3100';

interface Directory {
  readonly marker: 'directory';
}

export let projectDir = '';

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'embedded-launcher-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function createLauncherObservations() {
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

  return {
    events,
    sent,
    stdout,
    stderr,
    signals,
    messageListeners,
    disconnectListeners,
    env,
    exited,
    exitCode,
    channel,
  };
}

function launcherDatabase(events: string[]): Promise<LauncherDatabaseRoot<Directory>> {
  return Promise.resolve({
    directory: { marker: 'directory' },
    resolveMembership: (email: string, slug: string) => {
      events.push(`resolveMembership:${email}:${slug}`);
      return Promise.resolve({ workspaceId: WORKSPACE_ID, userId: ADMIN_ID, role: 'owner' });
    },
    close: () => {
      events.push('root.close');
      return Promise.resolve();
    },
  });
}

function launcherCredential(
  events: string[],
): ReturnType<LocalLauncherDeps<Directory>['issueLocalCredential']> {
  return Promise.resolve({
    token: TOKEN,
    expiresAt: new Date('2026-10-03T00:00:00.000Z'),
    revoke: () => {
      events.push('revoke');
      return Promise.resolve('revoked' as const);
    },
  });
}

function createLauncherDependencies(
  observations: ReturnType<typeof createLauncherObservations>,
  overrides: Partial<LocalLauncherDeps<Directory>>,
): LocalLauncherDeps<Directory> {
  const { events, stdout, stderr, env, signals, channel, exited } = observations;
  return {
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
    openDatabaseRoot: () => launcherDatabase(events),
    prepareLocalRuntimeProfile: (workspaceId, root) => {
      events.push(`prepareProfile:${workspaceId}:${root.directory.marker}`);
      return Promise.resolve({ kind: 'created' as const, profile: { driver: 'local' } });
    },
    linkIdentity: (root, identity) => {
      events.push(
        `link:${identity.issuer}:${identity.subject}:${identity.userId}:${root.directory.marker}`,
      );
      return Promise.resolve();
    },
    issueLocalCredential: (input, issueDeps) => {
      events.push(
        `issue:${input.workspaceId}:${input.userId}:${Object.keys(input).length}:${issueDeps.directory.marker}`,
      );
      return launcherCredential(events);
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
}

export function harness(overrides: Partial<LocalLauncherDeps<Directory>> = {}) {
  const observations = createLauncherObservations();
  const {
    events,
    sent,
    stdout,
    stderr,
    signals,
    messageListeners,
    disconnectListeners,
    env,
    exitCode,
  } = observations;
  const deps = createLauncherDependencies(observations, overrides);

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
export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Wait until `condition` holds, polling the event loop. */
export async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!condition()) throw new Error('condition never held');
}

export const WORKSPACE = {
  url: URL_,
  seed: { workspaceId: WORKSPACE_ID, adminUserId: ADMIN_ID },
};
