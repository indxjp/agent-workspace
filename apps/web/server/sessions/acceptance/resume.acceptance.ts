/**
 * Live resume acceptance: a real killed process, its local transcript removed, and a fresh process
 * recalling a fact available only from mirrored session state. Public reads must authenticate.
 * Opt-in instructions and prerequisites are in README.md beside this harness.
 */
import { clearApplicationContext } from '../../application-context';
import { installTestDomains } from '../../application-context-fixtures';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionApiPrincipal } from '../environment';
import { InMemoryTranscriptStore } from '../memory-store';
import type { SessionRecord, SessionsStoreProvider } from '../store';
import { InMemorySessionStateStore } from '../state-memory-store';

import { z } from 'zod';

import {
  driverSource,
  killTree,
  spawnDriver,
  waitFor,
  type ChildOutcome,
} from './resume-driver.acceptance-support';
import { createSessionMirrorServer } from './resume-http.acceptance-support';

const ENABLE_ENV = 'AW_SESSION_RESUME_ACCEPTANCE';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const RUNNER_DIST = path.join(REPO_ROOT, 'apps/runner/dist');

const PROJECT_KEY_PREFIX = 'w2cp07-';
const PROJECT_KEY = `${PROJECT_KEY_PREFIX}${randomBytes(6).toString('hex')}`;
// The mirror's tenant key must match the runner's project key.
const WORKSPACE_ID = PROJECT_KEY;
const USER_ID = 'c8b1f0de-6a2e-4a1f-9d3b-000000000009';
const PRINCIPAL_ID = '44d596f5-511f-4bbd-8d56-8971e744f143';
const PRINCIPAL: SessionApiPrincipal = {
  kind: 'user',
  principalId: PRINCIPAL_ID,
  ownerPrincipalId: PRINCIPAL_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  role: 'builder',
};

const REFERENCE_CODE = `ORCHID-${randomBytes(4).toString('hex').toUpperCase()}`;

// Use existing developer credentials without reading, copying or printing them.
const CONFIG_DIR = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(homedir(), '.claude');

const COOKIE_VALUE = `__Host-aw_session=${randomBytes(24).toString('base64url')}`;

const RUN_TOKEN = randomBytes(24).toString('base64url');

const ENGINE_SESSION_ID = crypto.randomUUID();

const temporaryDirectories: string[] = [];

