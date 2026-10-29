/**
 * `/` — the home chat screen (spec §19.5, §45).
 *
 * §45 is emphatic about what the first screen is: not an analytics dashboard, not a grid of agent
 * cards, "the first thing on the screen is a place to type". So this route renders the composer and
 * nothing above it. The screen itself is `components/composer/home-chat.tsx`; this file is the seam
 * between it and the control plane, and its whole job is to answer one question honestly — **what
 * can this workspace actually run a message as?**
 *
 * ## W1-UI-05 — the workspace resolution this file's own header used to say was impossible
 *
 * Every earlier revision of this file, and `docs/adr/W1-UI-04-the-home-route-renders-per-request.md`
 * after it, stated as settled fact that a Server Component "has no `Request`" and so cannot call
 * `AgentsRuntime.resolveWorkspace`. This task was asked to check that claim against the repository
 * rather than build around it, and it does not hold: `apps/web/server/auth/index.ts` reads the
 * session from `next/headers`'s `cookies()`, imported by exactly two files before this one —
 * `apps/web/server/auth/index.ts` itself and `apps/web/app/signin/actions.ts` — and this route's own
 * sibling, `apps/web/app/(shell)/layout.tsx`, has been calling `getSession()` from an `async` Server
 * Component on every request the whole time this file has been saying it could not be done. Next's
 * App Router gives a Server Component read access to the incoming request's cookies for exactly this
 * reason; it withholds mutation (`cookies().set` outside a Server Action or Route Handler), not
 * reading. See `docs/adr/W1-UI-05-server-components-can-read-the-session.md` for the full record,
 * including why that claim survived two prior tasks unchecked.
 *
 * `AgentsRuntime.resolveWorkspace` still takes a `Request` — that part of the earlier reasoning was
 * correct, a Server Component is not handed one by Next — but a `Request` is a value, not a
 * privilege: `composerAgents` below builds one from the same cookie header `getSession()` already
 * reads, and hands it to `resolveWorkspace` unchanged, so the workspace decision runs through the
 * *exact* session-verification-and-membership-lookup code path every `/api/**` route already uses
 * (`instrumentation.ts`'s `register()`), rather than a second, page-local reimplementation of it.
 *
 * ## What this file now actually decides
 *
 * `composerAgents()` asks the real question and answers with what it found, never with an assumed
 * default:
 *
 *   1. **No store is installed** — `applicationContext()?.agents` is absent outside a configured
 *      deployment (tests, or a real one with `register()` run). Answered before anything else,
 *      because every later question needs the runtime to ask it.
 *   2. **No session, or a session for an account this workspace does not recognise** —
 *      `resolveWorkspace`'s `unauthenticated` and `forbidden` cases, answered exactly as the agent
 *      API's own `withWorkspaceStore` (`server/agents/http.ts`) answers them, because it is the same
 *      function.
 *   3. **A resolved workspace with no agents yet** — the store answered and it is empty. Not
 *      collapsed into the same sentence as "nobody is signed in"; a workspace with a session and zero
 *      agents is a different, later state of the same story than one nobody could identify at all.
 *   4. **Agents.** The one case that offers something, and only because the first three were each
 *      checked and none of them fired.
 *
 * Every branch names the check that produced it (ADR-0015): there is no path here that offers an
 * agent because a check was skipped, and no path that says "no agents" without saying which fact made
 * that true.
 *
 * ## What this file still does not build
 *
 * `WorkspaceAgentStore.list()` returns `AgentRecord`s, and this wave's schema gives an agent no file
 * or connector catalogue at all — the same absence `components/agents/agents-list.tsx`'s own header
 * records for the list screen's missing columns. `composerAgentFromRecord` below reflects that
 * honestly: `files: []` and `connectors: []` are not a placeholder for content nobody built, they are
 * §19.5.1 rule 2's narrowing applied to an agent that, in this wave, is permitted none because none
 * exist to be permitted.
 *
 * ## Recent
 *
 * `RunStore` (`server/runs/store.ts`) has `create`, `get`, `markRunning`, `finish`, two appends and
 * `openStream`. It has no way to list a workspace's runs, and a `runs` row carries neither a title
 * nor a cost — two of the four things a Recent row shows. There is no honest Recent list to build in
 * this wave, and an empty list renders no section at all.
 */
