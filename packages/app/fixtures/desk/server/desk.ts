/**
 * The desk fixture's server: the app kit's route handlers on the `./testing` in-memory stores, and
 * an Agent Workspace that is a `fetchDouble` scripted for the J3 journey (issue #1509). It knows
 * one person, answers `GET /api/me` for their token, and runs every agent the same way:
 *
 * 1. a run about a ticket reads it, searches the knowledge base, then waits for approval of
 *    `ticket_update {"assignee":"Net"}`;
 * 2. approving starts the continuation, which writes the assignee as the person through the agent
 *    (`via: 'agent'`, with its run id) and completes;
 * 3. rejecting starts a continuation that completes and changes nothing.
 *
 * Since issue #1514 it also runs the desk's recipe, `triage-incident`, in a recipe runner on the
 * runtime's in-memory recipe store, with the app's own key: the third ticket's creation starts it,
 * and its triage step waits for approval, which the recipe graph decides.
 *
 * Since issue #1519 it seeds the chat room `general`, whose messages the `message` channel
 * carries to the channel page.
 *
 * Since issue #1522 it answers `GET /api/runs` for the dashboard too, filtered by `status` and
 * `from` as the platform's run list is, newest first, in one page; {@link deskStartRunningRun} is
 * the test hook that starts a run outside any ticket, so the journey can watch it appear.
 *
 * Since issue #1521 it keeps a knowledge base of pages, and runs the `writer` agent on a page:
 * the run calls `page_update` as the person through the agent (`via: 'agent'`, with its run id
 * and the `expectedRevisionId` its prompt names), so the rewrite lands as a new revision.
 *
 * Nothing here is reachable from a real deployment: the fixture is built only by
 * `playwright.app-kit.config.mjs`.
 */
