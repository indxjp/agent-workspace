/**
 * The criterion no track could state: **every route the sub-wave shipped answers something other
 * than 503 in a deployment built from this branch** — asserted by driving each declared route
 * against a real server, never by reading `apps/web/instrumentation.ts` and believing it.
 *
 * [ADR-0038](../docs/adr/0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md)
 * is the record of why this file exists. Four backend tracks shipped four subsystems, each with a
 * `configure<X>Runtime` seam and a 503 that fires until something calls it, and no task in the
 * sub-wave owned a file that could call any of them. So every `/api/secrets/**`, `/api/files*`,
 * RBAC and session route answered 503 in a real deployment while all four tracks' suites were
 * green — because a track's own suite calls its own installer directly, which is exactly the thing
 * a deployment does not do.
 *
 * ## Why the route list is read and not written
 *
 * From `tests/route-declarations/**`, through the same reader `tests/route-inventory.test.ts` and
 * `apps/web/server/rbac/authorisation-matrix.test.ts` use
 * ([ADR-0025](../docs/adr/0025-the-route-inventory-is-partitioned-by-owner.md)). That gate already
 * asserts the union **equals** the route handlers the tracked tree serves — no route missing and
 * no route present that nothing declares — so a route cannot hide from this probe by being
 * undeclared, and a route added tomorrow is probed tomorrow with no edit here. Nothing in this
 * file counts routes and nothing in this file lists them.
 *
 * ## The assertion is an equality, not an absence
 *
 * The obvious shape — "no route answers 503" — is not the shape used, for two reasons.
 *
 * The first is that it is currently false, and saying so is the point. W2-CP-06's nine routes
 * answer 503 because `RbacRuntime` needs a durable `DirectoryRoot` and the only one in the tree is
 * in memory; installing that one would take nine routes off 503 and make every one of them
 * *wrong*, which
 * `docs/adr/W2-INT-01-the-rbac-routes-cannot-leave-503-without-a-durable-directory.md` records at
 * length and [ADR-0035](../docs/adr/0035-an-acceptance-criterion-needing-a-resource-this-deployment-lacks-is-a-declared-gap-not-a-claim.md)
 * forbids reporting as the criterion met.
 *
 * The second is that an equality is a stronger test than an absence. This probe asserts that the
 * routes answering 503 are **exactly** the ones a named, recorded gap accounts for. So it fails if
 * a subsystem silently stops being installed *and* it fails if the recorded gap is closed without
 * the record being updated — and it carries its own control, because the same run, against the
 * same server, shows a 503 being produced by an uninstalled runtime. A probe where every answer
 * came back non-503 could not tell "installed" apart from "the 503 no longer fires".
 *
 * ## What it does not prove, stated rather than implied (ADR-0031)
 *
 * That a route is *correct*. It authenticates with a real session cookie so the request reaches
 * the handler rather than stopping at `middleware.ts`, and then reads the status. A 403, a 404 or
 * a 400 all count as "reached a handler that had an opinion"; what is being measured is that the
 * subsystem behind the route exists in the process, which is the thing that was false for four
 * subsystems at once.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  sessionCookieName,
  mintSessionToken,
  newSessionClaims,
} from '../apps/web/server/auth/session.js';
import { readDeclarationFiles, requireString } from './inventory-support.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(repoRoot, 'apps', 'web');
const coreDir = path.join(repoRoot, 'packages', 'core');

/**
 * The database this probe owns, created and dropped by it.
 *
 * Not `TEST_DATABASE_URL`'s own database: `packages/core/src/db/seed.test.ts` truncates that one,
 * and a suite whose rows another suite may delete mid-request is one scheduling accident away from
 * an intermittent failure that looks like a bug in the application
 * (`packages/core/src/db/repositories/testing.ts`'s header).
 */
const PROBE_DATABASE = 'w2_int_01_no_503';

