/* global AbortSignal, fetch */
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { consumerEnvironment, runInConsumer, runtimeEnvironment } from './consumer-process.mjs';

/** How long the embedded runtime may take to send `ready` and then `credential`. */
const BOOT_TIMEOUT_MS = 240_000;
/** How long the embedded runtime may take to exit after SIGINT. */
const STOP_TIMEOUT_MS = 60_000;
/** The embedded PostgreSQL port the launcher always uses (ADR-0109). */
const EMBEDDED_DATABASE_PORT = 25432;

/**
 * @typedef {{ type: 'ready', url: string, contractsVersion: string }
 *   | { type: 'credential', token: string, expiresAt: string, workspaceId: string, workspaceSlug: string }
 *   | { type: 'failed', message: string }} ChildMessage
 * @typedef {{ kind: 'launch', path: string }
 *   | { kind: 'checked', id: number, valid: true, message: ChildMessage }
 *   | { kind: 'checked', id: number, valid: false }} CheckerReply
 */

/**
 * The message checker the boot smoke forks inside its consumer. It imports
 * `LocalRuntimeChildMessageSchema` from the installed `@indx-workspace/contracts` tarball and
 * resolves `@indx-workspace/embedded/launch`, so both are found by Node's own resolution from the
 * consumer (`aw dev` reads the same `./launch` export from the installed `package.json`,
 * ADR-0109). It is written into the consumer as text, like `resolve.mjs`: a resolver built here on
 * a computed path would be a module reference the §42 boundary gate (tests/no-sdk-import.test.ts,
 * ADR-0031) cannot decide, and it refuses one.
 */
const BOOT_CHECKER_SOURCE = `import { createRequire } from 'node:module';
import process from 'node:process';
import { LocalRuntimeChildMessageSchema } from '@indx-workspace/contracts/local-runtime';

const require = createRequire(import.meta.url);
process.send({ kind: 'launch', path: require.resolve('@indx-workspace/embedded/launch') });
process.on('message', ({ id, message }) => {
  const parsed = LocalRuntimeChildMessageSchema.safeParse(message);
  process.send(
    parsed.success
      ? { kind: 'checked', id, valid: true, message: parsed.data }
      : { kind: 'checked', id, valid: false },
  );
});
`;

/**
 * Whether a message from the checker has the shape {@link BOOT_CHECKER_SOURCE} sends. The message
 * of a valid reply has already passed the installed contracts' schema.
 * @param {unknown} value
 * @returns {value is CheckerReply}
 */
function isCheckerReply(value) {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  if (value.kind === 'launch') return 'path' in value && typeof value.path === 'string';
  return (
    value.kind === 'checked' &&
    'id' in value &&
    typeof value.id === 'number' &&
    'valid' in value &&
    typeof value.valid === 'boolean' &&
    (value.valid === false ||
      ('message' in value && typeof value.message === 'object' && value.message !== null))
  );
}

/** Distinct free loopback ports, held open together so no two are the same. */
async function freePorts(/** @type {number} */ count) {
  /** @type {import('node:net').Server[]} */
  const servers = [];
  try {
    /** @type {number[]} */
    const ports = [];
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(undefined));
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no loopback port');
      ports.push(address.port);
    }
    return ports;
  } finally {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))),
    );
  }
}

/**
 * Boot the embedded runtime from its tarball, as `aw dev` starts it, and use it: a consumer
 * installs `@indx-workspace/embedded` and `@indx-workspace/contracts` without install scripts,
 * rebuilds the `@embedded-postgres/*` binary packages by name, and forks the resolved
 * `@indx-workspace/embedded/launch`. Every message must pass the installed contracts'
 * `LocalRuntimeChildMessageSchema`, so the published protocol is proved across two published
 * packages; `ready` and then `credential` must arrive, `GET /api/me` with the credential must answer
 * 200, and SIGINT (on Windows, closing the IPC channel) must end the runtime with exit code 0. The
 * token is never printed: it is redacted from every failure message.
 * @param {ReadonlyArray<{ tarball: string, manifest: Record<string, unknown> }>} packed
 * @param {string} version
 */
/**
 * @param {string} consumer
 * @param {ReadonlyArray<{ tarball: string, manifest: Record<string, unknown> }>} packed
 */