import app from '../app.config';
import { DESK_PERSON_ID, DESK_ROOM_TITLE } from '../components/members';
import page from '../resources/page';
import room from '../resources/room';
import ticket from '../resources/ticket';
import { markdownToBlocks, type Person } from '@indx-workspace/app';
import { recipeRunner, type RecipeRunner } from '@indx-workspace/app/server';
import {
  FAKE_WORKSPACE_ID,
  fakePerson,
  setAppRuntimeForTests,
  type MemoryPageStore,
  type MemoryResourceStore,
} from '@indx-workspace/app/testing';
import type { RunResource } from '@indx-workspace/contracts/runs';
import { createClient } from '@indx-workspace/sdk';
import {
  eventStreamResponse,
  fetchDouble,
  fixtures,
  jsonResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';

import {
  APPROVED_ASSIGNEE,
  ASSIGN_TO_NET,
  eventStreamOf,
  REWRITTEN_MARKDOWN,
  STATUS_AFTER,
  type RunScript,
} from './script';

/** The one person's platform token, which `/signin` puts in the app's cookie. */
export const DESK_TOKEN = 'awu_live_desk_fixture_person';

/**
 * The origin of the desk's scripted Agent Workspace, which the dashboard's rows link to. A page
 * reads this constant rather than the runtime: a page and a route handler are bundled apart, and
 * only a route handler installs the desk.
 */
export const DESK_PLATFORM_URL = 'https://aw.test';

/** The app's own key, which the recipe runner starts each step's run with. */
const DESK_APP_KEY = 'ak_live_desk_fixture_app';

/** The agent ids `agentPanelRoutes` is given, by the panel's name for each. */
export const DESK_AGENTS = {
  summarise: '22222222-2222-4222-8222-222222222222',
  triage: '11111111-1111-4111-8111-111111111111',
  writer: '55555555-5555-4555-8555-555555555555',
} as const;

/** The knowledge base the desk starts with: a page at the top, and one under it to rewrite. */
const PAGE_SEED = {
  title: 'Handbook',
  children: [
    {
      title: 'Printer jams',
      markdown: 'When the printer jams, open the tray and pull out the paper. Then ask Net.',
    },
  ],
} as const;

/** The tickets the desk starts with: one the journey approves on, one it rejects on. */
const SEED = [
  { number: 'INC0042', summary: 'The printer on floor 3 is jammed' },
  { number: 'INC0043', summary: 'The printer on floor 3 prints blank pages' },
] as const;

/** The ticket whose creation starts the desk's recipe; the J3 journey never touches it. */
const RECIPE_SEED = { number: 'INC0044', summary: 'The printer on floor 4 is offline' } as const;

const PERSON: Person = fakePerson({ principalId: DESK_PERSON_ID });

/** A scripted run: the platform's resource, the record it is about, and what it does. */
interface DeskRun {
  run: RunResource;
  readonly recordId: string;
  readonly script: RunScript;
  /** For a rewrite: the revision its prompt names, which its `page_update` passes. */
  readonly expectedRevisionId?: string | undefined;
}

/** The desk's stores: the tickets and the pages. */
interface DeskStores {
  readonly tickets: () => MemoryResourceStore<typeof ticket.fields>;
  readonly pages: () => MemoryPageStore<typeof page.fields>;
}

interface Desk {
  readonly ready: Promise<void>;
  readonly runner: RecipeRunner;
  /** Starts a run in `running` that no ticket is about, and returns it. */
  readonly startRunning: () => RunResource;
}

const RECORD_IN_PROMPT = /^(ticket|page) ([0-9a-f-]{36}): /u;
const EXPECTED_REVISION_IN_PROMPT = /"expectedRevisionId":"([0-9a-f-]{36})"/u;

function problemOf(status: number, code: string): Response {
  return jsonResponse(status, {
    error: { code, message: 'The desk fixture refused the request.' },
  });
}

function newRun(
  runs: Map<string, DeskRun>,
  agentId: string,
  sessionId: string,
  recordId: string,
  script: RunScript,
  expectedRevisionId?: string,
): RunResource {
  const run = fixtures.run({
    id: crypto.randomUUID(),
    workspaceId: FAKE_WORKSPACE_ID,
    agentId,
    sessionId,
    status: 'queued',
    createdAt: new Date().toISOString(),
  });
  runs.set(run.id, { run, recordId, script, expectedRevisionId });
  return run;
}

/** The writer's rewrite, written as the person through the agent: a new revision with its run. */
async function rewrite(stores: DeskStores, found: DeskRun): Promise<string> {
  const agent = fakePerson({ ...PERSON, via: 'agent', runId: found.run.id });
  const before = await stores.pages().get(PERSON, found.recordId);
  await stores.pages().update(agent, found.recordId, {
    blocks: markdownToBlocks(REWRITTEN_MARKDOWN),
    ...(found.expectedRevisionId === undefined
      ? {}
      : { expectedRevisionId: found.expectedRevisionId }),
  });
  return before.title;
}

/** `GET /api/runs`: the desk's runs filtered by `status` and `from`, newest first, one page. */
function listOf(runs: ReadonlyMap<string, DeskRun>, query: URLSearchParams): Response {
  const status = query.get('status');
  const from = query.get('from');
  const listed = [...runs.values()]
    .map((found) => found.run)
    .filter((run) => status === null || run.status === status)
    .filter((run) => from === null || Date.parse(run.createdAt) >= Date.parse(from))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return jsonResponse(200, { runs: listed, nextCursor: null });
}

function platformOf(stores: DeskStores, runs: Map<string, DeskRun>) {
  const store = stores.tickets;
  async function events(found: DeskRun): Promise<Response> {
    if (found.script === 'rewrite') {
      const title = await rewrite(stores, found);
      found.run = fixtures.run({ ...found.run, status: STATUS_AFTER.rewrite });
      return eventStreamResponse(eventStreamOf('rewrite', title));
    }
    const record = await store().get(PERSON, found.recordId);
    if (found.script === 'approved') {
      // The paused call, carried out as the person through the agent: the write carries its run.
      const agent = fakePerson({ ...PERSON, via: 'agent', runId: found.run.id });
      await store().update(agent, found.recordId, { assignee: APPROVED_ASSIGNEE });
    }
    const status = STATUS_AFTER[found.script];
    found.run = fixtures.run({
      ...found.run,
      status,
      pendingApproval: status === 'awaiting_approval' ? ASSIGN_TO_NET : null,
    });
    return eventStreamResponse(eventStreamOf(found.script, record.number));
  }

  function start(agentId: string, body: unknown): Response {
    const { prompt, sessionId } = body as { prompt: string; sessionId: string | null };
    const [, kind, recordId] = RECORD_IN_PROMPT.exec(prompt) ?? [];
    if (recordId === undefined) return problemOf(400, 'invalid_body');
    const session = sessionId ?? crypto.randomUUID();
    const run =
      kind === 'page'
        ? newRun(
            runs,
            agentId,
            session,
            recordId,
            'rewrite',
            EXPECTED_REVISION_IN_PROMPT.exec(prompt)?.[1],
          )
        : newRun(runs, agentId, session, recordId, 'triage');
    return jsonResponse(202, { run, events: `/api/runs/${run.id}/events` });
  }

  function decide(found: DeskRun, body: unknown): Response {
    if (found.run.status !== 'awaiting_approval')
      return problemOf(409, 'run_not_awaiting_approval');
    const { decision } = body as { decision: 'approve' | 'reject' };
    found.run = fixtures.run({ ...found.run, status: 'completed', pendingApproval: null });
    const script = decision === 'approve' ? 'approved' : 'rejected';
    const run = newRun(runs, found.run.agentId, found.run.sessionId, found.recordId, script);
    return jsonResponse(202, { run, events: `/api/runs/${run.id}/events` });
  }

  return async (request: RecordedRequest): Promise<Response> => {
    const authorization = request.headers.get('authorization');
    const path = request.url.pathname;
    const asApp = authorization === `Bearer ${DESK_APP_KEY}` && path !== '/api/me';
    if (authorization !== `Bearer ${DESK_TOKEN}` && !asApp) {
      return problemOf(401, 'unauthenticated');
    }
    if (path === '/api/me') {
      return jsonResponse(200, {
        principalId: PERSON.principalId,
        kind: 'membership',
        role: PERSON.role,
        workspaceId: PERSON.workspaceId,
        userId: '44444444-4444-4444-8444-444444444444',
        label: 'Desk person',
        features: [],
      });
    }
    if (path === '/api/runs' && request.method === 'GET')
      return listOf(runs, request.url.searchParams);
    const started = /^\/api\/agents\/([^/]+)\/runs$/u.exec(path);
    if (started !== null && request.method === 'POST') return start(started[1] ?? '', request.json);
    const one = /^\/api\/runs\/([^/]+)(?:\/(events|approval))?$/u.exec(path);
    const found = one === null ? undefined : runs.get(one[1] ?? '');
    if (one === null || found === undefined) return problemOf(404, 'run_not_found');
    if (one[2] === 'events') return events(found);
    if (one[2] === 'approval') return decide(found, request.json);
    return jsonResponse(200, { run: fixtures.runDetail(found.run) });
  };
}

function install(): Desk {
  const runs = new Map<string, DeskRun>();
  // The double is called only once a request arrives, after the runtime below is installed.
  const platform = fetchDouble(
    platformOf(
      { tickets: () => installed.storeOf(ticket), pages: () => installed.pageStoreOf(page) },
      runs,
    ),
  );
  const installed = setAppRuntimeForTests({
    fetch: platform.fetch,
    appName: 'desk',
    awUrl: DESK_PLATFORM_URL,
  });
  const admin = fakePerson({ ...PERSON, role: 'admin' });
  const runner = recipeRunner(app, {
    client: createClient({
      baseUrl: installed.awUrl,
      auth: { kind: 'api-key', apiKey: DESK_APP_KEY },
      fetch: platform.fetch,
    }),
    store: installed.recipeStore,
    workspaceId: FAKE_WORKSPACE_ID,
  });
  const ready = (async () => {
    for (const seed of SEED) await installed.storeOf(ticket).create(admin, seed);
    await installed.storeOf(room).create(admin, { title: DESK_ROOM_TITLE });
    const pages = installed.pageStoreOf(page);
    const top = await pages.create(admin, { title: PAGE_SEED.title, blocks: [] });
    for (const child of PAGE_SEED.children) {
      await pages.create(PERSON, {
        title: child.title,
        parent: top.id,
        blocks: markdownToBlocks(child.markdown),
      });
    }
    // A committed create starts the recipes on it, as `storeOf`'s `onCommitted` hook does.
    const created = await installed.storeOf(ticket).create(admin, RECIPE_SEED);
    await runner.onResourceEvent('ticket', 'created', { ...created }, PERSON);
    await runner.drain();
  })();
  const startRunning = (): RunResource => {
    const run = fixtures.run({
      id: crypto.randomUUID(),
      workspaceId: FAKE_WORKSPACE_ID,
      agentId: DESK_AGENTS.summarise,
      status: 'running',
      createdAt: new Date().toISOString(),
    });
    runs.set(run.id, { run, recordId: '', script: 'triage' });
    return run;
  };
  return { ready, runner, startRunning };
}

const globalDesk = globalThis as typeof globalThis & { deskFixture?: Desk };

/**
 * A route handler that runs once the desk is installed and seeded. Installed once per server
 * process: every route module shares the one runtime.
 */
export function onDesk<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args) => {
    globalDesk.deskFixture ??= install();
    await globalDesk.deskFixture.ready;
    return handler(...args);
  };
}

/** The test hook: starts a run in `running`, as a person starting an agent elsewhere would. */
export async function deskStartRunningRun(): Promise<RunResource> {
  globalDesk.deskFixture ??= install();
  await globalDesk.deskFixture.ready;
  return globalDesk.deskFixture.startRunning();
}

/** The desk's recipe runner, for the recipe routes; installed with the desk on first use. */
export function deskRecipeRunner(): RecipeRunner {
  globalDesk.deskFixture ??= install();
  return globalDesk.deskFixture.runner;
}
