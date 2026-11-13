import { execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_SESSION_SECRET_LENGTH } from '../apps/web/server/auth/session.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const webDir = path.join(repoRoot, 'apps', 'web');

export const SECRET = 'a'.repeat(MIN_SESSION_SECRET_LENGTH);

function visibleRouteFiles(root: string): ReadonlySet<string> {
  const apiDir = path.join(root, 'app', 'api');
  const inRepo = path.relative(repoRoot, apiDir);
  // A root outside this repository tracks nothing — said here rather than discovered by letting
  // `git ls-files` fail on a path it cannot take. The negative-control test below uses such a root.
  const tracked =
    inRepo.startsWith('..') || path.isAbsolute(inRepo)
      ? []
      : execFileSync('git', ['ls-files', '-z', '--', inRepo.split(path.sep).join('/')], {
          cwd: repoRoot,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        })
          .split('\0')
          .filter((f) => f.length > 0)
          .map((f) => path.resolve(repoRoot, f));
  // Written by this file, at collection time, and removed in `afterAll`. Named rather than
  // pattern-matched: "a fixture" is not a category a walker can recognise, but "the two files
  // this test writes" is a list this test can hold.
  return new Set([...tracked, UNREGISTERED_ROUTE_FILE]);
}

export function discoverApiRouteHandlers(root: string = webDir): readonly string[] {
  const apiDir = path.join(root, 'app', 'api');
  if (!existsSync(apiDir)) return [];
  const visible = visibleRouteFiles(root);
  const found: string[] = [];
  const walk = (dir: string, urlPath: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // A route group `(group)` contributes no URL segment; a dynamic segment gets a literal.
        const segment = /^\(.*\)$/u.test(entry.name)
          ? ''
          : `/${entry.name.replace(/^\[\.{0,3}(.+)\]$/u, 'probe-$1')}`;
        walk(path.join(dir, entry.name), `${urlPath}${segment}`);
      } else {
        // ADR-0015. This used to ask "is the extension one of ts|tsx|js|jsx|mjs?", which is a
        // list, and a list is the thing somebody forgets to add to: `route.mts`, `route.cjs` and
        // any extension a future `pageExtensions` adds would all have fallen through it to the
        // pass path and left a real handler unprobed. Next.js routes exactly one *name* under
        // `app/api` — `route` — so the question asked is the one that has no list in it: is the
        // stem `route`? Everything else contributes nothing, and the bias of being wrong here is
        // toward probing a path that serves nothing, which must answer 401 anyway.
        const stem = entry.name.split('.')[0] ?? '';
        if (stem === 'route' && visible.has(path.join(dir, entry.name))) {
          found.push(urlPath === '' ? '/api' : urlPath);
        }
      }
    }
  };
  walk(apiDir, '/api');
  return [...new Set(found)].sort();
}

const SPEC_34_API_ROUTES: readonly string[] = [
  '/api/agents',
  '/api/agents/probe-id',
  '/api/agents/probe-id/runs',
  '/api/runs/probe-id',
  '/api/runs/probe-id/events',
  '/api/sessions',
  '/api/sessions/probe-id/messages',
  '/api/models',
  '/api/model-connections',
  '/api/skills',
  '/api/connectors',
  '/api/files',
  '/api/users',
  '/api/runtime-profiles',
  '/api/projects',
  '/api/projects/probe-id',
  '/api/shares',
  '/api/shares/probe-id',
];

const UNREGISTERED_API_ROOT = path.join(webDir, 'app', 'api');

const UNREGISTERED_ROUTE_ROOT = path.join(UNREGISTERED_API_ROOT, 'w1cp06-unregistered');

const UNREGISTERED_ROUTE_DIR = path.join(UNREGISTERED_ROUTE_ROOT, 'deep');

export const UNREGISTERED_ROUTE_FILE = path.join(UNREGISTERED_ROUTE_DIR, 'route.ts');

export const UNREGISTERED_ROUTE_PATH = '/api/w1cp06-unregistered/deep';

export const UNREGISTERED_ROUTE_CANARY = 'w1cp06-canary-never-visible-unauthenticated';

const UNREGISTERED_ROUTE_SOURCE = `import { NextResponse } from 'next/server';

import { requireWorkspaceScope } from '@/server/auth';

export async function GET(): Promise<NextResponse> {
  const scope = await requireWorkspaceScope();
  return NextResponse.json({ canary: '${UNREGISTERED_ROUTE_CANARY}', scope });
}

export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
`;

const PUBLIC_APP_ROOT = path.join(webDir, 'app', 'p');

const PUBLIC_ROUTE_DIR = path.join(PUBLIC_APP_ROOT, 'w1cp06-unauthenticated');

const PUBLIC_ROUTE_FILE = path.join(PUBLIC_ROUTE_DIR, 'route.ts');

