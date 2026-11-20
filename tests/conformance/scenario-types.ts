/**
 * Types and helpers shared by the A.12 scenario modules (`scenarios.ts` assembles the table).
 */
import { randomUUID } from 'node:crypto';

import { makeTempWorkspace } from './support.js';
import type { A12Timers } from './timers.js';
import type {
  A12AgentAction,
  A12AgentOutcome,
  A12Probe,
  A12ScenarioId,
  RuntimeCapabilities,
  RuntimeDriver,
  RuntimeHandle,
} from './types.js';
import type { A12RunOutcome } from './support.js';

/** Everything one scenario's `run()` needs. */
export type A12ScenarioContext<TRequest, TEvent> = {
  readonly driver: RuntimeDriver<TRequest, TEvent>;
  readonly capabilities: RuntimeCapabilities;
  readonly probe: A12Probe<TRequest, TEvent>;
  /**
   * The clock `enforce-resource-limits` measures its patience budget on; real time unless a
   * caller checking a fixture driver passes the fixture's own clock (timers.ts).
   */
  readonly timers?: A12Timers;
};

/** A verdict on whether a driver's declared capabilities claim a scenario at all. */
export type A12Requirement =
  { readonly met: true } | { readonly met: false; readonly reason: string };

export type A12Scenario<TRequest, TEvent> = {
  readonly id: A12ScenarioId;
  /** The verbatim A.12 line (see `scenarios.ts`'s header). */
  readonly name: string;
  readonly requirement: (
    capabilities: RuntimeCapabilities,
    driver: RuntimeDriver<TRequest, TEvent>,
  ) => A12Requirement;
  readonly run: (ctx: A12ScenarioContext<TRequest, TEvent>) => Promise<A12RunOutcome>;
};

export const ALWAYS_REQUIRED: A12Requirement = { met: true };

export async function drainEvents<TEvent>(events: AsyncIterable<TEvent>): Promise<TEvent[]> {
  const collected: TEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

/**
 * A fresh temp workspace plus a runtime created over it. `workspaceLabel` names the directory and
 * `sessionLabel` prefixes the session id (`a12-<sessionLabel>-<uuid>`).
 */
export async function createSandbox<TRequest, TEvent>(
  driver: RuntimeDriver<TRequest, TEvent>,
  workspaceLabel: string,
  sessionLabel: string,
): Promise<RuntimeHandle> {
  const workspacePath = await makeTempWorkspace(workspaceLabel);
  return await driver.create({
    engine: 'claude-agent-sdk',
    sessionId: `a12-${sessionLabel}-${randomUUID()}`,
    workspacePath,
  });
}

/** Start one probe action on a handle, drain its events and interpret them. */
export async function runAgentAction<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
  handle: RuntimeHandle,
  action: A12AgentAction,
): Promise<A12AgentOutcome> {
  const connection = await ctx.driver.startAgent(handle, ctx.probe.agent.buildRequest(action));
  return ctx.probe.agent.interpretEvents(await drainEvents(connection.events));
}