async function installBootConsumer(consumer, packed) {
  /** @type {Record<string, string>} */
  const overrides = {};
  for (const { tarball, manifest } of packed) {
    const relative = path.relative(consumer, tarball).split(path.sep).join('/');
    overrides[String(manifest['name'])] = `file:${relative}`;
  }
  /** @type {Record<string, string>} */
  const dependencies = {};
  for (const name of ['@indx-workspace/embedded', '@indx-workspace/contracts']) {
    const specifier = overrides[name];
    if (specifier === undefined) throw new Error(`the boot smoke needs the ${name} tarball`);
    dependencies[name] = specifier;
  }
  await writeFile(
    path.join(consumer, 'package.json'),
    JSON.stringify({
      name: 'boot-consumer',
      private: true,
      type: 'module',
      dependencies,
      overrides,
    }),
  );
  runInConsumer('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], consumer);
  const binaries = path.join(consumer, 'node_modules', '@embedded-postgres');
  const platformPackages = existsSync(binaries)
    ? (await readdir(binaries, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => `@embedded-postgres/${entry.name}`)
    : [];
  if (platformPackages.length === 0) {
    throw new Error(
      'the boot smoke installed no @embedded-postgres/* package for this platform: the embedded runtime has no PostgreSQL binary',
    );
  }
  runInConsumer('npm', ['rebuild', ...platformPackages], consumer);
}

/** @param {Set<() => void>} waiters */
function bootWaiter(waiters) {
  /** @param {() => boolean} condition @param {number} timeoutMs @param {string} what */
  return (condition, timeoutMs, what) =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (!condition()) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(undefined);
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`));
      }, timeoutMs);
      waiters.add(check);
      check();
    });
}

/** @param {string} consumer */
async function createBootMessageChecker(consumer) {
  /** @type {ChildMessage[]} */
  const messages = [];
  let invalidMessages = 0;
  let checkerOutput = '';
  /** @type {string | undefined} */
  let checkerGone;
  /** @type {Set<() => void>} */
  const waiters = new Set();
  const notify = () => {
    for (const waiter of waiters) waiter();
  };

  const checkerFile = path.join(consumer, 'check-messages.mjs');
  await writeFile(checkerFile, BOOT_CHECKER_SOURCE);
  const messageChecker = fork(checkerFile, [], {
    cwd: consumer,
    env: consumerEnvironment(process.env),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  messageChecker.stdout?.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
    checkerOutput += chunk;
  });
  messageChecker.stderr?.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
    checkerOutput += chunk;
  });
  /** @type {(path: string) => void} */
  let launchResolved = () => undefined;
  /** @type {Promise<string>} */
  const launchPath = new Promise((resolve) => {
    launchResolved = resolve;
  });
  messageChecker.on('message', (/** @type {unknown} */ reply) => {
    if (!isCheckerReply(reply)) {
      checkerGone = `the message checker sent ${JSON.stringify(reply).slice(0, 200)}`;
    } else if (reply.kind === 'launch') {
      launchResolved(reply.path);
    } else if (reply.valid) {
      messages.push(reply.message);
    } else {
      invalidMessages += 1;
    }
    notify();
  });
  messageChecker.once('exit', (code, signal) => {
    checkerGone ??=
      `the message checker exited ${JSON.stringify({ code, signal })}: ` +
      checkerOutput.slice(-2000);
    notify();
  });
  const launch = Promise.race([
    launchPath,
    new Promise((/** @type {(path: string) => void} */ _resolve, reject) => {
      const failed = () => {
        if (checkerGone === undefined) return;
        waiters.delete(failed);
        reject(new Error(`boot smoke: ${checkerGone}`));
      };
      waiters.add(failed);
      failed();
    }),
  ]);

  return {
    checker: messageChecker,
    messages,
    waiters,
    notify,
    launch,
    get invalidMessages() {
      return invalidMessages;
    },
    get checkerGone() {
      return checkerGone;
    },
  };
}

/**
 * @typedef {{
 *   messages: ChildMessage[],
 *   until: ReturnType<typeof bootWaiter>,
 *   settled: () => boolean,
 *   remaining: () => number,
 *   refuseFailures: () => void,
 *   refuse: (reason: string) => Error,
 * }} BootProtocol
 */

/** @param {BootProtocol} protocol @param {string} version */
async function waitForReady(protocol, version) {
  const { until, settled, messages, remaining, refuseFailures, refuse } = protocol;
  await until(() => settled() || messages.length >= 1, remaining(), 'ready');
  refuseFailures();
  const [ready] = messages;
  if (ready?.type !== 'ready') {
    throw refuse(`expected ready first, got [${messages.map(({ type }) => type).join(', ')}]`);
  }
  if (ready.contractsVersion !== version) {
    throw refuse(`the runtime reports contracts ${ready.contractsVersion}, not ${version}`);
  }

  return ready;
}

/** @param {BootProtocol} protocol */
async function waitForCredential(protocol) {
  const { until, settled, messages, remaining, refuseFailures, refuse } = protocol;
  await until(() => settled() || messages.length >= 2, remaining(), 'credential');
  refuseFailures();
  const credential = messages[1];
  if (credential?.type !== 'credential') {
    throw refuse(
      `expected credential after ready, got [${messages.map(({ type }) => type).join(', ')}]`,
    );
  }

  return credential;
}

/** @param {string} url @param {string} token @param {(reason: string) => Error} refuse */
async function verifyBootIdentity(url, token, refuse) {
  const response = await fetch(new URL('/api/me', url), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (response.status !== 200) {
    throw refuse(
      `GET /api/me answered ${String(response.status)}: ${body.slice(0, 500).split(token).join('[token]')}`,
    );
  }
  process.stderr.write('smoke: /api/me 200\n');
}

/**
 * @param {ReadonlyArray<{ tarball: string, manifest: Record<string, unknown> }>} packed
 * @param {string} version
 */
export async function bootSmoke(packed, version) {
  const consumer = await mkdtemp(path.join(tmpdir(), 'indx-workspace-boot-'));
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let checker;
  /** @type {Promise<void>} */
  let exited = Promise.resolve();
  /** @type {{ code: number | null, signal: string | null } | null} */
  let exit = null;
  try {
    await installBootConsumer(consumer, packed);

    const observed = await createBootMessageChecker(consumer);
    const { messages, waiters, notify, checker: messageChecker } = observed;
    checker = messageChecker;
    let output = '';
    /** @type {Error | undefined} */
    let spawnError;
    const launch = await observed.launch;
    if (typeof launch !== 'string') throw new Error('boot smoke: no launch module was resolved');
    const [gateway = 0, runner = 0, web = 0] = await freePorts(3);
    let nextCheck = 0;
    const until = bootWaiter(waiters);

    const runtime = fork(launch, [], {
      cwd: consumer,
      env: runtimeEnvironment(process.env, { gateway, runner }),
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    child = runtime;
    runtime.stdout?.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
      output += chunk;
    });
    runtime.stderr?.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
      output += chunk;
    });
    // IPC keeps order in both directions, so the checker's replies arrive in the order the runtime
    // sent the messages they check.
    runtime.on('message', (/** @type {unknown} */ message) => {
      nextCheck += 1;
      messageChecker.send({ id: nextCheck, message });
    });
    runtime.on('error', (error) => {
      spawnError = error;
      notify();
    });
    exited = new Promise((resolve) => {
      runtime.once('exit', (code, signal) => {
        exit = { code, signal };
        notify();
        resolve();
      });
    });

    /** @type {string | undefined} */
    let token;
    /** What the runtime printed, the token redacted, for a failure message. */
    const printed = () => {
      const tail = output.slice(-4000);
      return token === undefined ? tail : tail.split(token).join('[token]');
    };
    const refuse = (/** @type {string} */ reason) =>
      new Error(
        `boot smoke: ${reason}` +
          (exit === null ? '' : `; the runtime exited ${JSON.stringify(exit)}`) +
          `\n${printed()}`,
      );
    // An exit counts once every message sent before it has been checked, so a `failed` the runtime
    // sent just before exiting is reported rather than the bare exit.
    const checked = () => messages.length + observed.invalidMessages === nextCheck;
    const settled = () =>
      observed.invalidMessages > 0 ||
      (exit !== null && checked()) ||
      spawnError !== undefined ||
      observed.checkerGone !== undefined;
    const refuseFailures = () => {
      if (spawnError !== undefined)
        throw refuse(`the runtime did not start: ${spawnError.message}`);
      if (observed.checkerGone !== undefined) throw refuse(observed.checkerGone);
      if (observed.invalidMessages > 0) {
        throw refuse('the runtime sent a message LocalRuntimeChildMessageSchema refuses');
      }
      const failed = messages.find((message) => message.type === 'failed');
      if (failed?.type === 'failed') {
        const collision = failed.message.includes(String(EMBEDDED_DATABASE_PORT))
          ? ` The embedded PostgreSQL port ${String(EMBEDDED_DATABASE_PORT)} is taken: stop the ` +
            'other embedded runtime on this host (pnpm start:embedded, aw dev) and run again.'
          : '';
        throw refuse(`the runtime sent failed: ${failed.message}.${collision}`);
      }
    };

    const start = {
      type: 'start',
      projectDir: consumer,
      environment: { port: web, runtimeDriver: 'local', bootstrapAdmin: 'admin@localhost.test' },
    };
    await new Promise((resolve, reject) => {
      runtime.send(start, (error) => (error === null ? resolve(undefined) : reject(error)));
    });

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    const remaining = () => Math.max(0, deadline - Date.now());
    const protocol = { messages, until, settled, remaining, refuseFailures, refuse };
    const ready = await waitForReady(protocol, version);
    process.stderr.write('smoke: embedded ready\n');
    const credential = await waitForCredential(protocol);
    token = credential.token;
    process.stderr.write('smoke: credential received\n');
    await verifyBootIdentity(ready.url, token, refuse);

    // Windows cannot deliver SIGINT to a child (`kill` terminates it outright), so there the IPC
    // channel is closed instead, the other shutdown trigger the launcher handles the same way.
    if (process.platform === 'win32') runtime.disconnect();
    else runtime.kill('SIGINT');
    try {
      await until(() => exit !== null, STOP_TIMEOUT_MS, 'the runtime to exit after SIGINT');
    } catch (error) {
      runtime.kill('SIGKILL');
      throw refuse(error instanceof Error ? error.message : String(error));
    }
    const stopped = /** @type {{ code: number | null, signal: string | null } | null} */ (exit);
    if (stopped?.code !== 0) throw refuse('the runtime did not exit 0 after SIGINT');
  } finally {
    if (child !== undefined && exit === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    }
    if (checker !== undefined && checker.exitCode === null && checker.signalCode === null) {
      const checkerExited = new Promise((resolve) => checker?.once('exit', resolve));
      checker.kill('SIGKILL');
      await Promise.race([checkerExited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    }
    await rm(consumer, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  }
}
