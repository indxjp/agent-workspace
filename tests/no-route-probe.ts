import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  sessionCookieName,
  mintSessionToken,
  newSessionClaims,
} from '../apps/web/server/auth/session.js';
import { readDeclarationFiles, requireString, REPO_ROOT as repoRoot } from './inventory-support.js';
import {
  coreDir,
  PROBE_DATABASE,
  runNode,
  runScript,
  MANAGE_DATABASE,
  probeDatabaseUrl,
} from './no-route-probe-database.js';
import { freePort, killTree, waitForRelease } from './no-route-probe-process.js';

const webDir = path.join(repoRoot, 'apps', 'web');

const SECRET = 'w2-int-01 probe session secret, thirty-two characters and then some';

const ADMIN_EMAIL = 'admin@example.com';

const MASTER_KEY = 'a'.repeat(64);

const RUNNER_URL = 'http://127.0.0.1:9/';

const OIDC_ISSUER_URL = 'http://127.0.0.1:9';

const OIDC_CLIENT_ID = 'no-route-answers-503-probe';

const OIDC_CLIENT_SECRET = 'not-a-real-secret';

const OIDC_REDIRECT_URI = 'http://127.0.0.1:9/api/auth/callback';

export const GAP_OWNERS: readonly string[] = [];

export const GAP_RECORDS: Readonly<Record<string, string>> = {};

export const CLOSED_DEFECT_RECORD =
  'docs/adr/W2-INT-01-the-files-routes-answer-500-because-the-storage-barrel-exports-its-test-contract.md';

const NEXT_DEV_ARTEFACTS = ['AGENTS.md', 'CLAUDE.md'].map((name) => path.join(webDir, name));

export const SESSION_REFUSED_BY_HANDLER: Readonly<Record<string, string>> = {
  'DELETE /api/auth/cli-token':
    'docs/adr/0083-the-cli-signs-a-person-in-with-a-device-flow-and-a-short-lived-user-token.md',
  'POST /api/auth/cli-workspace':
    'docs/adr/0083-the-cli-signs-a-person-in-with-a-device-flow-and-a-short-lived-user-token.md',
  'POST /api/auth/token-exchange':
    'docs/adr/0161-an-app-backend-acts-as-the-signed-in-person-by-token-exchange.md',
  'POST /api/runs/:id/members/mcp': 'docs/adr/0104-a-team-is-a-resource.md',
};

const STARTUP_TIMEOUT_MS = 180_000;

export const PROBE_TIMEOUT_MS = 600_000;

interface Probe {
  readonly method: string;
  readonly path: string;
  readonly owner: string;
}

function concretePath(pattern: string): string {
  return pattern
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '00000000-0000-4000-8000-000000000000' : segment))
    .join('/');
}

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

class RouteProbe {
  private child: ChildProcess | null = null;
  private databaseUrl: string | null = null;
  private base = '';
  private port = 0;
  private cookie = '';
  private readonly temporaryRoots: string[] = [];
  readonly answers = new Map<string, number>();
  readonly routes = declaredRoutes();
  private preexistingArtefacts: readonly string[] = [];
  private prepareDatabase(): string {
    this.preexistingArtefacts = NEXT_DEV_ARTEFACTS.filter((file) => existsSync(file));
    const adminUrl = process.env['TEST_DATABASE_URL'];
    if (adminUrl === undefined || adminUrl.trim() === '') {
      throw new Error(
        'TEST_DATABASE_URL is unset, so this probe has no PostgreSQL to build a deployment ' +
          'against. It fails rather than skipping: the criterion it establishes is the one no ' +
          'track could state, and a green run over a probe that never executed is the defect this ' +
          'programme keeps finding (ADR-0015). .github/workflows/ci.yml provides the service and ' +
          'asserts it is a real PostgreSQL 18 before this runs.',
      );
    }
    runNode(MANAGE_DATABASE, {
      cwd: coreDir,
      env: { ADMIN_URL: adminUrl, PROBE_DB: PROBE_DATABASE, CREATE: '1' },
    });
    this.databaseUrl = probeDatabaseUrl(adminUrl);
    runScript(path.join(coreDir, 'dist', 'db', 'migrate.js'), { DATABASE_URL: this.databaseUrl });
    runScript(path.join(coreDir, 'dist', 'db', 'seed.js'), {
      DATABASE_URL: this.databaseUrl,
      BOOTSTRAP_ADMIN: ADMIN_EMAIL,
    });
    return this.databaseUrl;
  }

