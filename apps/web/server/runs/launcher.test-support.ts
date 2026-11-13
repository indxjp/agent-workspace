/**
 * Shared fixtures for the `launcher.*.test.ts` suites: one run, one context, one SSE helper and a
 * few small builders, so each suite states only what it is about.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, vi } from 'vitest';

import { log as webLogger } from '../telemetry/logger';
import type { LaunchContext } from './environment';
import { signalLiveRun } from './interrupt';
import type { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './memory-store';
import type { RunRecord } from './store';

export const quietLog = { info() {}, warn() {}, error() {}, child: () => quietLog };
export const RUN = '11111111-1111-4111-8111-111111111111';
const AGENT = '33333333-3333-4333-8333-333333333333';
export const SESSION = '44444444-4444-4444-8444-444444444444';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
export const PRINCIPAL = '77777777-7777-4777-8777-777777777777';
export const USER = '66666666-6666-4666-8666-666666666666';
export const RUN_DONE = 'event: run-done\ndata: {}\n\n';

export type LauncherOptions = Parameters<typeof createRunnerLauncher>[0];
export type RuntimeTarget = Awaited<ReturnType<NonNullable<LauncherOptions['runtime']>['resolve']>>;

export async function newRun(store: InMemoryRunStore): Promise<RunRecord> {
  return store.create({
    engine: 'claude-agent-sdk',
    id: RUN,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    sessionId: SESSION,
  });
}

export function context(run: RunRecord): LaunchContext {
  return {
    run,
    agent: { id: AGENT, workspaceId: run.workspaceId, engine: 'claude-agent-sdk' },
    session: { id: SESSION, agentId: AGENT, engine: null },
    principal: {
      principalId: PRINCIPAL,
      ownerPrincipalId: PRINCIPAL,
      userId: USER,
      workspaceId: run.workspaceId,
      scope: null,
    },
    prompt: 'hello',
  };
}

/**
 * The §14.3 body these tests send. Deliberately a fixture rather than the real compilation:
 * `buildRunRequest` is `createRunnerLauncher`'s one required argument precisely because this
 * module does not know how to build one, so a test that built a real `RunRequest` here would be
 * asserting the composer's work through the launcher. What is asserted below is that whatever
 * the composer returns is what reaches `POST {base}/run`, unchanged.
 */
export const RUN_REQUEST_FIXTURE = { runId: RUN, sessionId: SESSION, marker: 'from the composer' };

export function buildRunRequest(): unknown {
  return RUN_REQUEST_FIXTURE;
}

export function sse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** A `text/event-stream` response whose body the test feeds itself. */
export function sseStream(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

export function urlOf(input: Parameters<typeof globalThis.fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** The docker-flavoured runtime target most suites use; override only what a test is about. */
export function runtimeTarget(overrides: Partial<RuntimeTarget> = {}): RuntimeTarget {
  return {
    runtimeProfileId: 'profile-docker',
    driver: 'docker',
    networkPolicy: 'none',
    filesystem: 'read-write',
    runnerUrl: 'http://runtime:8080',
    workspaceRoot: '/workspace',
    fileTransfer: 'push-archive',
    ...overrides,
  };
}

/** A `runtime` option that resolves to {@link runtimeTarget}. */
export function runtimeOf(
  overrides: Partial<RuntimeTarget> = {},
): NonNullable<LauncherOptions['runtime']> {
  return { resolve: () => Promise.resolve(runtimeTarget(overrides)) };
}

/** A workspace lifecycle that hydrates nothing and promotes nothing. */
export function emptyWorkspace(
  overrides: Partial<NonNullable<LauncherOptions['workspaceLifecycle']>> = {},
): NonNullable<LauncherOptions['workspaceLifecycle']> {
  return {
    inputArchive: () => Promise.resolve(null),
    promoteOutputs: () => Promise.resolve(),
    ...overrides,
  };
}

/** Wait until the run reaches a terminal status, or fail loudly rather than hang. */
export async function settle(store: InMemoryRunStore): Promise<RunRecord> {
  for (let i = 0; i < 200; i += 1) {
    const run = await store.get(RUN);
    if (run !== null && run.endedAt !== null) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the run never reached a terminal status');
}

export async function transcript(
  store: InMemoryRunStore,
): Promise<{ type: string; data: unknown }[]> {
  const handle = await store.openStream(RUN, null);
  if (handle === null) throw new Error('no handle');
  const out: { type: string; data: unknown }[] = [];
  for await (const event of handle.events) out.push({ type: event.type, data: event.data });
  return out;
}

/** Silences (and lets the test inspect) the web logger's error channel; call `.mockRestore()` after. */
export function silenceErrorLog() {
  return vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
}

/** A promise and the function that resolves it. */
export function latch(): { readonly reached: Promise<void>; readonly notify: () => void } {
  let notify: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    notify = resolve;
  });
  return { reached, notify };
}

/** Starts a plain HTTP server on a free loopback port, standing in for the runner. */
export async function listenRunner(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Server> {
  const runner = createServer(handler);
  await new Promise<void>((resolve) => runner.listen(0, '127.0.0.1', resolve));
  return runner;
}

export function runnerUrl(runner: Server): string {
  return `http://127.0.0.1:${String((runner.address() as AddressInfo).port)}`;
}

export async function closeRunner(runner: Server): Promise<void> {
  runner.closeAllConnections();
  await new Promise<void>((resolve) => runner.close(() => resolve()));
}

/** A signal sent to a settled run reaches no runtime: the live-run registry entry is gone. */
export async function expectNoLiveRunEntry(): Promise<void> {
  let signalled = false;
  await signalLiveRun(RUN, () => {
    signalled = true;
    return Promise.reject(new Error('should not be called'));
  });
  expect(signalled).toBe(false);
}