export const PUBLIC_ROUTE_PATH = '/p/w1cp06-unauthenticated';

export const PUBLIC_ROUTE_MARKER = 'w1cp06-reached-without-a-session';

const PUBLIC_ROUTE_SOURCE = `import { NextResponse } from 'next/server';

export function GET(): NextResponse {
  return NextResponse.json({ reached: '${PUBLIC_ROUTE_MARKER}' });
}

export const POST = GET;
`;

function removeStaleFixtures(): void {
  rmSync(UNREGISTERED_ROUTE_ROOT, { recursive: true, force: true });
  rmSync(PUBLIC_ROUTE_DIR, { recursive: true, force: true });
  if (existsSync(PUBLIC_APP_ROOT) && readdirSync(PUBLIC_APP_ROOT).length === 0) {
    rmSync(PUBLIC_APP_ROOT, { recursive: true, force: true });
  }
}

removeStaleFixtures();

const apiDirPreexisted = existsSync(UNREGISTERED_API_ROOT);

const publicDirPreexisted = existsSync(PUBLIC_APP_ROOT);

function writeUnregisteredRoute(): void {
  mkdirSync(UNREGISTERED_ROUTE_DIR, { recursive: true });
  writeFileSync(UNREGISTERED_ROUTE_FILE, UNREGISTERED_ROUTE_SOURCE, 'utf8');
  mkdirSync(PUBLIC_ROUTE_DIR, { recursive: true });
  writeFileSync(PUBLIC_ROUTE_FILE, PUBLIC_ROUTE_SOURCE, 'utf8');
}

export function removeUnregisteredRoute(): void {
  rmSync(UNREGISTERED_ROUTE_ROOT, { recursive: true, force: true });
  rmSync(PUBLIC_ROUTE_DIR, { recursive: true, force: true });
  // Only if this run created them. W1-CP-04, W1-CP-05 and W5 land real handlers in both.
  if (!apiDirPreexisted) rmSync(UNREGISTERED_API_ROOT, { recursive: true, force: true });
  if (!publicDirPreexisted) rmSync(PUBLIC_APP_ROOT, { recursive: true, force: true });
}

writeUnregisteredRoute();

const UNROUTED_API_PATHS: readonly string[] = [
  '/api',
  '/api/not-a-route',
  '/api/secrets/export',
  '/api/agents/../users',
];

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
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

export function killTree(child: ChildProcess): void {
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

export async function waitForRelease(child: ChildProcess, port: number): Promise<void> {
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

export const STARTUP_TIMEOUT_MS = 180_000;

export const NEXT_DEV_ARTEFACTS = ['AGENTS.md', 'CLAUDE.md'].map((name) => path.join(webDir, name));

export const probes = [
  ...new Set([...discoverApiRouteHandlers(), ...SPEC_34_API_ROUTES, ...UNROUTED_API_PATHS]),
].sort();

const GET_EXEMPT = new Set([
  '/api/setup/runtime-detect',
  '/api/auth/login',
  '/api/auth/workspace',
  '/api/auth/cli-verify',
  // ADR-0120 clause 7: Vercel Cron carries no session; the route checks `CRON_SECRET` itself.
  '/api/cron/retention',
  // ADR-0144 D5: the schedule pass authenticates the same `CRON_SECRET` bearer itself.
  '/api/cron/triggers',
  // Issue #1674: the storage cleanup authenticates the same `CRON_SECRET` bearer itself.
  '/api/cron/storage-cleanup',
  // Issue #1562: the readiness probe a kubelet calls with no credential; it reveals only whether
  // the deployment is ready and, if not, which variable is wrong.
  '/api/readyz',
  // ADR-0135 amendment (#1076): the A2A agent card is public discovery metadata. Only the card is
  // exempt; the JSON-RPC route of the same agent keeps its 401 in the POST probes below.
  '/api/a2a/agents/probe-agentName/.well-known/agent-card.json',
]);

export const INVITATION_ACCEPT_PROBE = '/api/invitations/probe-id/accept';

const POST_EXEMPT = new Set([
  '/api/setup',
  // Issue #1846: the aw-control door verifies a run token itself and refuses anything else.
  '/api/builder/mcp',
  '/api/auth/callback',
  '/api/auth/workspace',
  '/api/auth/cli-device',
  '/api/auth/cli-token',
  // ADR-0161 D3: the ID-token exchange authenticates the endpoint client itself.
  '/api/auth/token-exchange',
  INVITATION_ACCEPT_PROBE,
  // ADR-0144: the secret in the path is the authentication; the route answers 404 without it.
  '/api/triggers/probe-id/fire/probe-secret',
]);

export const protectedGetProbes = probes.filter((pathname) => !GET_EXEMPT.has(pathname));

export const protectedPostProbes = probes.filter((pathname) => !POST_EXEMPT.has(pathname));
