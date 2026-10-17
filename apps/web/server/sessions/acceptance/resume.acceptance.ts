/**
 * W2-CP-07 acceptance — **kill the runtime mid-session, start a fresh one, resume, and the
 * conversation continues.**
 *
 * > ACCEPT (the Wave 2 plan): *"Kill the runtime mid-session, start a fresh one, resume,
 * > and the conversation continues — demonstrated against a real process kill, not a mocked one.
 * > This is plan §10's release blocker."*
 *
 * Everything in this file exists to execute that sentence, and the whole of it is real:
 *
 * ```text
 *   turn 1                          turn 2
 *   ┌──────────────────────┐        ┌──────────────────────┐
 *   │ node (child process) │        │ node (child process) │   a DIFFERENT process:
 *   │  startAgentIn…       │        │  startAgentIn…       │   different pid, spawned after
 *   │  → the Claude adapter│        │  → the Claude adapter│   the first one was killed
 *   │  → query()           │        │  → query({resume})   │
 *   │  → a real model      │        │  → a real model      │
 *   └───────┬──────────────┘        └───────┬──────────────┘
 *           │ sessionStore                  │ sessionStore
 *           ▼                               ▼
 *      apps/runner/src/session-state.ts (the engine-scoped store client, per-run bearer)
 *           │                               │
 *           ▼   POST /api/sessions/…/state-entries   GET …
 *      this test's HTTP server → the real route handlers → InMemorySessionStateStore
 * ```
 *
 * This is the path production takes since ENG-06 (ADR-0071): the runner composes its store with
 * `sessionMirrorDeps` and writes the engine-scoped `/state-*` family, and the public
 * `GET /api/sessions/:id/transcript` a client reads the conversation back through is served from
 * that same store. The legacy `session_transcripts` tables are not on this path at all.
 *
 * Between the two turns the harness does three things, in this order, and each is what makes the
 * demonstration falsifiable rather than decorative:
 *
 *   1. **`taskkill /F /T` (or `SIGKILL`) on the child.** Not `close()`, not an abort, not a
 *      resolved promise — the operating system destroys the process tree while it is holding the
 *      session. The exit code is asserted, so a child that exited *for its own reasons* fails the
 *      test instead of passing it.
 *   2. **Deletes `<CLAUDE_CONFIG_DIR>/projects/<projectKey>/`.** This is the sandbox's own copy
 *      of the transcript — R-01 §6 verified live that a session lives there by default, and spec
 *      §14.9 calls a session that lives *only* there a release blocker. With it gone, the store
 *      is the only surviving copy, so a passing turn 2 cannot be explained by local disk. The
 *      directory removed is one this run created, named by a `projectKey` generated for this run.
 *   3. **Asserts the store holds the turn-1 transcript**, read back through the real
 *      `GET /api/sessions/:id/transcript` route.
 *
 * Turn 2 then asks the model for a reference code that was only ever said in turn 1. The assertion is
 * on the model's own answer.
 *
 * ## Why this is a Vitest file and not a `.mjs` script beside `run-acceptance.mjs`
 *
 * The store and the route handlers are TypeScript under `apps/web`, which has no build output —
 * `next build` produces a server bundle, not importable modules. Vitest transpiles them, so this
 * harness can drive **the real handlers and the real store** rather than a re-implementation. The
 * two child processes are a different matter: they must be separate operating-system processes,
 * and they run the runner's **compiled `dist/`**, so what they exercise is the shipped runner.
 *
 * The child's entry file is written into a temporary directory at run time rather than committed,
 * for the reason `apps/web/server/runs/acceptance/README.md` already gives about its own
 * temporary file: a committed `.mjs` importing `apps/runner/dist/**` would be a tracked file with
 * a module reference into a gitignored directory, which `tests/no-sdk-import.test.ts` refuses by
 * name (ADR-0032 clause 2 — a relative reference that resolves nowhere is a broken link). Its
 * exact bytes are the string literal in {@link driverSource} below, which is the copy that
 * actually runs and therefore the only one that cannot drift.
 *
 * ## What it needs, and what it does NOT run in CI
 *
 * A working model credential. This repository ships none and must not — spec A.11 forbids a
 * provider master credential entering a sandbox and ADR-0021 puts the credential path in Wave 4 —
 * so the run uses whatever the *developer's own* `CLAUDE_CONFIG_DIR` already holds, and the suite
 * refuses to run unless `AW_SESSION_RESUME_ACCEPTANCE=1` is set. CI runs everything else in this
 * directory; this file is the one that costs money and reaches the internet.
 *
 * ```sh
 * pnpm build
 * AW_SESSION_RESUME_ACCEPTANCE=1 npx vitest run --config apps/web/server/sessions/acceptance/vitest.config.mjs
 * ```
 *
 * The `--config` is not a convenience. This file is named `*.acceptance.ts`, which the default
 * `**\/*.{test,spec}.*` include never matches, so `pnpm test` does not collect it — and therefore
 * does not report it as *skipped*, which CI fails the job on. See `vitest.config.mjs` beside it.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createInMemoryWorkspaceScopeResolver,
  type SessionRecord,
  type SessionRepositoryProvider,
} from '@agent-workspace/core/db';

import { listSessions, listTranscriptSubkeys, loadTranscript } from '../api';
import { installSessionApi, resetSessionApi, type SessionPrincipal } from '../environment';
import { InMemoryTranscriptStore } from '../memory-store';
import {
  appendSessionState,
  deleteSessionState,
  getSessionStateBlob,
  listSessionStateEntries,
  listSessionStateStreams,
  putSessionStateBlob,
  replaceSessionState,
} from '../state-api';
import { InMemorySessionStateStore } from '../state-memory-store';

/**
 * The gate, and it is a **refusal** rather than a skip.
 *
 * A run that reaches a real model is opt-in, always. The obvious spelling of that —
 * `describe.skipIf(…)` — is refused by CI's *"No test in the run was skipped"* step, which fails
 * the job on any test that did not execute because *"a skipped test is not a passed test"*. So this
 * file is not collected by `pnpm test` at all (see `vitest.config.mjs` beside it), and when it IS
 * run the environment variable must be set: a harness reached by accident stops with a sentence
 * instead of quietly spending money (ADR-0015 — a check that cannot run fails).
 */