function temporary(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
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

let server: Server;
let mirrorUrl: string;

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

const SESSION_ROWS: SessionsStoreProvider = {
  forWorkspaceId: (workspaceId) =>
    Promise.resolve(
      workspaceId !== WORKSPACE_ID
        ? null
        : {
            get: (id) => Promise.resolve(id === SESSION_ROW.id ? SESSION_ROW : null),
            getByEngineSessionId: (id) =>
              Promise.resolve(id === SESSION_ROW.engineSessionId ? SESSION_ROW : null),
            list: () => Promise.resolve({ items: [SESSION_ROW], nextCursor: null }),
            update: () => Promise.resolve({ kind: 'no-op', session: SESSION_ROW }),
            archive: () => Promise.resolve({ kind: 'no-op', session: SESSION_ROW }),
            restore: () => Promise.resolve({ kind: 'no-op', session: SESSION_ROW }),
          },
    ),
};

const RUNNER_PRINCIPAL: SessionApiPrincipal = {
  kind: 'runner',
  workspaceId: WORKSPACE_ID,
  runId: crypto.randomUUID(),
  sessionId: ENGINE_SESSION_ID,
};

const durabilityVerdict = z.object({ durable: z.boolean(), reason: z.string().optional() });
const transcriptResponse = z.object({ entries: z.array(z.unknown()) });
const sessionListing = z.object({ sessions: z.array(z.object({ engineSessionId: z.string() })) });

interface ResumeScenario {
  readonly plans: string;
  readonly driver: string;
  readonly workspace: string;
}

function assertAcceptancePrerequisites(): void {
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
}

function installSessionDomain(): void {
  installTestDomains({
    sessions: {
      // A real check, not a stub that authenticates everybody: the cookie and the bearer must be
      // the ones this run minted. `apps/web/server/runs/acceptance` records why that matters.
      authenticate: (request: Request): Promise<SessionApiPrincipal | null> => {
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
    },
  });
}

async function startMirror(): Promise<void> {
  assertAcceptancePrerequisites();
  installSessionDomain();
  server = createSessionMirrorServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind');
  mirrorUrl = `http://127.0.0.1:${String(address.port)}`;
}

async function cleanupHarness(): Promise<void> {
  clearApplicationContext();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  // Remove only the local transcript namespace generated for this run.
  const local = path.join(CONFIG_DIR, 'projects', PROJECT_KEY);
  if (path.basename(local).startsWith(PROJECT_KEY_PREFIX)) {
    rmSync(local, { recursive: true, force: true });
  }
}

function createResumeScenario(): ResumeScenario {
  const workdir = temporary('aw-w2cp07-cwd-');
  const plans = temporary('aw-w2cp07-plan-');
  const driver = path.join(plans, 'driver.mjs');
  writeFileSync(driver, driverSource(RUNNER_DIST), 'utf8');
  return { plans, driver, workspace: path.join(workdir, 'workspace') };
}

function startTurn(
  scenario: ResumeScenario,
  turn: {
    readonly name: string;
    readonly holdOpen: boolean;
    readonly prompt: string;
    readonly session: Parameters<typeof runRequestFor>[0]['session'];
  },
): ChildOutcome {
  const planFile = path.join(scenario.plans, `${turn.name}.json`);
  writeFileSync(
    planFile,
    JSON.stringify({
      holdOpen: turn.holdOpen,
      request: runRequestFor({
        cwd: scenario.workspace,
        prompt: turn.prompt,
        session: turn.session,
      }),
    }),
    'utf8',
  );
  return spawnDriver({ driver: scenario.driver, planFile, mirrorUrl, runToken: RUN_TOKEN });
}

async function runFirstTurn(scenario: ResumeScenario) {
  const first = startTurn(scenario, {
    name: 'turn-1',
    holdOpen: true,
    prompt: `For this conversation, our project is codenamed ${REFERENCE_CODE}. Please answer: noted.`,
    session: { kind: 'fresh', sessionId: ENGINE_SESSION_ID },
  });
  const firstResult = await waitFor(first, 'result', 240_000);
  expect(firstResult['stopReason']).toBe('end_turn');
  const durability = await waitFor(first, 'durability', 30_000);
  const verdict = durabilityVerdict.parse(durability['verdict']);
  expect(verdict.reason ?? '(the run was durable)').toBe('(the run was durable)');
  expect(verdict.durable).toBe(true);
  await waitFor(first, 'done', 30_000);

  return { first, durability };
}

async function assertPublicSessionState(): Promise<unknown[]> {
  const readBack = await fetch(
    `${mirrorUrl}/api/sessions/${ENGINE_SESSION_ID}/transcript?projectKey=${PROJECT_KEY}`,
    { headers: { cookie: COOKIE_VALUE } },
  );
  expect(readBack.status).toBe(200);
  const transcript = transcriptResponse.parse(await readBack.json());
  expect(JSON.stringify(transcript.entries)).toContain(REFERENCE_CODE);

  const listed = await fetch(`${mirrorUrl}/api/sessions`, { headers: { cookie: COOKIE_VALUE } });
  const listing = sessionListing.parse(await listed.json());
  expect(listing.sessions.map((one) => one.engineSessionId)).toContain(ENGINE_SESSION_ID);

  const anonymous = await fetch(
    `${mirrorUrl}/api/sessions/${ENGINE_SESSION_ID}/transcript?projectKey=${PROJECT_KEY}`,
  );
  expect(anonymous.status).toBe(401);

  return transcript.entries;
}

/** A non-clean exit and deletion of this run's local copy make store-only recovery falsifiable. */
async function killAndDiscardLocalState(first: ChildOutcome) {
  killTree(first.child);
  const exit = await first.exited;
  expect(exit.code === 0 && exit.signal === null).toBe(false);

  const localProjects = path.join(CONFIG_DIR, 'projects', PROJECT_KEY);
  expect(path.basename(localProjects).startsWith(PROJECT_KEY_PREFIX)).toBe(true);
  rmSync(localProjects, { recursive: true, force: true });
  expect(existsSync(localProjects)).toBe(false);

  return { exit, localProjects };
}

async function runResumedTurn(scenario: ResumeScenario, first: ChildOutcome) {
  const second = startTurn(scenario, {
    name: 'turn-2',
    holdOpen: false,
    prompt: 'Remind me, what is the codename of our project in this conversation?',
    session: { kind: 'resume', resume: ENGINE_SESSION_ID },
  });
  const secondResult = await waitFor(second, 'result', 240_000);
  const answer = await waitFor(second, 'text', 30_000);
  await second.exited;

  expect(second.child.pid).not.toBe(first.child.pid);
  expect(secondResult['stopReason']).toBe('end_turn');
  expect(String(answer['text'])).toContain(REFERENCE_CODE);

  return { second, secondResult, answer };
}

describe('W2-CP-07 · resume across a real process kill', () => {
  beforeAll(startMirror, 60_000);
  afterAll(cleanupHarness);

  it('kills the runtime mid-session, starts a fresh one, resumes, and the conversation continues', async () => {
    const scenario = createResumeScenario();
    const engineSessionId = ENGINE_SESSION_ID;
    const { first, durability } = await runFirstTurn(scenario);
    const mirrored = await assertPublicSessionState();
    const { exit, localProjects } = await killAndDiscardLocalState(first);
    const { second, secondResult, answer } = await runResumedTurn(scenario, first);
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
