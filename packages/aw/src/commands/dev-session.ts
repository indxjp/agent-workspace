import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import type { ModelCheck } from '../local-runtime/project-resources.js';
import { isOn, type LocalCommandContext } from '../command.js';
import { nonBlank } from '../config.js';
import { startDevApp, type RunningApp } from '../dev/app.js';
import { type DevIssuer } from '../dev/issuer.js';
import { tryPage } from '../dev/format.js';
import { createDevSyncClient, startDevSync, type DevSync } from '../dev/sync.js';
import { applyProjectResources, plannedProject } from '../local-runtime/project-resources.js';
import { writeRuntimeRecord } from '../local-runtime/project.js';
import { type LocalRuntimeSession } from '../local-runtime/supervisor.js';
import { type ToolHost } from '../tools/host.js';
import { announceReady, offerChat } from './dev-presentation.js';
import { appAudience, appOidcClient, existingAppBackend, settleDevApp } from './dev-identity.js';
import { prepareDev } from './dev-preflight.js';

export interface DevSessionState {
  fatal?: Error;
  sync?: DevSync;
  toolHost?: ToolHost;
  app?: RunningApp | undefined;
  devIssuer?: DevIssuer | undefined;
  readyDatabaseUrl?: string | undefined;
  readyOrigin?: string;
  readySeconds: number;
  recorded: boolean;
}

interface SignedInSessionOptions {
  readonly context: LocalCommandContext;
  readonly prepared: Awaited<ReturnType<typeof prepareDev>>;
  readonly start: Awaited<ReturnType<typeof prepareDev>>['start'];
  readonly state: DevSessionState;
  readonly running: AbortSignal;
  readonly lifetime: AbortController;
  readonly surfaces: readonly string[];
  readonly agents: NonNullable<Awaited<ReturnType<typeof prepareDev>>['loaded']>['agents'];
  readonly logFile: string;
}

export async function startSignedInSession(
  options: SignedInSessionOptions,
  session: LocalRuntimeSession,
): Promise<void> {
  const { context, prepared, start, state, running, surfaces, agents, logFile } = options;
  const { signal } = context;
  const { cwd, io, quiet, detected, anthropic } = prepared;

  // Issue #730: other `aw` commands in this project reach the port actually bound. The
  // supervisor stored its key before this hook, so the record never names a keyless port.
  await writeRuntimeRecord(cwd, start.environment.port);
  state.recorded = true;
  const client = createDevSyncClient({
    baseUrl: session.baseUrl,
    apiKey: session.apiKey,
    fetch: io.fetch,
  });
  const planned = await startProjectApp(options, client, session);
  const check = await applyProjectResources({
    io,
    session,
    read: planned,
    start,
    root: cwd,
    anthropicBaseUrl: anthropic.baseUrl,
    signal,
    deferModelCheck: !quiet,
  });
  const beginSync = (): DevSync => beginSessionSync(options, client, session);
  if (state.app !== undefined && detected !== null) {
    // DI10: the first sync runs before the screen, so the app's pair is settled first.
    state.sync = await settleDevApp({
      client,
      app: state.app,
      appName: detected.name,
      beginSync,
      oidcAudience: appAudience(state.devIssuer, detected.name, io.env),
      agentNames: agents.map(({ name }) => name),
      stderr: io.stderr,
      signal: running,
    });
  }
  const origin = await announceReady({
    prepared,
    session,
    check,
    ready: { origin: state.readyOrigin, seconds: state.readySeconds, logFile },
    app: state.app,
    surfaces,
  });
  const syncing = state.sync ?? beginSync();
  state.sync = syncing;
  offerChatAfterSync(options, { syncing, check, origin });
}

async function startProjectApp(
  options: SignedInSessionOptions,
  client: AgentWorkspaceClient,
  session: LocalRuntimeSession,
) {
  const { prepared, start, state, running } = options;
  const { cwd, io, read, detected } = prepared;
  // Issue #1506: the app's connector joins this one plan, in memory only.
  let planned = read;
  if (detected !== null) {
    const started = await startDevApp({
      client,
      cwd,
      appName: detected.name,
      read,
      session,
      webPort: start.environment.port,
      databaseUrl: nonBlank(io.env['DATABASE_URL']) ?? state.readyDatabaseUrl,
      env: io.env,
      stderr: io.stderr,
      signal: running,
      oidcClient: appOidcClient(state.devIssuer, detected.name),
      appBackend: () => existingAppBackend(client, detected.name, io.stderr, running),
    });
    state.app = started.app;
    planned = started.read;
  }
  return planned;
}

function beginSessionSync(
  options: SignedInSessionOptions,
  client: AgentWorkspaceClient,
  session: LocalRuntimeSession,
): DevSync {
  const { prepared, start, state, running, lifetime, surfaces } = options;
  const { cwd, io, quiet, read, defaultEngine, models, withheld, anthropic } = prepared;
  return startDevSync({
    client,
    root: cwd,
    io,
    // The screen shows the first surface's try URL and embed tag; any other prints its own.
    announcedSurfaces: quiet ? [] : surfaces.slice(0, 1),
    signal: running,
    origin: state.readyOrigin ?? session.baseUrl,
    defaultEngine,
    models,
    forkWithheld: withheld,
    project: plannedProject(read, start),
    liveProject: { read, start, session, anthropicBaseUrl: anthropic.baseUrl },
    toolHost: state.toolHost,
    onFatal: (error) => {
      state.fatal ??= error;
      lifetime.abort();
    },
  });
}

function offerChatAfterSync(
  options: SignedInSessionOptions,
  ready: { readonly syncing: DevSync; readonly check: ModelCheck; readonly origin: string },
): void {
  const { context, prepared, surfaces, running, state, lifetime } = options;
  const { io, quiet } = prepared;
  const { syncing, check, origin } = ready;
  const firstSurface = surfaces[0];
  if (firstSurface !== undefined) {
    // Not awaited: the supervisor waits for this hook before it reports a runtime exit, so a
    // question left unanswered must not hold it. `running` cancels the prompt when aw dev
    // ends; Ctrl-C at it is an interrupt that stops aw dev.
    // After the first sync's lines, so its output never lands on the question's line.
    void syncing.firstSync
      .then(() =>
        // A fatal first sync or Ctrl-C ends aw dev: neither asks nor opens then.
        running.aborted
          ? undefined
          : offerChat(
              io,
              tryPage(origin, firstSurface),
              {
                open: isOn(context, 'open'),
                never: isOn(context, 'no-open'),
                // A key the provider just refused cannot answer a chat, so the chat is
                // not offered; `--open` still opens it (BH061-051).
                quiet: quiet || check.problems.some((entry) => entry.rejected === true),
              },
              running,
            ),
      )
      .catch((error: unknown) => {
        if (running.aborted) return;
        state.fatal ??= error instanceof Error ? error : new Error(String(error));
        lifetime.abort();
      });
  }
}