const ENABLE_ENV = 'AW_SESSION_RESUME_ACCEPTANCE';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `apps/web/server/sessions/acceptance` → the repository root. */
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const RUNNER_DIST = path.join(REPO_ROOT, 'apps/runner/dist');

/**
 * The tenant, and therefore the `projectKey`.
 *
 * They are one string on purpose: `apps/web/server/compose/run-request.ts` builds every run’s
 * scope as `{ projectKey: workspaceId, … }`, so a harness that used two different values would
 * be testing a configuration this platform never produces. It is generated per run, because it
 * is also the directory name under `<CLAUDE_CONFIG_DIR>/projects` that the kill step deletes and
 * the harness refuses to delete a name it did not generate.
 *
 * The first attempt at this harness used a fixed workspace id and a separate generated project
 * key. The run failed with 403 project_key_mismatch from the real route, after two real
 * `system/mirror_error` events — which is the §25 check in this task doing its job against a live
 * SDK run. That transcript is quoted in docs/adr/W2-CP-07-the-project-key-is-the-tenant-and-a-mismatch-is-refused.md.
 */
const PROJECT_KEY_PREFIX = 'w2cp07-';
const PROJECT_KEY = `${PROJECT_KEY_PREFIX}${randomBytes(6).toString('hex')}`;
const WORKSPACE_ID = PROJECT_KEY;
const USER_ID = 'c8b1f0de-6a2e-4a1f-9d3b-000000000009';
const PRINCIPAL_ID = '44d596f5-511f-4bbd-8d56-8971e744f143';
const PRINCIPAL: SessionPrincipal = {
  kind: 'user',
  principalId: PRINCIPAL_ID,
  ownerPrincipalId: PRINCIPAL_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  role: 'builder',
};