/**
 * Every database step runs as a **child process**, and none of them is an import.
 *
 * `packages/core/src/db/repositories/database-reachability.test.ts` refuses any specifier from
 * outside `packages/core` that resolves into the database layer — including the relative path a
 * `tests/` file would have to spell, since nothing links `@agent-workspace/core` at the repository
 * root. That gate is right and this probe is not an exception to it: creating a database, applying
 * the migrations and seeding the bootstrap rows are things an *operator* does with the shipped
 * scripts, so they are done here the same way, through `node`. `.github/workflows/ci.yml` reaches
 * `pg` the same way, resolving it from `packages/core` because that package depends on it.
 */
function runNode(script: string, options: { cwd?: string; env?: Record<string, string> }): string {
  return execFileSync(process.execPath, ['-e', script], {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runScript(file: string, env: Record<string, string>): string {
  if (!existsSync(file)) {
    throw new Error(
      `${file} does not exist. packages/core must be built before this probe runs — the wave ` +
        'protocol requires `pnpm build` before `pnpm test`, and .github/workflows/ci.yml has a ' +
        '"Build packages/core" step for the same reason. Refusing to probe a deployment whose ' +
        'database was never migrated.',
    );
  }
  return execFileSync(process.execPath, [file], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** `drop database if exists` then `create database`, through `pg` resolved from packages/core. */
const MANAGE_DATABASE = `
  const { Client } = require('pg');
  const name = process.env.PROBE_DB;
  const client = new Client({ connectionString: process.env.ADMIN_URL });
  client.connect()
    .then(() => client.query('drop database if exists "' + name + '" with (force)'))
    .then(() => (process.env.CREATE === '1' ? client.query('create database "' + name + '"') : null))
    .then(() => client.end())
    .catch((error) => { console.error(error.message); process.exit(1); });
`;

/** The connection string of {@link PROBE_DATABASE} on the server `TEST_DATABASE_URL` names. */
function probeDatabaseUrl(adminUrl: string): string {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${PROBE_DATABASE}`;
  return parsed.toString();
}

/** Long enough for `readSessionSecret`, and not a value any deployment would also hold. */
const SECRET = 'w2-int-01 probe session secret, thirty-two characters and then some';

/** The bootstrap administrator the database is seeded with and the session cookie names. */
const ADMIN_EMAIL = 'admin@example.com';

/** 64 hex characters — `loadMasterKey`'s contract, and `openssl rand -hex 32`'s shape. */
const MASTER_KEY = 'a'.repeat(64);

/**
 * A `RUNNER_URL` that parses and is never dialled.
 *
 * `readRuntimeSettings` installs the run API for any usable URL, and the three run routes then
 * answer 404 for an agent that does not exist — they never reach the launcher. Leaving the
 * variable unset instead would leave the run API uninstalled and put W1-CP-04's routes into the
 * 503 set, which would make this probe's equality a statement about two different gaps at once.
 */
const RUNNER_URL = 'http://127.0.0.1:9/';

/**
 * A generic-OIDC configuration that installs `apps/web/server/auth/oidc.ts`'s real path (issue
 * #118) without dialling anything reachable — port 9 is the same "refuses instantly, never hangs"
 * choice {@link RUNNER_URL} already makes. `GET /api/auth/login` therefore really attempts
 * discovery and fails with a connection error (a 500, never a 503: the OIDC subsystem this
 * variable set installs is not the failure); `POST /api/auth/callback` fails its own transaction-
 * cookie check before ever reaching the network, because this probe sends none.
 */
const OIDC_ISSUER_URL = 'http://127.0.0.1:9';
const OIDC_CLIENT_ID = 'no-route-answers-503-probe';
const OIDC_CLIENT_SECRET = 'not-a-real-secret';
const OIDC_REDIRECT_URI = 'http://127.0.0.1:9/api/auth/callback';

/**
 * The tasks whose routes answer 503, and the record that says why each is not installed.
 *
 * Empty means every declared runtime is installed in the production composition root. A future
 * deliberately unavailable subsystem must add both its owner and a durable gap record here.
 */
const GAP_OWNERS: readonly string[] = [];
const GAP_RECORDS: Readonly<Record<string, string>> = {};

/**
 * The record of the one defect this probe has caught so far, kept as a citation rather than as an
 * expectation.
 *
 * All five `/api/files*` routes answered 500 on this branch until W2-CP-03's `6a3ac24`:
 * `@agent-workspace/core/storage`'s barrel re-exported `contract.ts`, which imports `vitest` at
 * module scope, so the route module threw while being evaluated in a server. This file pinned it
 * as an equality against W2-CP-03's five routes so it could not be reported as a pass — a 500 is
 * "something other than 503", so the acceptance criterion was literally satisfied by five routes
 * that did not work (ADR-0035) — and so it could not be *fixed* silently either. It was not: the
 * equality went red the moment the barrel stopped re-exporting the suite, which is what turned it
 * back into the assertion below.
 */
const CLOSED_DEFECT_RECORD =
  'docs/adr/W2-INT-01-the-files-routes-answer-500-because-the-storage-barrel-exports-its-test-contract.md';

/**
 * `next dev` writes agent-guidance files into the app directory on start-up. They are not in
 * `.gitignore` and they belong to no task, so a run would otherwise leave two untracked files in
 * the working tree — `tests/auth.test.ts` says the same thing about the same two files. Only files
 * this run created are removed; one that was already there is left alone.
 */
const NEXT_DEV_ARTEFACTS = ['AGENTS.md', 'CLAUDE.md'].map((name) => path.join(webDir, name));

/**
 * Routes whose handler — not the proxy — answers a session cookie 401, by design, each with the
 * record that says why. The probe authenticates with a browser session; these routes act on a
 * credential the request itself presents and a browser session is not that credential, so the
 * handler refuses it after the proxy let the session through.
 *
 * Issue #242 (SDK-10, S-22), ADR-0083 §5 and §8: `DELETE /api/auth/cli-token` revokes, and
 * `POST /api/auth/cli-workspace` moves, the very `awu_live_` token `aw login` holds. Neither has a
 * token id in its path, so a browser session names no token to act on (the browser's own
 * workspace switch is `/api/auth/workspace`).
 *
 * Asserted as an equality in the test below, like the 503 gap: a route leaving this list must be
 * removed from it, and no other route may answer 401 to the probe's session.
 */
const SESSION_REFUSED_BY_HANDLER: Readonly<Record<string, string>> = {
  'DELETE /api/auth/cli-token':
    'docs/adr/0083-the-cli-signs-a-person-in-with-a-device-flow-and-a-short-lived-user-token.md',
  'POST /api/auth/cli-workspace':
    'docs/adr/0083-the-cli-signs-a-person-in-with-a-device-flow-and-a-short-lived-user-token.md',
};

const STARTUP_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 600_000;

/** A route as this probe needs it. */
interface Probe {
  readonly method: string;
  readonly path: string;
  readonly owner: string;
}

/**
 * A concrete URL path for a declared pattern.
 *
 * `:param` becomes a UUID, because several handlers validate the shape of an id before they do
 * anything else and a 400 from a validator is a less informative answer than a 404 from a lookup.
 * Either would satisfy this probe; the UUID gets it further into the handler.
 */
function concretePath(pattern: string): string {
  return pattern
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '00000000-0000-4000-8000-000000000000' : segment))
    .join('/');
}

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not obtain a free port'));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** See `tests/auth.test.ts`'s copy: `next dev` forks a grandchild that `child.kill()` misses. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/**
 * `killTree` only SENDS the signal; this waits for the child's `exit` and then for the port it
 * listened on to be bindable again, and prints how long that took. It is the teardown asserting
 * that the resource the next file needs is actually back (ADR-0015), not a fix for a race in
 * Next: when the two `next dev` suites in this project were refused each other's lock in CI
 * (runs 35521409361 / 35521944657 / 35522535672) the cause was a VITEST_MAX_WORKERS exported for
 * every Nx task, which overrides this project's `fileParallelism: false` and ran the two files
 * side by side — see nx.json targetDefaults.test `//workers`. Capped, so a teardown that lost the
 * child cannot hang the run.
 */
async function waitForRelease(child: ChildProcess, port: number): Promise<void> {
  const started = Date.now();
  const deadline = started + 15_000;
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 5_000);
      child.once('exit', done);
    });
  }
  while (Date.now() < deadline) {
    const bindable = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (bindable) {
      console.log(`next dev on :${String(port)} released after ${String(Date.now() - started)} ms`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `next dev on :${String(port)} still holds its port ${String(Date.now() - started)} ms after ` +
      'SIGKILL — the next file in this serial project would be refused its own server',
  );
}

/** Every declared route, read from the tracked tree. Not a list, and not a count. */
function declaredRoutes(): Probe[] {
  return readDeclarationFiles('tests/route-declarations', 'routes').flatMap((file) =>
    file.entries.map((entry, index) => {
      const where = `${file.repoPath} entry ${String(index)}`;
      return {
        method: requireString(entry, 'method', where),
        path: requireString(entry, 'path', where),
        owner: requireString(entry, 'owner', where),
      };
    }),
  );
}

describe('every declared route reaches a handler, and the ones that do not are the declared gap', () => {
  let child: ChildProcess | null = null;
  let databaseUrl: string | null = null;
  let base = '';
  let port = 0;
  let cookie = '';
  const temporaryRoots: string[] = [];
  /** `METHOD /path` → the status the running server answered. Filled once, in `beforeAll`. */
  const answers = new Map<string, number>();
  const routes = declaredRoutes();
  let preexistingArtefacts: readonly string[] = [];

  beforeAll(async () => {
    preexistingArtefacts = NEXT_DEV_ARTEFACTS.filter((file) => existsSync(file));
    // No `skipIf`. A probe that cannot run must fail, or `pnpm test` goes green over the one
    // criterion this whole task exists to establish (ADR-0015). CI provides TEST_DATABASE_URL and
    // its own workflow fails when a test is skipped rather than run.
    const adminUrl = process.env['TEST_DATABASE_URL'];
    if (adminUrl === undefined || adminUrl.trim() === '') {
      throw new Error(
        'TEST_DATABASE_URL is unset, so this probe has no PostgreSQL to build a deployment ' +
          'against. It fails rather than skipping: the criterion it establishes is the one no ' +
          'track could state, and a green run over a probe that never executed is the defect this ' +
          'programme keeps finding (ADR-0015). .github/workflows/ci.yml provides the service and ' +
          'asserts it is a real PostgreSQL 17 before this runs.',
      );
    }
    runNode(MANAGE_DATABASE, {
      cwd: coreDir,
      env: { ADMIN_URL: adminUrl, PROBE_DB: PROBE_DATABASE, CREATE: '1' },
    });
    databaseUrl = probeDatabaseUrl(adminUrl);
    runScript(path.join(coreDir, 'dist', 'db', 'migrate.js'), { DATABASE_URL: databaseUrl });
    // Seeded, not merely migrated. Every route in this application resolves its caller through
    // `resolveMembership`, which reads `workspaces`, `users` and `memberships` and requires all
    // three to agree; against an empty schema every handler answers 401 or 403 before it touches
    // its own subsystem, and a probe reading those statuses would be measuring identity rather
    // than installation. `seed.ts`'s default slug is `default`, which is the workspace the session
    // claims below name.
    runScript(path.join(coreDir, 'dist', 'db', 'seed.js'), {
      DATABASE_URL: databaseUrl,
      BOOTSTRAP_ADMIN: ADMIN_EMAIL,
    });

    const files = mkdtempSync(path.join(tmpdir(), 'aw-probe-files-'));
    const skills = mkdtempSync(path.join(tmpdir(), 'aw-probe-skills-'));
    const sessions = mkdtempSync(path.join(tmpdir(), 'aw-probe-sessions-'));
    temporaryRoots.push(files, skills, sessions);

    port = await freePort();
    base = `http://127.0.0.1:${String(port)}`;
    const nextBin = [
      path.join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next'),
      path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next'),
    ].find((candidate) => existsSync(candidate));
    if (nextBin === undefined) {
      throw new Error('next is not installed — run `pnpm install` before `pnpm test`');
    }

    child = spawn(
      process.execPath,
      [nextBin, 'dev', '--port', String(port), '--hostname', '127.0.0.1'],
      {
        cwd: webDir,
        env: {
          ...process.env,
          NEXT_TELEMETRY_DISABLED: '1',
          // The whole deployment contract this branch reads, and nothing else. Each variable is
          // what makes one subsystem installable; every one of them absent is a documented 503.
          DATABASE_URL: databaseUrl,
          SESSION_SECRET: SECRET,
          BOOTSTRAP_ADMIN: ADMIN_EMAIL,
          BOOTSTRAP_ADMIN_PASSWORD: 'correct horse battery staple',
          MASTER_ENCRYPTION_KEY: MASTER_KEY,
          AW_FILE_STORAGE_ROOT: files,
          AW_SKILL_STORAGE_ROOT: skills,
          AW_SESSION_TRANSCRIPT_ROOT: sessions,
          RUNNER_URL,
          OIDC_ISSUER_URL,
          OIDC_CLIENT_ID,
          OIDC_CLIENT_SECRET,
          OIDC_REDIRECT_URI,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      },
    );
    let serverOutput = '';
    const record = (chunk: Buffer): void => {
      serverOutput += chunk.toString('utf8');
    };
    child.stdout?.on('data', record);
    child.stderr?.on('data', record);

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`next dev did not answer on ${base} within the timeout:\n${serverOutput}`);
      }
      try {
        await fetch(`${base}/api/__startup_probe__`, { redirect: 'manual' });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const token = await mintSessionToken(newSessionClaims(ADMIN_EMAIL, 'default'), SECRET);
    cookie = `${sessionCookieName()}=${token}`;

    for (const route of routes) {
      const url = `${base}${concretePath(route.path)}`;
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(route.method);
      const response = await fetch(url, {
        method: route.method,
        headers: {
          cookie,
          // `middleware.ts` refuses an unsafe method with no `Origin` (403 cross_origin), which
          // would stop the request before any handler — and a probe that never reached a handler
          // would report "not 503" about the middleware rather than about the subsystem.
          ...(unsafe ? { origin: base, 'content-type': 'application/json' } : {}),
        },
        ...(unsafe ? { body: '{}' } : {}),
        redirect: 'manual',
      });
      answers.set(`${route.method} ${route.path}`, response.status);
    }
    // Printed, so the PR body's evidence is this run's own output rather than a transcription
    // (ADR-0016). One line per route, in declaration order.
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      console.log(`  ${String(answers.get(key) ?? 0)}  ${key}  (${route.owner})`);
    }
  }, PROBE_TIMEOUT_MS);

  afterAll(async () => {
    if (child !== null) {
      killTree(child);
      await waitForRelease(child, port);
    }
    const adminUrl = process.env['TEST_DATABASE_URL'];
    if (databaseUrl !== null && adminUrl !== undefined && adminUrl.trim() !== '') {
      runNode(MANAGE_DATABASE, {
        cwd: coreDir,
        env: { ADMIN_URL: adminUrl, PROBE_DB: PROBE_DATABASE, CREATE: '0' },
      });
    }
    for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
    for (const file of NEXT_DEV_ARTEFACTS) {
      if (!preexistingArtefacts.includes(file)) rmSync(file, { force: true });
    }
  }, 120_000);

  it('drove every declared route and got a status for each', () => {
    expect(routes.length).toBeGreaterThan(0);
    const missing = routes
      .map((route) => `${route.method} ${route.path}`)
      .filter((key) => !answers.has(key));
    expect(missing, 'a route the declaration union contains was never driven').toEqual([]);
  });

  it('answers 503 on exactly the routes the declared gap accounts for', () => {
    const unavailable = routes
      .filter((route) => answers.get(`${route.method} ${route.path}`) === 503)
      .map((route) => `${route.method} ${route.path} (${route.owner})`)
      .sort();
    const expected = routes
      .filter((route) => GAP_OWNERS.includes(route.owner))
      .map((route) => `${route.method} ${route.path} (${route.owner})`)
      .sort();
    const owners = GAP_OWNERS.map((owner) => `${owner} (${GAP_RECORDS[owner] ?? ''})`).join(', ');
    expect(
      unavailable,
      `The routes answering 503 must be exactly the declared gap owners' — ${owners}. A route of ` +
        `another task here means its runtime is not installed in apps/web/instrumentation.ts — ` +
        `the whole failure ADR-0038 exists to close. Fewer than a declared owner's own routes ` +
        `means that gap was closed and the record and this expectation have to say so.`,
    ).toEqual(expected);
  });

  it('answers no 5xx other than the 503 a named gap accounts for', () => {
    // The property that was false when this file was written and is true now. A 5xx that is not a
    // 503 means a route module threw rather than declining — the class of defect only a running
    // server can witness, because a route handler driven from inside Vitest has the test runner's
    // whole devDependency tree on its resolution path and a deployment does not.
    //
    // `GET /api/auth/login` (issue #118, W9-AUTH-118) is a documented exception on a different
    // axis than the one above: it is fully wired (`SESSION_SECRET` and every `OIDC_*` variable are
    // present, unlike the composition-root gap this file otherwise probes), and it answers 502 —
    // not 503, not a crash — because this probe's `OIDC_ISSUER_URL` points at a port nothing
    // listens on, so `beginOidcLogin`'s real network discovery genuinely cannot reach it. That is
    // the intended behaviour of a reachable, correctly-installed route whose one external
    // dependency did not answer, proved directly (not just tolerated here) in
    // `apps/web/app/api/auth/login/login.test.ts`'s "answers 502, not a crash" case, which breaks
    // if the `try`/`catch` around `beginOidcLogin` is removed.
    const KNOWN_UPSTREAM_FAILURES = new Set(['GET /api/auth/login → 502']);
    const broken = routes
      .filter((route) => {
        const status = answers.get(`${route.method} ${route.path}`) ?? 0;
        return status >= 500 && status !== 503;
      })
      .map(
        (route) =>
          `${route.method} ${route.path} → ${String(answers.get(`${route.method} ${route.path}`))}`,
      )
      .filter((entry) => !KNOWN_UPSTREAM_FAILURES.has(entry))
      .sort();
    expect(
      broken,
      `A declared route threw instead of answering. The last time this list was non-empty it held ` +
        `all five /api/files* routes, because a runtime barrel re-exported a module that imports ` +
        `vitest — ${CLOSED_DEFECT_RECORD}, closed by W2-CP-03 at 6a3ac24. Read the server's own ` +
        `stack before assuming this one is the same.`,
    ).toEqual([]);
  });

  it('is a real probe — every route produced a concrete non-503 handler response', () => {
    const statuses = [...answers.values()];
    expect(statuses.every((status) => status !== 503)).toBe(true);
    expect(statuses.every((status) => status >= 200 && status < 600)).toBe(true);
  });

  it('reached a handler rather than stopping at the middleware', () => {
    // 401 is `middleware.ts` refusing the cookie and 403 `cross_origin` is it refusing the write.
    // Either on every route would mean this probe measured the middleware, not the subsystems.
    const unauthenticated = routes
      .map((route) => `${route.method} ${route.path}`)
      .filter((key) => answers.get(key) === 401)
      .filter((key) => SESSION_REFUSED_BY_HANDLER[key] === undefined);
    expect(
      unauthenticated,
      'the probe’s session cookie was refused, so these requests never reached a handler and ' +
        'their status says nothing about whether a runtime is installed',
    ).toEqual([]);
  });

  it('answers the probe’s session 401 on exactly the routes that act on a presented credential', () => {
    const declared = Object.keys(SESSION_REFUSED_BY_HANDLER).sort();
    expect(
      declared.filter((key) => answers.get(key) !== 401),
      'a route declared as refusing a session in its handler answered something else — remove it ' +
        'from SESSION_REFUSED_BY_HANDLER and say so in its record',
    ).toEqual([]);
  });
});