import { log } from '../../server/telemetry/logger';
import { cookies } from 'next/headers';

import { initialsFrom } from '../../components/shell/identity';
import { HomeChat, type ComposerAgents } from '../../components/composer/home-chat';
import { pinnedAgentFrom, type RecentSession } from '../../components/composer/model';
import type { Speaker } from '@indx-workspace/react/run-model';
import type { AgentPermissions } from '../../contracts/agents';
import { getSession } from '../../server/auth';
import type { WorkspaceResolution } from '../../server/agents/runtime';
import type { AgentRecord } from '../../server/agents/contract';
import type {
  ComposerAgent,
  ComposerModelConnection,
  ComposerRunTarget,
} from '../../components/composer/model';
import { registeredEngine } from '../../server/engines/registry';
import { providersReachableBy } from '../../server/engines/protocol';
import { engineForStoredPolicy } from '../../server/engines/session-engine';
import { applicationContext } from '../../server/application-context';
import {
  getRunApi,
  type RunTargetDescription,
  type RunTargetDescriptions,
} from '../../server/runs/environment';

// W1-UI-04: without this, Next prerenders this route once at BUILD TIME — before
// the application context is installed — and serves that one render to every request forever
// (measured: `x-nextjs-cache: HIT`, an identical `ETag` across requests, no matter what
// `applicationContext()?.agents` would answer if asked again). `composerAgents()` below reads
// process-global state that changes after a deployment starts (`register()` in
// `instrumentation.ts` installs the runtime once, at boot, in every real deployment), so a route
// that reads it must render per-request, not once at build time. See
// docs/adr/W1-UI-04-the-home-route-renders-per-request.md.
export const dynamic = 'force-dynamic';

/**
 * These are said in the composer's own status slot — where `ui/home.html` puts "Standard Sandbox ·
 * read-only" — because that slot's job is to tell the user what this message would run on, and the
 * true answer is that nothing would. Each names the check that did not pass rather than describing
 * the workspace, which is the distinction between "we looked and found none" and "we never looked".
 */
const NO_AGENT_STORE = 'No agent store is configured — nothing can run yet.';
const NO_SESSION = 'You are not signed in — no agent can be offered.';
const NO_MEMBERSHIP = 'Your account is not a member of this workspace — no agent can be offered.';
const NO_AGENTS_YET = 'This workspace has no agents yet — create one to run a message.';

/**
 * Build a `Request` carrying exactly this render's session cookie and nothing else.
 *
 * `AgentsRuntime.resolveWorkspace` reads only `request.headers.get('cookie')` (see
 * `instrumentation.ts`'s own implementation of it) — the method exists to be called from a route
 * handler, which has a real `Request`, but nothing in its contract requires *this* file's request
 * to have travelled the network. The URL is a fixed placeholder because nothing downstream reads
 * it; only the header matters, and it is the same header `getSession()` (`server/auth/index.ts`)
 * already reads from the same `cookies()` call for the same render.
 */
async function requestCarryingThisSessionCookie(): Promise<Request> {
  const store = await cookies();
  return new Request('http://localhost/', { headers: { cookie: store.toString() } });
}

/**
 * §19.5.1 rule 2's narrowing, applied to a record this wave's schema actually has. See this file's
 * own header for why `files` and `connectors` are `[]` for a real agent rather than a fixture's
 * demonstration rows.
 */