/**
 * The reference code turn 2 has to recall. Generated per run, so a pass cannot come from a model that
 * has seen this file — the string does not exist anywhere until this process starts.
 */
const REFERENCE_CODE = `ORCHID-${randomBytes(4).toString('hex').toUpperCase()}`;

/**
 * The real config directory, because the SDK reads the developer's credentials out of it.
 *
 * R-01 §7 records the alternative — a temporary `CLAUDE_CONFIG_DIR` — and why it does not apply
 * here: *"If auth comes from files in the real config dir, either copy them across or set
 * `ANTHROPIC_API_KEY` in `env`, otherwise the run fails with `Not logged in`."* This harness does
 * neither: it never reads, copies or prints a credential. It points the run at the config
 * directory that already works and isolates itself inside it with {@link PROJECT_KEY}, which is
 * what `CLAUDE_CODE_PROJECT_DIR_NAME` is for.
 */
const CONFIG_DIR = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(homedir(), '.claude');

const COOKIE_VALUE = `__Host-aw_session=${randomBytes(24).toString('base64url')}`;

/**
 * The per-run bearer the runner presents, as `apps/runner/src/index.ts` reads it off the
 * `RunRequest`'s own `env` (`AW_SESSION_MIRROR_TOKEN`). A real check here too: only this value
 * resolves to the runner principal, and that principal reaches only this run's session.
 */
const RUN_TOKEN = randomBytes(24).toString('base64url');

/**
 * The platform session. Production hands the Agent SDK `sessions.id` as `Options.sessionId`, so the
 * row's id and its engine session id are the same UUID; the harness keeps that shape.
 */
const ENGINE_SESSION_ID = crypto.randomUUID();

interface DriverLine {
  readonly event: string;
  readonly [field: string]: unknown;
}

const temporaryDirectories: string[] = [];