  private async probeRoutes() {
    const token = await mintSessionToken(newSessionClaims(ADMIN_EMAIL, 'default'), SECRET);
    this.cookie = `${sessionCookieName(process.env)}=${token}`;

    for (const route of this.routes) {
      const url = `${this.base}${concretePath(route.path)}`;
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(route.method);
      const response = await fetch(url, {
        method: route.method,
        headers: {
          cookie: this.cookie,
          ...(unsafe ? { origin: this.base, 'content-type': 'application/json' } : {}),
        },
        ...(unsafe ? { body: '{}' } : {}),
        redirect: 'manual',
      });
      this.answers.set(`${route.method} ${route.path}`, response.status);
    }
    for (const route of this.routes) {
      const key = `${route.method} ${route.path}`;
      console.log(`  ${String(this.answers.get(key) ?? 0)}  ${key}  (${route.owner})`);
    }
  }

  private launchServer(storage: string, probeUrl: string): () => string {
    const nextBin = [
      path.join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next'),
      path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next'),
    ].find((candidate) => existsSync(candidate));
    if (nextBin === undefined) {
      throw new Error('next is not installed — run `pnpm install` before `pnpm test`');
    }

    this.child = spawn(
      process.execPath,
      [nextBin, 'dev', '--port', String(this.port), '--hostname', '127.0.0.1'],
      {
        cwd: webDir,
        env: {
          ...process.env,
          NEXT_TELEMETRY_DISABLED: '1',
          DATABASE_URL: probeUrl,
          SESSION_SECRET: SECRET,
          BOOTSTRAP_ADMIN: ADMIN_EMAIL,
          BOOTSTRAP_ADMIN_PASSWORD: 'correct horse battery staple',
          MASTER_ENCRYPTION_KEY: MASTER_KEY,
          AW_STORAGE_URL: pathToFileURL(storage).href,
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
    this.child.stdout?.on('data', record);
    this.child.stderr?.on('data', record);

    return () => serverOutput;
  }

  private async waitForStartup(readOutput: () => string): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          `next dev did not answer on ${this.base} within the timeout:\n${readOutput()}`,
        );
      }
      try {
        await fetch(`${this.base}/api/__startup_probe__`, { redirect: 'manual' });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  async start() {
    const probeUrl = this.prepareDatabase();
    const storage = mkdtempSync(path.join(tmpdir(), 'aw-probe-storage-'));
    this.temporaryRoots.push(storage);

    this.port = await freePort();
    this.base = `http://127.0.0.1:${String(this.port)}`;
    const readOutput = this.launchServer(storage, probeUrl);
    await this.waitForStartup(readOutput);
    await this.probeRoutes();
  }

  async stop() {
    if (this.child !== null) {
      killTree(this.child);
      await waitForRelease(this.child, this.port);
    }
    const adminUrl = process.env['TEST_DATABASE_URL'];
    if (this.databaseUrl !== null && adminUrl !== undefined && adminUrl.trim() !== '') {
      runNode(MANAGE_DATABASE, {
        cwd: coreDir,
        env: { ADMIN_URL: adminUrl, PROBE_DB: PROBE_DATABASE, CREATE: '0' },
      });
    }
    for (const root of this.temporaryRoots) rmSync(root, { recursive: true, force: true });
    for (const file of NEXT_DEV_ARTEFACTS) {
      if (!this.preexistingArtefacts.includes(file)) rmSync(file, { force: true });
    }
  }
}

export function createRouteProbe() {
  const probe = new RouteProbe();
  return {
    start: () => probe.start(),
    stop: () => probe.stop(),
    answers: probe.answers,
    routes: probe.routes,
  };
}