function composerAgentFromRecord(agent: AgentRecord, targets: ComposerRunTargets): ComposerAgent {
  const { runTarget, runTargetByProject } = targets;
  const model =
    runTarget.kind === 'runnable'
      ? runTarget.model
      : (agent.model ?? 'the workspace default model');
  const sandbox = `Standard Sandbox · ${agent.permissions.writeFiles ? 'read/write' : 'read-only'}`;
  const extra = permissionExtras(agent.permissions);
  const engine = engineForStoredPolicy(agent.policy);
  return {
    id: agent.id,
    modelConnectionId: agent.modelConnectionId,
    name: agent.name,
    detail: extra === '' ? `${model} · ${sandbox}` : `${model} · ${sandbox} · ${extra}`,
    files: [],
    connectors: [],
    sandbox,
    runTarget,
    runTargetByProject,
    // Issue #393: the providers this agent's engine reaches through the gateway, so the model
    // picker offers only models it can drive. An engine this deployment does not register reaches
    // none, and the picker then offers nothing rather than a model that cannot run.
    drivableProviders: providersReachableBy(
      registeredEngine(engine)?.capabilities.wireProtocols ?? [],
    ),
    // #2012: listed like any agent, but never the composer's default.
    ...(agent.builtin === undefined ? {} : { builtin: agent.builtin }),
  };
}

interface ComposerRunTargets {
  readonly runTarget: ComposerRunTarget;
  readonly runTargetByProject: Readonly<Record<string, ComposerRunTarget>>;
}

function composerRunTargetFrom(description: RunTargetDescription): ComposerRunTarget {
  return description.kind === 'runnable'
    ? {
        kind: 'runnable',
        source: description.source,
        connectionName: description.connectionName,
        model: description.model,
      }
    : { kind: 'unrunnable', code: description.code, reason: description.reason };
}

/**
 * What a run of each agent would use (issue #393), outside any project and in each project whose
 * default sits on its ladder, from the run API's description — stored configuration only, no
 * provider call. `unknown` when no run API is installed.
 */
async function composerRunTargets(
  workspaceId: string,
  agentId: string,
): Promise<ComposerRunTargets> {
  const describe = getRunApi()?.describeRunTarget;
  let description: RunTargetDescriptions | null = null;
  try {
    description = describe === undefined ? null : await describe(workspaceId, agentId);
  } catch (error) {
    // One agent whose configuration cannot be read is shown as `unknown` — the run itself still
    // decides — rather than failing the home page for every other agent (#403 follow-up).
    log.error(`[home] the run target of agent ${agentId} could not be described`, { error });
  }
  if (description === null) return { runTarget: { kind: 'unknown' }, runTargetByProject: {} };
  return {
    runTarget: composerRunTargetFrom(description.outsideProject),
    runTargetByProject: Object.fromEntries(
      [...description.byProject].map(([projectId, target]) => [
        projectId,
        composerRunTargetFrom(target),
      ]),
    ),
  };
}

/**
 * Whose last-used agent the browser may remember (PR #403 review): the workspace and the signed-in
 * user's id, read from the same principal the run routes authenticate. `null` when no run API is
 * installed or the principal is not this workspace's; the composer then remembers nothing.
 */
async function composerViewer(
  request: Request,
  workspaceId: string,
): Promise<{ readonly workspaceId: string; readonly userId: string } | null> {
  const principal = await getRunApi()?.authenticate(request);
  return principal === undefined ||
    principal === null ||
    principal.workspaceId !== workspaceId ||
    principal.userId === null
    ? null
    : { workspaceId, userId: principal.userId };
}

async function composerModelConnections(): Promise<readonly ComposerModelConnection[]> {
  const models = applicationContext()?.models;
  if (models?.kind !== 'serving') return [];
  const runtime = models.runtime;
  const request = await requestCarryingThisSessionCookie();
  const resolution = await runtime.resolveActor(request);
  if (resolution.kind !== 'workspace') return [];
  const connections = await runtime.models.forWorkspace(resolution.workspaceId).list();
  return connections.map(({ id, name, provider }) => ({ id, name, provider }));
}