function temporary(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * The child process's entry module.
 *
 * It is the *shipped* runner, composed the way `apps/runner/dist/index.js`'s `main()` composes
 * every run: `sessionMirrorDeps` builds the engine-scoped store client from the container's
 * `AW_SESSION_MIRROR_URL` and the run's own bearer, and `startAgentInThisContainer` loads the
 * engine the request names and hands it that store. Nothing here is a harness-only wiring.
 */
function driverSource(): string {
  const url = (file: string): string =>
    JSON.stringify(pathToFileURL(path.join(RUNNER_DIST, file)).href);
  return [
    `import { readFileSync } from 'node:fs';`,
    `import { runnerBaseEnvironment, sessionMirrorDeps, startAgentInThisContainer } from ${url('index.js')};`,
    ``,
    `const say = (line) => { process.stdout.write(JSON.stringify(line) + '\\n'); };`,
    `const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));`,
    ``,
    `const request = { ...plan.request, env: { AW_SESSION_MIRROR_TOKEN: process.env.AW_SESSION_MIRROR_TOKEN } };`,
    `const context = sessionMirrorDeps(process.env, request.env.AW_SESSION_MIRROR_TOKEN, request.engine);`,
    `const outcome = await startAgentInThisContainer(request, runnerBaseEnvironment(), context);`,
    `if (!outcome.ok) { say({ event: 'fatal', reason: outcome.code + ': ' + outcome.reason }); process.exit(3); }`,
    `const connection = outcome.connection;`,
    `let text = '';`,
    `try {`,
    `  for await (const frame of connection.frames) {`,
    `    if (frame.frame === 'agent.session') say({ event: 'init', sessionId: frame.engineSessionId });`,
    `    if (frame.frame === 'agent.message' && frame.role === 'assistant') {`,
    `      for (const block of frame.blocks) if (block.type === 'text') text += block.text;`,
    `    }`,
    `    if (frame.frame === 'agent.result') say({ event: 'result', stopReason: frame.stopReason });`,
    `  }`,
    `} catch (error) {`,
    `  say({ event: 'threw', message: error instanceof Error ? error.message : String(error) });`,
    `}`,
    `say({ event: 'text', text });`,
    `say({ event: 'durability', verdict: connection.sessionDurability() });`,
    `say({ event: 'done', pid: process.pid });`,
    `if (plan.holdOpen) { setInterval(() => {}, 1000); } else { process.exit(0); }`,
    ``,
  ].join('\n');
}

/** The `RunRequest` for one turn. Everything else about the two turns is identical. */
function runRequestFor(options: {
  cwd: string;
  prompt: string;
  session: { kind: 'fresh'; sessionId: string } | { kind: 'resume'; resume: string };
}): Record<string, unknown> {
  return {
    runId: crypto.randomUUID(),
    // `sessions.id`, which production also hands the SDK as its session id (see ENGINE_SESSION_ID).
    sessionId: ENGINE_SESSION_ID,
    engine: 'claude-agent-sdk',
    cwd: options.cwd,
    prompt: options.prompt,
    agent: {
      name: 'W2-CP-07 acceptance',
      instructions: '',
      model: null,
      permissions: {
        readFiles: false,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      tools: {
        base: [],
        autoApprove: [],
        deny: [],
        permissionMode: 'dontAsk',
        allowDangerouslySkipPermissions: false,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {},
      limits: { maxTurns: 2, maxBudgetUsd: null },
    },
    session: options.session,
    scope: { projectKey: PROJECT_KEY, configDir: CONFIG_DIR },
    // Replaced by the child with `runnerBaseEnvironment()`, which is what the runner does.
    env: {},
  };
}

interface ChildOutcome {
  readonly lines: DriverLine[];
  readonly stderr: string;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Spawn one driver and stream its JSON lines. */
function spawnDriver(driver: string, planFile: string, mirrorUrl: string): ChildOutcome {
  const child = spawn(process.execPath, [driver, planFile], {
    env: {
      ...process.env,
      AW_SESSION_MIRROR_URL: mirrorUrl,
      AW_SESSION_MIRROR_TOKEN: RUN_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const lines: DriverLine[] = [];
  let pending = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    for (;;) {
      const at = pending.indexOf('\n');
      if (at < 0) break;
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (line.trim().length === 0) continue;
      try {
        lines.push(JSON.parse(line) as DriverLine);
      } catch {
        stderr += `[unparsed stdout] ${line}\n`;
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });

  return {
    lines,
    get stderr(): string {
      return stderr;
    },
    child,
    exited,
  };
}

/** Wait until the driver has printed an event of this name, or fail with everything it said. */
async function waitFor(
  outcome: ChildOutcome,
  event: string,
  timeoutMs: number,
): Promise<DriverLine> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = outcome.lines.find((line) => line.event === event);
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `the driver never printed a '${event}' line within ${String(timeoutMs)}ms.\n` +
          `lines: ${JSON.stringify(outcome.lines, null, 2)}\nstderr: ${outcome.stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Kill the child's whole process tree, for real. */
function killTree(child: ChildProcessByStdio<null, Readable, Readable>): void {
  const pid = child.pid;
  if (pid === undefined) throw new Error('the child has no pid, so nothing can be killed');
  if (process.platform === 'win32') {
    // `child.kill('SIGKILL')` maps to TerminateProcess on this process alone, which would leave
    // the SDK's own `claude` subprocess alive and writing. /T is the tree, /F is unconditional.
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  process.kill(-pid, 'SIGKILL');
}

let server: Server;
let mirrorUrl: string;

/** The session row, as the control plane holds it. Pinned to the engine by nothing but the store. */
const SESSION_ROW: SessionRecord = {
  id: ENGINE_SESSION_ID,
  workspaceId: WORKSPACE_ID,
  ownerPrincipalId: PRINCIPAL_ID,
  userId: USER_ID,
  agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: null,
  engineSessionId: ENGINE_SESSION_ID,
  engine: 'claude-agent-sdk',
  agentVersionId: null,
  title: 'W2-CP-07 acceptance',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const SESSION_ROWS: SessionRepositoryProvider = {
  forScope: () => ({
    ensure: () => Promise.resolve({ kind: 'existing', session: SESSION_ROW }),
    get: (id) => Promise.resolve(id === SESSION_ROW.id ? SESSION_ROW : null),
    getByEngineSessionId: (id) =>
      Promise.resolve(id === SESSION_ROW.engineSessionId ? SESSION_ROW : null),
    list: () => Promise.resolve({ items: [SESSION_ROW], nextCursor: null }),
    update: () => Promise.resolve({ kind: 'no-op', session: SESSION_ROW }),
    archive: () => Promise.resolve({ kind: 'no-op', session: SESSION_ROW }),
    restore: () => Promise.resolve({ kind: 'no-op', session: SESSION_ROW }),
  }),
};

const RUNNER_PRINCIPAL: SessionPrincipal = {
  kind: 'runner',
  workspaceId: WORKSPACE_ID,
  runId: crypto.randomUUID(),
  sessionId: ENGINE_SESSION_ID,
};

describe('W2-CP-07 · resume across a real process kill', () => {
  beforeAll(async () => {
    if (process.env[ENABLE_ENV] !== '1') {
      throw new Error(
        `${ENABLE_ENV}=1 is not set. This harness starts real runs against a real model and is ` +
          `never part of \`pnpm test\`; see README.md beside this file for the command that runs it.`,
      );
    }
    if (!existsSync(path.join(RUNNER_DIST, 'runtime.js'))) {
      throw new Error(
        `${RUNNER_DIST} has no compiled runner. Run \`pnpm build\` before this acceptance suite: ` +
          `the two child processes run the SHIPPED runner, not a transpiled copy of its source.`,
      );
    }

    installSessionApi({
      // A real check, not a stub that authenticates everybody: the cookie and the bearer must be
      // the ones this run minted. `apps/web/server/runs/acceptance` records why that matters.
      authenticate: (request: Request): Promise<SessionPrincipal | null> => {
        if (request.headers.get('authorization') === `Bearer ${RUN_TOKEN}`) {
          return Promise.resolve(RUNNER_PRINCIPAL);
        }
        return Promise.resolve(request.headers.get('cookie') === COOKIE_VALUE ? PRINCIPAL : null);
      },
      // The production rule: a runner reaches only the session in its claim; the owner reaches it.
      canAccessSession: (caller, id) =>
        Promise.resolve(
          caller.kind === 'runner' ? caller.sessionId === id : id === ENGINE_SESSION_ID,
        ),
      // The legacy store stays empty: nothing on the production path writes it any more.
      store: new InMemoryTranscriptStore(),
      stateStore: new InMemorySessionStateStore(),
      sessions: SESSION_ROWS,
      scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_ID, slug: WORKSPACE_ID }]),
    });

    server = createServer((incoming, outgoing) => {
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        void (async (): Promise<void> => {
          const body = Buffer.concat(chunks);
          const request = new Request(`http://127.0.0.1${incoming.url ?? '/'}`, {
            ...(incoming.method === undefined ? {} : { method: incoming.method }),
            headers: Object.entries(incoming.headers).flatMap(([name, value]) =>
              typeof value === 'string' ? [[name, value] as [string, string]] : [],
            ),
            ...(body.length === 0 ? {} : { body: new Uint8Array(body) }),
          });
          // The same dispatch the App Router files make, in the same order.
          const segments = url.pathname.split('/').filter((one) => one.length > 0);
          let response: Response;
          if (segments.length === 2 && incoming.method === 'GET') {
            response = await listSessions(request);
          } else if (segments.length === 4 && segments[3] === 'state-entries') {
            const id = segments[2] ?? '';
            response =
              incoming.method === 'POST'
                ? await appendSessionState(request, id)
                : incoming.method === 'PUT'
                  ? await replaceSessionState(request, id)
                  : incoming.method === 'DELETE'
                    ? await deleteSessionState(request, id)
                    : await listSessionStateEntries(request, id);
          } else if (segments.length === 4 && segments[3] === 'state-streams') {
            response = await listSessionStateStreams(request, segments[2] ?? '');
          } else if (segments.length === 4 && segments[3] === 'state-blobs') {
            const id = segments[2] ?? '';
            response =
              incoming.method === 'PUT'
                ? await putSessionStateBlob(request, id)
                : await getSessionStateBlob(request, id);
          } else if (
            segments.length === 4 &&
            segments[3] === 'transcript' &&
            incoming.method === 'GET'
          ) {
            // The public read only: the runner no longer writes `…/transcript`, so a POST here
            // would be a path production does not take, and it answers the harness's 404.
            response = await loadTranscript(request, segments[2] ?? '');
          } else if (segments.length === 4 && segments[3] === 'subkeys') {
            response = await listTranscriptSubkeys(request, segments[2] ?? '');
          } else {
            response = new Response('{"error":{"code":"not_found","message":"no such route"}}', {
              status: 404,
            });
          }
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        })();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('the server did not bind');
    mirrorUrl = `http://127.0.0.1:${String(address.port)}`;
  }, 60_000);

  afterAll(async () => {
    resetSessionApi();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    for (const directory of temporaryDirectories)
      rmSync(directory, { recursive: true, force: true });
    // The local transcript directory this run created, and nothing else — see the guard in the
    // test body for why the name is checked before anything is removed.
    const local = path.join(CONFIG_DIR, 'projects', PROJECT_KEY);
    if (path.basename(local).startsWith(PROJECT_KEY_PREFIX)) {
      rmSync(local, { recursive: true, force: true });
    }
  });

  it('kills the runtime mid-session, starts a fresh one, resumes, and the conversation continues', async () => {
    const workdir = temporary('aw-w2cp07-cwd-');
    const plans = temporary('aw-w2cp07-plan-');
    const driver = path.join(plans, 'driver.mjs');
    writeFileSync(driver, driverSource(), 'utf8');

    // ── Turn 1: a real run, mirrored, then killed while it still holds the session ────────
    const engineSessionId = ENGINE_SESSION_ID;
    const firstPlan = path.join(plans, 'turn-1.json');
    writeFileSync(
      firstPlan,
      JSON.stringify({
        holdOpen: true,
        request: runRequestFor({
          cwd: path.join(workdir, 'workspace'),
          prompt: `For this conversation, our project is codenamed ${REFERENCE_CODE}. Please answer: noted.`,
          session: { kind: 'fresh', sessionId: engineSessionId },
        }),
      }),
      'utf8',
    );

    const first = spawnDriver(driver, firstPlan, mirrorUrl);
    const firstResult = await waitFor(first, 'result', 240_000);
    expect(firstResult['stopReason']).toBe('end_turn');
    const durability = await waitFor(first, 'durability', 30_000);
    // `claude.ts` answers `durable: true` only because a store was supplied, its appends were
    // observed to resolve, no batch was dropped, and the stream reached a result.
    const verdict = durability['verdict'] as { durable: boolean; reason?: string };
    // Compared as a sentence first, so a refusal REPORTS its reason instead of printing 'false'.
    expect(verdict.reason ?? '(the run was durable)').toBe('(the run was durable)');
    expect(verdict.durable).toBe(true);
    await waitFor(first, 'done', 30_000);

    // The store — not the process, and not the sandbox — now holds the conversation. Read back
    // over HTTP through the PUBLIC read (`aw.sessions.transcript.read()`), which ENG-06 serves from
    // the engine-scoped store the runner wrote, so what is asserted is the API's answer and not a
    // direct call to the store behind it.
    const readBack = await fetch(
      `${mirrorUrl}/api/sessions/${engineSessionId}/transcript?projectKey=${PROJECT_KEY}`,
      { headers: { cookie: COOKIE_VALUE } },
    );
    expect(readBack.status).toBe(200);
    const transcript = (await readBack.json()) as { entries: unknown[] };
    expect(JSON.stringify(transcript.entries)).toContain(REFERENCE_CODE);

    // …and the session is listed as resumable for this tenant, through GET /api/sessions.
    const listed = await fetch(`${mirrorUrl}/api/sessions`, { headers: { cookie: COOKIE_VALUE } });
    const listing = (await listed.json()) as { sessions: Array<{ engineSessionId: string }> };
    expect(listing.sessions.map((one) => one.engineSessionId)).toContain(engineSessionId);

    // The same read with no cookie is refused, so the 200 above is an authenticated answer
    // rather than an open endpoint that happens to have been given a cookie.
    const anonymous = await fetch(
      `${mirrorUrl}/api/sessions/${engineSessionId}/transcript?projectKey=${PROJECT_KEY}`,
    );
    expect(anonymous.status).toBe(401);

    const mirrored = transcript.entries;

    // ── The kill. A real one. ────────────────────────────────────────────────────────────
    killTree(first.child);
    const exit = await first.exited;
    // A child that exited on its own would make everything after this meaningless, so the
    // manner of its death is asserted rather than assumed.
    expect(exit.code === 0 && exit.signal === null).toBe(false);

    // ── Destroy the sandbox's own copy of the transcript ─────────────────────────────────
    const localProjects = path.join(CONFIG_DIR, 'projects', PROJECT_KEY);
    expect(path.basename(localProjects).startsWith(PROJECT_KEY_PREFIX)).toBe(true);
    rmSync(localProjects, { recursive: true, force: true });
    expect(existsSync(localProjects)).toBe(false);
    // R-01 §6: without this the SDK could resume from disk and the store would prove nothing.

    // ── Turn 2: a DIFFERENT process, resuming from the store alone ───────────────────────
    const secondPlan = path.join(plans, 'turn-2.json');
    writeFileSync(
      secondPlan,
      JSON.stringify({
        holdOpen: false,
        request: runRequestFor({
          cwd: path.join(workdir, 'workspace'),
          prompt: 'Remind me, what is the codename of our project in this conversation?',
          session: { kind: 'resume', resume: engineSessionId },
        }),
      }),
      'utf8',
    );

    const second = spawnDriver(driver, secondPlan, mirrorUrl);
    const secondResult = await waitFor(second, 'result', 240_000);
    const answer = await waitFor(second, 'text', 30_000);
    await second.exited;

    expect(second.child.pid).not.toBe(first.child.pid);
    expect(secondResult['stopReason']).toBe('end_turn');
    // The assertion the acceptance criterion is: a fresh process, resuming from state that
    // existed only in the control plane's store, produced a fact that was stated only in the
    // conversation the killed process was holding.
    expect(String(answer['text'])).toContain(REFERENCE_CODE);

    console.log(
      `W2-CP-07 RESULT ${JSON.stringify({
        referenceCode: REFERENCE_CODE,
        engineSessionId,
        projectKey: PROJECT_KEY,
        turn1: { pid: first.child.pid, exit, durability: durability['verdict'] },
        storedEntries: mirrored.length,
        localTranscriptDeleted: localProjects,
        turn2: {
          pid: second.child.pid,
          answer: answer['text'],
          result: secondResult['stopReason'],
        },
      })}`,
    );
  }, 600_000);
});
