/** A.12 scenarios 1, 2, 4 and 8: runtime lifecycle, trivial turn, resume and interrupt. */
import { randomUUID } from 'node:crypto';

import { fail, pass, type A12RunOutcome } from './support.js';
import { createSandbox, drainEvents, type A12ScenarioContext } from './scenario-types.js';
import type { RuntimeHandle } from './types.js';

function malformedHandleProblems(
  handle: RuntimeHandle,
  expectedDriverId: string,
): readonly string[] {
  const problems: string[] = [];
  if (handle.driver !== expectedDriverId) {
    problems.push(
      `handle.driver is ${JSON.stringify(handle.driver)}, expected ${JSON.stringify(expectedDriverId)}`,
    );
  }
  if (typeof handle.id !== 'string' || handle.id.length === 0) {
    problems.push('handle.id is empty');
  }
  if (typeof handle.workspacePath !== 'string' || handle.workspacePath.length === 0) {
    problems.push('handle.workspacePath is empty');
  }
  if (!(handle.createdAt instanceof Date)) {
    problems.push('handle.createdAt is not a Date');
  }
  return problems;
}

async function startsAgentOn<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
  handle: RuntimeHandle,
  marker: string,
): Promise<boolean> {
  try {
    await ctx.driver.startAgent(handle, ctx.probe.agent.buildRequest({ kind: 'trivial', marker }));
    return true;
  } catch {
    // Expected: the runtime destroy() ended must not still be usable.
    return false;
  }
}

// --- 1. create and destroy a runtime --------------------------------------------------------

export async function runCreateAndDestroy<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver } = ctx;
  const handle = await createSandbox(driver, 'create-destroy', 'create-destroy');

  const problems = malformedHandleProblems(handle, driver.id);
  if (problems.length > 0) {
    return fail(`create() returned a malformed RuntimeHandle: ${problems.join('; ')}`);
  }

  await driver.destroy(handle);

  if (await startsAgentOn(ctx, handle, 'a12-post-destroy-probe')) {
    return fail(
      'startAgent() on a handle that destroy() already ended did not reject — the runtime is not actually gone',
    );
  }

  return pass(
    `created handle ${JSON.stringify(handle.id)}, destroyed it, and confirmed it can no longer start an agent`,
  );
}

// --- 2. run a trivial agent turn and stream events ------------------------------------------

export async function runTrivialAgentTurn<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, probe } = ctx;
  const handle = await createSandbox(driver, 'trivial-turn', 'turn');
  try {
    const marker = `a12-marker-${randomUUID()}`;
    const connection = await driver.startAgent(
      handle,
      probe.agent.buildRequest({ kind: 'trivial', marker }),
    );
    const events = await drainEvents(connection.events);
    const sessionId = await connection.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return fail('AgentConnection.sessionId resolved to an empty value');
    }
    const outcome = probe.agent.interpretEvents(events);
    if (!outcome.containsMarker(marker)) {
      return fail(
        `the turn's own event stream never carried marker ${JSON.stringify(marker)} — its output was not observed`,
      );
    }
    return pass(
      `streamed ${String(events.length)} event(s), sessionId resolved to ${JSON.stringify(sessionId)}, and the turn's own marker was observed in its output`,
    );
  } finally {
    await driver.destroy(handle);
  }
}

// --- 4. resume a session after the sandbox is gone -------------------------------------------

async function runFirstTurnThenDestroy<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
  marker: string,
): Promise<string> {
  const { driver, probe } = ctx;
  const handle = await createSandbox(driver, 'resume-1', 'resume');
  try {
    const connection = await driver.startAgent(
      handle,
      probe.agent.buildRequest({ kind: 'trivial', marker }),
    );
    await drainEvents(connection.events);
    return await connection.sessionId;
  } finally {
    await driver.destroy(handle); // the sandbox is now gone
  }
}

export async function runResumeAfterSandboxGone<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, probe } = ctx;

  const marker1 = `a12-resume-first-${randomUUID()}`;
  const sessionId = await runFirstTurnThenDestroy(ctx, marker1);

  const marker2 = `a12-resume-second-${randomUUID()}`;
  // a genuinely different, fresh sandbox
  const handle2 = await createSandbox(driver, 'resume-2', 'resume');
  try {
    const connection2 = await driver.startAgent(
      handle2,
      probe.agent.buildRequest({ kind: 'resume', priorSessionId: sessionId, marker: marker2 }),
    );
    const events2 = await drainEvents(connection2.events);
    const resumedSessionId = await connection2.sessionId;
    const outcome = probe.agent.interpretEvents(events2);

    if (resumedSessionId !== sessionId) {
      return fail(
        `resuming session ${JSON.stringify(sessionId)} on a fresh sandbox produced a different session id ${JSON.stringify(resumedSessionId)}`,
      );
    }
    if (!outcome.containsMarker(marker1) || !outcome.containsMarker(marker2)) {
      return fail(
        `the resumed turn's events did not carry both the original marker ${JSON.stringify(marker1)} and the new one ${JSON.stringify(marker2)} — continuity was not observed`,
      );
    }
    return pass(
      `destroyed the first sandbox, created a second, and resumed session ${JSON.stringify(sessionId)} with continuity of prior output observed`,
    );
  } finally {
    await driver.destroy(handle2);
  }
}

// --- 8. interrupt a running agent --------------------------------------------------------------

export async function runInterruptRunningAgent<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, probe } = ctx;
  const handle = await createSandbox(driver, 'interrupt', 'interrupt');
  try {
    const marker = `a12-interrupt-${randomUUID()}`;
    const connection = await driver.startAgent(
      handle,
      probe.agent.buildRequest({ kind: 'long-running', marker }),
    );

    // Let the turn actually start before interrupting it, so a pass proves interrupt() stopped
    // something that was really running rather than a turn that had already finished.
    const events: TEvent[] = [];
    const iterator = connection.events[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (!first.done) {
      events.push(first.value);
    }
    await connection.interrupt();
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    const outcome = probe.agent.interpretEvents(events);
    if (!outcome.wasInterrupted) {
      return fail(
        'interrupt() was called on a running turn but its own events never recorded an interruption',
      );
    }
    return pass('interrupt() stopped a running turn, recorded in its own event stream');
  } finally {
    await driver.destroy(handle);
  }
}