/** The two permissions §17 Step 4 defines beyond file access, named only when the agent has them. */
function permissionExtras(permissions: AgentPermissions): string {
  const extras: string[] = [];
  if (permissions.runCommands) extras.push('can run commands');
  if (permissions.unrestrictedNetwork) extras.push('unrestricted network');
  return extras.join(', ');
}

/**
 * What the composer may offer.
 *
 * Every branch is a decision about something that was checked, and the function ends in a total
 * rejection that names its reason. There is no path on which an agent is offered because a check was
 * skipped. See this file's own header for what changed here in W1-UI-05 and why.
 */
async function composerAgents(): Promise<ComposerAgents> {
  const runtime = applicationContext()?.agents ?? null;
  if (runtime === null) return { kind: 'no-agents', reason: NO_AGENT_STORE };

  const request = await requestCarryingThisSessionCookie();
  const resolution: WorkspaceResolution = await runtime.resolveWorkspace(request);

  switch (resolution.kind) {
    case 'unauthenticated':
      return { kind: 'no-agents', reason: NO_SESSION };
    case 'forbidden':
      return { kind: 'no-agents', reason: NO_MEMBERSHIP };
    case 'workspace': {
      const records = await runtime.agents.forWorkspace(resolution.workspaceId).list();
      const mapped = await Promise.all(
        records.map(async (record) =>
          composerAgentFromRecord(
            record,
            await composerRunTargets(resolution.workspaceId, record.id),
          ),
        ),
      );
      const first = mapped[0];
      // Checked positively — `first !== undefined` — rather than `mapped.length === 0`, so the
      // non-empty tuple `HomeChat` requires is built from a value TypeScript has actually narrowed,
      // not asserted past a length check a later edit could detach from the array it counted.
      if (first === undefined) return { kind: 'no-agents', reason: NO_AGENTS_YET };
      const [setupAgentId, viewer] = await Promise.all([
        runtime.setupAgentId?.(resolution.workspaceId) ?? Promise.resolve(null),
        composerViewer(request, resolution.workspaceId),
      ]);
      return { kind: 'agents', agents: [first, ...mapped.slice(1)], setupAgentId, viewer };
    }
    default: {
      // Total: a fourth resolution kind is a compile error here, not a silent fall-through to an
      // offered agent nobody checked (ADR-0015), matching `withWorkspaceStore`'s own exhaustiveness
      // check in `server/agents/http.ts`.
      const unreachable: never = resolution;
      throw new Error(
        `composerAgents received a workspace resolution it does not handle: ${JSON.stringify(unreachable)}`,
      );
    }
  }
}

/**
 * Who is typing, for `HomeChat`'s `user` prop — the same session `composerAgents()` reads, turned
 * into the two-letter avatar `components/shell/identity.ts` already derives for the sidebar. `null`
 * means "no valid session", which is also what leaves the composer's **Send** button disabled
 * regardless of whether an agent could be offered.
 */
async function composerUser(): Promise<Speaker | null> {
  const session = await getSession();
  if (session === null) return null;
  return { initials: initialsFrom(session.sub), name: session.sub };
}

/** No source of Recent rows exists in this wave. See the module header. */
const RECENT: readonly RecentSession[] = [];

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string | string[]; version?: string | string[] }>;
}) {
  const [agents, user, modelConnections, pinned] = await Promise.all([
    composerAgents(),
    composerUser(),
    composerModelConnections(),
    searchParams.then(pinnedAgentFrom),
  ]);
  return (
    <HomeChat
      agents={agents}
      modelConnections={modelConnections}
      recent={RECENT}
      user={user}
      {...(pinned === null
        ? {}
        : { agent: { id: pinned.agentId, locked: true as const }, version: pinned.version })}
    />
  );
}
