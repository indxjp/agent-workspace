import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe } from 'vitest';
import { API_ROUTES } from '@indx-workspace/contracts/routes';
import { pathPattern } from '../apps/web/server/auth/api-key-routes.js';
import { mintSessionToken, newSessionClaims } from '../apps/web/server/auth/session.js';
import {
  repoRoot,
  webDir,
  SECRET,
  removeUnregisteredRoute,
  freePort,
  killTree,
  waitForRelease,
  STARTUP_TIMEOUT_MS,
  NEXT_DEV_ARTEFACTS,
  probes,
} from './auth-server-fixtures.js';
import { registerSurfaceProbes } from './auth-server-surface.js';
import { registerSignInProbes } from './auth-server-signin.js';
import { registerCredentialProbes } from './auth-server-credentials.js';
import { registerFixtureProbes } from './auth-server-unregistered.js';

describe('the running server refuses every /api/** request without a session', () => {
  let child: ChildProcess | null = null;

  let base = '';

  let port = 0;

  let token = '';

  let preexistingArtefacts: readonly string[] = [];

  beforeAll(async () => {
    preexistingArtefacts = NEXT_DEV_ARTEFACTS.filter((file) => existsSync(file));
    port = await freePort();
    base = `http://127.0.0.1:${String(port)}`;
    // `next` is a dependency of apps/web, so pnpm installs it under apps/web/node_modules; the
    // repository root has no copy. Both are checked rather than one being assumed, and a miss is
    // an error rather than a spawn of something that is not there.
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
          SESSION_SECRET: SECRET,
          BOOTSTRAP_ADMIN: 'admin@example.com',
          BOOTSTRAP_ADMIN_PASSWORD: 'correct horse battery staple',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Process-group leader on POSIX so killTree can signal the whole tree, `next-server`
        // grandchild included, in one call; meaningless (and left off) on win32, where
        // `taskkill /T` walks the tree by parent pid instead.
        detached: process.platform !== 'win32',
      },
    );
    // Kept, not discarded: when the server fails to start, its own output is the only thing that
    // says why, and a timeout with no explanation is the least useful failure a gate can produce.
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

    // `next dev` compiles a route handler on its first request. The proxy answers almost every
    // probe below itself, but it forwards the ADR-0135 endpoint-credential routes (the A2A
    // JSON-RPC and agent-card routes) to their handler, which authenticates its own caller. The
    // first hit on that handler compiles the run API it imports, and in CI that compile alone
    // outran the 5 s probe timeout (#1005). Compiling them here, inside the startup budget, keeps
    // the probes measuring the gate rather than the compiler; nothing is asserted on these hits,
    // and every probe still asserts its own 401.
    // The routes are read from the catalogue as `agent-endpoint-routes.ts` does; that module is not
    // imported because its extensionless sibling import is not a standalone ES module (W1-CP-06).
    for (const route of API_ROUTES.filter((r) => r.security === 'endpoint-credential')) {
      const pattern = pathPattern(route.path);
      for (const pathname of probes.filter((probe) => pattern.test(probe))) {
        const warm = await fetch(`${base}${pathname}`, {
          method: route.method,
          redirect: 'manual',
        });
        await warm.arrayBuffer();
      }
    }

    token = await mintSessionToken(newSessionClaims('admin@example.com', 'default'), SECRET);
  }, STARTUP_TIMEOUT_MS + 30_000);

  afterAll(async () => {
    if (child !== null) {
      killTree(child);
      await waitForRelease(child, port);
    }
    for (const file of NEXT_DEV_ARTEFACTS) {
      if (!preexistingArtefacts.includes(file) && existsSync(file)) rmSync(file, { force: true });
    }
    removeUnregisteredRoute();
  });

  const server = {
    get base() {
      return base;
    },
    get token() {
      return token;
    },
  };

  registerSurfaceProbes(server);

  registerSignInProbes(server);

  registerCredentialProbes(server);

  registerFixtureProbes(server);
});
