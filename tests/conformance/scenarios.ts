/**
 * `tests/conformance/scenarios.ts` — the ten A.12 scenarios, each a `{ id, name, requirement, run
 * }` record. `tests/conformance/harness.ts` is the only thing that iterates this table; it decides
 * `unsupported-by-capability` from `requirement` without ever calling `run`, so a scenario a
 * driver's capabilities do not claim is never attempted at all — that is what keeps the suite from
 * being able to "pass by weakening the test" (A.12).
 *
 * `name` is transcribed by hand from `docs/spec.md`'s A.12 fenced block, once per scenario.
 * `tests/conformance/scenario-names.test.ts` is what proves each of these ten strings still equals
 * the corresponding line the spec actually contains, read with
 * `tests/conformance/spec-scenarios.ts`'s parser rather than remembered — this file does not
 * re-read `docs/spec.md` itself, so a scenario's behaviour never depends on the document parsing
 * at run time.
 *
 * ## Why most `requirement`s are unconditional
 *
 * `RuntimeCapabilities` (spec §14.5) has ten fields, and three of them each name exactly one
 * scenario: `networkPolicies` is what scenarios 5 and 6 are *about*, and `maxSessionSeconds` — the
 * one field that *is* a timeout ceiling — is what scenario 7 is about (round 2 of this task: round
 * 1 gated scenario 7 on `isolation` instead, a field scenario 7 never reads; see
 * `docs/adr/W3-QA-02-a12-conformance-harness-design.md`'s round-2 addendum). `isolation` remains
 * the field general enough to gate scenario 9, which is structurally impossible without some real
 * isolation boundary. Nothing in `RuntimeCapabilities` lets a driver opt out of the rest — file
 * transfer (§15.3), a working `startAgent`/`sessionId` contract, honouring `interrupt()`, and not
 * leaking host `.claude` state (§14.7) are baseline obligations of *any* `RuntimeDriver`, not
 * features a driver can decline. A driver that cannot do one of those has a defect this suite
 * reports as `fail`, never as `unsupported-by-capability` — ADR-0015: `unsupported-by-capability`
 * is available only where a real field says so, never invented to cover an absent one. Scenario
 * 10 is exactly this case for `local`: `local` declares `isolation: 'none'` with no field that
 * lets it decline §14.7, so it fails this scenario for real on every host — round 3's fix
 * (ADR-0047) seeds the scenario's own marker at a host location it designates, rather than asking
 * about this machine's real `~/.claude` (which round 2's version did, and which a host with no
 * `~/.claude` at all — every CI runner — could never fail against; see `a12-local.test.ts`) —
 * never the `pass` round 1 fabricated unconditionally, and never a verdict round 2 left dependent
 * on the machine running it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { fail, makeTempWorkspace, pass, type A12RunOutcome } from './support.js';
import type { A12Probe, A12ScenarioId, RuntimeCapabilities, RuntimeDriver } from './types.js';

/** Everything one scenario's `run()` needs. */
export type A12ScenarioContext<TRequest, TEvent> = {
  readonly driver: RuntimeDriver<TRequest, TEvent>;
  readonly capabilities: RuntimeCapabilities;
  readonly probe: A12Probe<TRequest, TEvent>;
};

/** A verdict on whether a driver's declared capabilities claim a scenario at all. */
export type A12Requirement =
  { readonly met: true } | { readonly met: false; readonly reason: string };

export type A12Scenario<TRequest, TEvent> = {
  readonly id: A12ScenarioId;
  /** The verbatim A.12 line (see this file's header). */
  readonly name: string;
  readonly requirement: (
    capabilities: RuntimeCapabilities,
    driver: RuntimeDriver<TRequest, TEvent>,
  ) => A12Requirement;
  readonly run: (ctx: A12ScenarioContext<TRequest, TEvent>) => Promise<A12RunOutcome>;
};

const ALWAYS_REQUIRED: A12Requirement = { met: true };

async function drainEvents<TEvent>(events: AsyncIterable<TEvent>): Promise<TEvent[]> {
  const collected: TEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

// --- 1. create and destroy a runtime --------------------------------------------------------

async function runCreateAndDestroy<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, probe } = ctx;
  const workspacePath = await makeTempWorkspace('create-destroy');
  const handle = await driver.create({
    engine: 'claude-agent-sdk',
    sessionId: `a12-create-destroy-${randomUUID()}`,
    workspacePath,
  });

  const problems: string[] = [];
  if (handle.driver !== driver.id) {
    problems.push(
      `handle.driver is ${JSON.stringify(handle.driver)}, expected ${JSON.stringify(driver.id)}`,
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
  if (problems.length > 0) {
    return fail(`create() returned a malformed RuntimeHandle: ${problems.join('; ')}`);
  }

  await driver.destroy(handle);

  let startedAfterDestroy = false;
  try {
    await driver.startAgent(
      handle,
      probe.agent.buildRequest({ kind: 'trivial', marker: 'a12-post-destroy-probe' }),
    );
    startedAfterDestroy = true;
  } catch {
    // Expected: the runtime destroy() ended must not still be usable.
  }
  if (startedAfterDestroy) {
    return fail(
      'startAgent() on a handle that destroy() already ended did not reject — the runtime is not actually gone',
    );
  }

  return pass(
    `created handle ${JSON.stringify(handle.id)}, destroyed it, and confirmed it can no longer start an agent`,
  );
}

// --- 2. run a trivial agent turn and stream events ------------------------------------------

async function runTrivialAgentTurn<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, probe } = ctx;
  const workspacePath = await makeTempWorkspace('trivial-turn');
  const handle = await driver.create({
    engine: 'claude-agent-sdk',
    sessionId: `a12-turn-${randomUUID()}`,
    workspacePath,
  });
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

// --- 3. hydrate files in, collect files out --------------------------------------------------

async function runHydrateAndCollectFiles<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, capabilities, probe } = ctx;
  const workspacePath = await makeTempWorkspace('hydrate-collect');
  const handle = await driver.create({
    engine: 'claude-agent-sdk',
    sessionId: `a12-files-${randomUUID()}`,
    workspacePath,
  });
  try {
    const relPath = 'inbound/greeting.txt';
    const content = `hello from A.12 — ${randomUUID()}`;
    const outRelPath = 'outbound/farewell.txt';
    const outContent = `goodbye from A.12 — ${randomUUID()}`;

    if (typeof driver.putFiles === 'function' && typeof driver.getFiles === 'function') {
      if (!probe.fileTransfer) {
        return fail(
          'driver implements putFiles/getFiles but no A12FileTransferProbe was supplied to build/read an archive for it',
        );
      }
      await driver.putFiles(handle, probe.fileTransfer.buildArchive(relPath, content));

      // The putFiles/getFiles round trip above proves the DRIVER's own store preserved the bytes —
      // it says nothing about whether the SANDBOX startAgent connects to can see them. ADR-0046's
      // question, asked of this branch: a driver whose `startAgent` can never run anything (round
      // 1's PROBE 4, one branch over) reports this round trip as fine, because the agent is never
      // asked. So it is asked: a `read-path` action, targeted at this handle's own workspace,
      // driven through the same `startAgent` every other scenario uses.
      const readConnection = await driver.startAgent(
        handle,
        probe.agent.buildRequest({
          kind: 'read-path',
          target: { locus: 'workspace', handle, relativePath: relPath },
        }),
      );
      const readOutcome = probe.agent.interpretEvents(await drainEvents(readConnection.events));
      if (readOutcome.readPath === undefined) {
        return fail(
          `the probe reported no result for a read-path action against ${JSON.stringify(relPath)}, just hydrated through putFiles — the sandbox startAgent runs in was never asked whether it could see it`,
        );
      }
      if (!readOutcome.readPath.succeeded || readOutcome.readPath.content !== content) {
        return fail(
          `putFiles hydrated ${JSON.stringify(relPath)}, but the sandbox startAgent connects to could not read it back (succeeded=${String(readOutcome.readPath.succeeded)}, content=${JSON.stringify(readOutcome.readPath.content)}) — a putFiles/getFiles round trip through the driver's own store does not prove the agent can see the file`,
        );
      }

      // "Collect out", the same way: the sandbox itself creates a file through `startAgent`, and
      // only THEN does the harness collect it — via `getFiles`, never by re-reading the store
      // `putFiles` wrote to directly, which would prove nothing about whether the write crossed
      // into the sandbox at all.
      const writeConnection = await driver.startAgent(
        handle,
        probe.agent.buildRequest({
          kind: 'write-path',
          target: { locus: 'workspace', handle, relativePath: outRelPath },
          content: outContent,
        }),
      );
      const writeOutcome = probe.agent.interpretEvents(await drainEvents(writeConnection.events));
      if (writeOutcome.writePath === undefined) {
        return fail(
          `the probe reported no result for a write-path action inside the sandbox (${outRelPath}) — collection was never attempted`,
        );
      }
      if (!writeOutcome.writePath.succeeded) {
        return fail(`the sandbox could not create ${outRelPath} for collection`);
      }
      const collected = await probe.fileTransfer.readArchive(
        await driver.getFiles(handle, [outRelPath]),
      );
      const collectedBack = collected.get(outRelPath);
      if (collectedBack !== outContent) {
        return fail(
          `getFiles returned ${JSON.stringify(collectedBack)} for ${outRelPath} after the sandbox's own write-path action created it, expected ${JSON.stringify(outContent)} — getFiles did not read back what the agent itself wrote`,
        );
      }

      return pass(
        `hydrated ${JSON.stringify(relPath)} via putFiles and had it read back through the driver from inside the sandbox startAgent runs in, and collected ${JSON.stringify(outRelPath)} via getFiles only after that same sandbox created it through a write-path action (putFiles/getFiles branch)`,
      );
    }

    if (capabilities.persistentFilesystem) {
      // "Hydrate in" — write to the mount from the host side, which is exactly what
      // `persistentFilesystem: true` claims is visible without putFiles/getFiles. But writing and
      // reading it back with `node:fs` in THIS process, again, proves nothing about the sandbox —
      // it is the same boundary-free round trip ADR-0046 forbids. The driver has to be asked, and
      // asked with a WORKSPACE-relative target: this scenario does not know, and must not assume,
      // that a driver's in-sandbox view of its own workspace resolves the same string as
      // `handle.workspacePath` does on the host (a real container's bind mount is a case where it
      // never does) — resolving `relPath` against this `handle` is the probe's job, not this one's.
      const absPath = path.join(handle.workspacePath, relPath);
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');

      const readConnection = await driver.startAgent(
        handle,
        probe.agent.buildRequest({
          kind: 'read-path',
          target: { locus: 'workspace', handle, relativePath: relPath },
        }),
      );
      const readOutcome = probe.agent.interpretEvents(await drainEvents(readConnection.events));
      if (readOutcome.readPath === undefined) {
        return fail(
          `the probe reported no result for a read-path action against the hydrated file (${relPath}) — hydration was never observed from inside the sandbox`,
        );
      }
      if (!readOutcome.readPath.succeeded || readOutcome.readPath.content !== content) {
        return fail(
          `the sandbox could not read back the hydrated file at ${relPath} (succeeded=${String(readOutcome.readPath.succeeded)}, content=${JSON.stringify(readOutcome.readPath.content)}) — hydration did not cross into the sandbox`,
        );
      }

      // "Collect out" — the other direction: the sandbox creates a file, and only then does the
      // harness read it from the host side. A driver whose `startAgent` never runs anything for
      // real cannot fake either half, because both now go through it.
      const outAbsPath = path.join(handle.workspacePath, outRelPath);
      const writeConnection = await driver.startAgent(
        handle,
        probe.agent.buildRequest({
          kind: 'write-path',
          target: { locus: 'workspace', handle, relativePath: outRelPath },
          content: outContent,
        }),
      );
      const writeOutcome = probe.agent.interpretEvents(await drainEvents(writeConnection.events));
      if (writeOutcome.writePath === undefined) {
        return fail(
          `the probe reported no result for a write-path action inside the sandbox (${outRelPath}) — collection was never attempted`,
        );
      }
      if (!writeOutcome.writePath.succeeded) {
        return fail(`the sandbox could not create ${outRelPath} for collection`);
      }
      const collectedBack = await readFile(outAbsPath, 'utf8');
      if (collectedBack !== outContent) {
        return fail(
          `collected ${JSON.stringify(collectedBack)} from ${outAbsPath} after the sandbox wrote it, expected ${JSON.stringify(outContent)}`,
        );
      }

      return pass(
        `hydrated ${JSON.stringify(relPath)} into the mounted workspace and had it read back through the driver from inside the sandbox, and collected ${JSON.stringify(outRelPath)} from the host side only after the sandbox itself created it (persistentFilesystem: true, no putFiles/getFiles declared)`,
      );
    }

    return fail(
      'driver has neither putFiles/getFiles nor persistentFilesystem — §15.3 requires one of the two and this driver declares neither',
    );
  } finally {
    await driver.destroy(handle);
  }
}

// --- 4. resume a session after the sandbox is gone -------------------------------------------

async function runResumeAfterSandboxGone<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, probe } = ctx;

  const marker1 = `a12-resume-first-${randomUUID()}`;
  const workspace1 = await makeTempWorkspace('resume-1');
  const handle1 = await driver.create({
    sessionId: `a12-resume-${randomUUID()}`,
    engine: 'claude-agent-sdk',
    workspacePath: workspace1,
  });
  let sessionId: string;
  try {
    const connection1 = await driver.startAgent(
      handle1,
      probe.agent.buildRequest({ kind: 'trivial', marker: marker1 }),
    );
    await drainEvents(connection1.events);
    sessionId = await connection1.sessionId;
  } finally {
    await driver.destroy(handle1); // the sandbox is now gone
  }

  const marker2 = `a12-resume-second-${randomUUID()}`;
  const workspace2 = await makeTempWorkspace('resume-2'); // a genuinely different, fresh sandbox
  const handle2 = await driver.create({
    sessionId: `a12-resume-${randomUUID()}`,
    engine: 'claude-agent-sdk',
    workspacePath: workspace2,
  });
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

// --- 5 & 6. enforce networkPolicy "none" / "restricted" ---------------------------------------

const NETWORK_ALLOWED_HOST = 'gateway.internal.a12-fixture';
const NETWORK_BLOCKED_HOST = 'blocked.external.a12-fixture';

async function runEnforceNetworkPolicy<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
  policy: 'none' | 'restricted',
): Promise<A12RunOutcome> {
  const { driver, probe } = ctx;
  const workspacePath = await makeTempWorkspace(`network-${policy}`);
  const handle = await driver.create({
    engine: 'claude-agent-sdk',
    sessionId: `a12-net-${policy}-${randomUUID()}`,
    workspacePath,
  });
  try {
    const connection = await driver.startAgent(
      handle,
      probe.agent.buildRequest({
        kind: 'network-probe',
        allowedHost: NETWORK_ALLOWED_HOST,
        blockedHost: NETWORK_BLOCKED_HOST,
      }),
    );
    const events = await drainEvents(connection.events);
    const outcome = probe.agent.interpretEvents(events);
    if (!outcome.network) {
      return fail(
        'the network-probe request produced events that report reachability for neither host',
      );
    }

    if (policy === 'none') {
      if (outcome.network.blockedReachable) {
        return fail(
          `capabilities.networkPolicies claims "none" is supported (all non-gateway egress blocked), but the sandbox reached ${JSON.stringify(NETWORK_BLOCKED_HOST)}`,
        );
      }
      return pass(
        `networkPolicy "none": ${JSON.stringify(NETWORK_BLOCKED_HOST)} was unreachable, as claimed`,
      );
    }

    if (!outcome.network.allowedReachable) {
      return fail(
        `capabilities.networkPolicies claims "allowlist" is supported, but the sandbox could not reach the allowed host ${JSON.stringify(NETWORK_ALLOWED_HOST)}`,
      );
    }
    if (outcome.network.blockedReachable) {
      return fail(
        `capabilities.networkPolicies claims "allowlist" is supported, but the sandbox reached the host it should have blocked, ${JSON.stringify(NETWORK_BLOCKED_HOST)}`,
      );
    }
    return pass(
      `networkPolicy "restricted": ${JSON.stringify(NETWORK_ALLOWED_HOST)} reachable, ${JSON.stringify(NETWORK_BLOCKED_HOST)} blocked, as claimed`,
    );
  } finally {
    await driver.destroy(handle);
  }
}

// --- 7. enforce cpu / memory / timeout limits -------------------------------------------------

/**
 * How long past a driver's own declared `maxSessionSeconds` this scenario waits before concluding
 * nothing enforced it. This is patience for the DRIVER's enforcement to land, never the mechanism
 * that stops the turn — ADR-0046 rule 2: "the gate must not supply the force it is testing for."
 * Compare round 1, which called `connection.interrupt()` itself and then asserted the turn had
 * stopped — the harness supplying its own force, which is scenario 8's subject, not scenario 7's,
 * and which passed unconditionally regardless of what (if anything) the driver enforced.
 *
 * The whole budget (`maxSessionSeconds` + this grace) is ONE `setTimeout`, armed once before the
 * turn's first `.next()` and raced by every `.next()` after it. It is never measured with
 * `Date.now()` (issue #562): a driver enforces its ceiling on Node's monotonic timer clock, and
 * comparing that with the wall clock failed an enforcing driver twice over. A forward wall-clock
 * jump (WSL2 steps the guest clock under load) made the budget "elapse" before the driver's limit
 * timer could fire; and after an event-loop stall a synchronous `Date.now()` re-check declared the
 * timeout before the driver's already-due limit timer had been dispatched. With one monotonic
 * timer armed first, a driver's limit timer armed later for a shorter delay expires earlier, and
 * Node dispatches due timers in expiry order, draining microtasks between callbacks.
 *
 * That ordering guarantee is narrower than "any enforcing driver survives any stall". It holds for
 * a driver that (a) arms its limit timer no later than the turn's first events, with no I/O hop
 * between this scenario arming the budget and the driver arming its limit — as the enforcing
 * fixture does — and (b) finishes the enforcement in microtasks once that timer fires. A driver
 * that arms its ceiling after an I/O hop, or whose kill needs another macrotask (`setImmediate`,
 * a process exit over I/O), can still lose to a stall that lands in that gap: once both timers are
 * overdue, this scenario's patience fires in the same timers phase, before the kill lands. That is
 * the same as before issue #562 and is a property of measuring a deadline at all; this grace is
 * what absorbs it in an unstalled process.
 */
const RESOURCE_LIMIT_GRACE_MS = 1_000;

/**
 * The longest delay Node's `setTimeout` honours (2^31 - 1 ms, about 24.8 days). A larger, NaN or
 * infinite delay is clamped to 1 ms with only a process warning, so a budget past it would make
 * this scenario report "nothing enforced it" within milliseconds — a false fail with a misleading
 * detail. Such a ceiling is rejected up front with a precise detail instead.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

async function runEnforceResourceLimits<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, capabilities, probe } = ctx;
  const ceilingSeconds = capabilities.maxSessionSeconds;
  if (ceilingSeconds === null) {
    // The `requirement` below gates on this exact field, so `run` should never be reached with a
    // null ceiling — this is a defensive `fail`, not a reachable branch, per ADR-0015: a check
    // that cannot proceed must reject, never silently proceed as if a ceiling existed.
    return fail(
      'scenario ran without a declared capabilities.maxSessionSeconds ceiling to enforce against',
    );
  }
  // Validated before the driver is touched: a ceiling that is not a finite positive number, or
  // whose budget a single timer cannot hold, cannot be enforced against — reject it precisely
  // rather than let `setTimeout` clamp the budget to 1 ms and blame the driver (ADR-0015).
  if (!Number.isFinite(ceilingSeconds) || ceilingSeconds <= 0) {
    return fail(
      `capabilities.maxSessionSeconds must be a finite number of seconds greater than 0 to enforce against, but the driver declared ${String(ceilingSeconds)}`,
    );
  }
  const budgetMs = ceilingSeconds * 1_000 + RESOURCE_LIMIT_GRACE_MS;
  if (budgetMs > MAX_TIMER_DELAY_MS) {
    return fail(
      `capabilities.maxSessionSeconds declares ${String(ceilingSeconds)}s, whose budget (${String(budgetMs)}ms with grace) exceeds the longest timer this scenario can arm (${String(MAX_TIMER_DELAY_MS)}ms), so the ceiling cannot be checked`,
    );
  }
  const workspacePath = await makeTempWorkspace('limits');
  const handle = await driver.create({
    engine: 'claude-agent-sdk',
    sessionId: `a12-limits-${randomUUID()}`,
    workspacePath,
  });
  try {
    const marker = `a12-limits-${randomUUID()}`;
    const connection = await driver.startAgent(
      handle,
      probe.agent.buildRequest({ kind: 'long-running', marker }),
    );

    // No call to `connection.interrupt()` anywhere in this function while the turn is live — the
    // ONLY thing that may end this turn is the driver's own enforcement of the ceiling it
    // declared. `patience$` is this scenario's patience, not a stopping force: one monotonic
    // timer armed before the turn's first `.next()`, which every `.next()` below races, so nothing
    // here ever pre-empts the turn itself (see `RESOURCE_LIMIT_GRACE_MS` for why not `Date.now()`).
    const TIMED_OUT = Symbol('a12-resource-limit-timed-out');
    let patienceTimer: ReturnType<typeof setTimeout> | undefined;
    const patience$ = new Promise<typeof TIMED_OUT>((resolve) => {
      patienceTimer = setTimeout(() => {
        resolve(TIMED_OUT);
      }, budgetMs);
    });
    const iterator = connection.events[Symbol.asyncIterator]();
    const events: TEvent[] = [];
    let timedOut = false;
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), patience$]);
        if (next === TIMED_OUT) {
          timedOut = true;
          break;
        }
        if (next.done) break;
        events.push(next.value);
      }
    } finally {
      clearTimeout(patienceTimer);
    }

    if (timedOut) {
      // The budget the driver itself declared has already elapsed with nothing stopping the turn
      // — the verdict is `fail` regardless of what happens next. `interrupt()` here is cleanup so
      // the process can exit, not part of the check: it runs only after the fail is already
      // decided.
      await connection.interrupt();
      for (;;) {
        const next = await iterator.next().catch(() => ({ done: true as const, value: undefined }));
        if (next.done) break;
      }
      return fail(
        `capabilities.maxSessionSeconds claims ${String(ceilingSeconds)}s, but a long-running turn was still running ${String(RESOURCE_LIMIT_GRACE_MS)}ms past that ceiling — nothing enforced it`,
      );
    }

    const outcome = probe.agent.interpretEvents(events);
    if (!outcome.wasInterrupted) {
      return fail(
        `the turn ended within capabilities.maxSessionSeconds (${String(ceilingSeconds)}s) but its own events never recorded that it had been stopped by an enforced limit`,
      );
    }
    return pass(
      `a long-running turn was stopped by the driver's own enforcement of its declared maxSessionSeconds (${String(ceilingSeconds)}s, +${String(RESOURCE_LIMIT_GRACE_MS)}ms grace) — this scenario never called interrupt() while the turn was live`,
    );
  } finally {
    await driver.destroy(handle);
  }
}

// --- 8. interrupt a running agent --------------------------------------------------------------

async function runInterruptRunningAgent<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, probe } = ctx;
  const workspacePath = await makeTempWorkspace('interrupt');
  const handle = await driver.create({
    engine: 'claude-agent-sdk',
    sessionId: `a12-interrupt-${randomUUID()}`,
    workspacePath,
  });
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

// --- 9. concurrent sessions do not see each other's files --------------------------------------

async function runConcurrentSessionsFileIsolation<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, capabilities, probe } = ctx;
  const workspaceA = await makeTempWorkspace('concurrent-a');
  const workspaceB = await makeTempWorkspace('concurrent-b');
  const [handleA, handleB] = await Promise.all([
    driver.create({
      engine: 'claude-agent-sdk',
      sessionId: `a12-concurrent-a-${randomUUID()}`,
      workspacePath: workspaceA,
    }),
    driver.create({
      engine: 'claude-agent-sdk',
      sessionId: `a12-concurrent-b-${randomUUID()}`,
      workspacePath: workspaceB,
    }),
  ]);
  try {
    const contentA = `owned-by-a-${randomUUID()}`;
    const contentB = `owned-by-b-${randomUUID()}`;
    const problems: string[] = [];
    const usesFileTransfer =
      typeof driver.putFiles === 'function' && typeof driver.getFiles === 'function';

    if (typeof driver.putFiles === 'function' && typeof driver.getFiles === 'function') {
      if (!probe.fileTransfer) {
        return fail('driver implements putFiles/getFiles but no A12FileTransferProbe was supplied');
      }
      await Promise.all([
        driver.putFiles(handleA, probe.fileTransfer.buildArchive('mine.txt', contentA)),
        driver.putFiles(handleB, probe.fileTransfer.buildArchive('mine.txt', contentB)),
      ]);
      const [seenByA, seenByB] = await Promise.all([
        probe.fileTransfer.readArchive(await driver.getFiles(handleA, ['mine.txt'])),
        probe.fileTransfer.readArchive(await driver.getFiles(handleB, ['mine.txt'])),
      ]);
      if (seenByA.get('mine.txt') !== contentA)
        problems.push(`session A saw ${JSON.stringify(seenByA.get('mine.txt'))}, not its own file`);
      if (seenByB.get('mine.txt') !== contentB)
        problems.push(`session B saw ${JSON.stringify(seenByB.get('mine.txt'))}, not its own file`);
    } else if (capabilities.persistentFilesystem) {
      await Promise.all([
        writeFile(path.join(handleA.workspacePath, 'mine.txt'), contentA, 'utf8'),
        writeFile(path.join(handleB.workspacePath, 'mine.txt'), contentB, 'utf8'),
      ]);
      const [readA, readB] = await Promise.all([
        readFile(path.join(handleA.workspacePath, 'mine.txt'), 'utf8'),
        readFile(path.join(handleB.workspacePath, 'mine.txt'), 'utf8'),
      ]);
      if (readA !== contentA)
        problems.push(
          `session A read back ${JSON.stringify(readA)}, not its own ${JSON.stringify(contentA)}`,
        );
      if (readB !== contentB)
        problems.push(
          `session B read back ${JSON.stringify(readB)}, not its own ${JSON.stringify(contentB)}`,
        );
      if (handleA.workspacePath === handleB.workspacePath)
        problems.push('both sessions were given the same workspacePath');
    } else {
      return fail(
        'driver has neither putFiles/getFiles nor persistentFilesystem — cannot demonstrate file isolation at all',
      );
    }

    // The adversarial half: from inside A's own sandbox, try to read a file that exists only in
    // B's workspace — named as a target RELATIVE TO B's own handle, never as a path this scenario
    // pre-resolved itself (ADR-0046/W3-QA-02's path-target repair: on the putFiles/getFiles branch
    // above, "B's workspace" is not a host path at all, so a host-absolute guess built from
    // `handleB.workspacePath` would name a location that branch never wrote to and every driver
    // would report `false` for the wrong reason — see this task's ADR, "C2"). A driver whose
    // `isolation` is real (checked by this scenario's `requirement`) is expected to refuse this
    // regardless of which branch it took above; a driver that lets it through has not isolated
    // concurrent sessions, which is exactly what this scenario's name asserts against.
    const crossReadConnection = await driver.startAgent(
      handleA,
      probe.agent.buildRequest({
        kind: 'read-path',
        target: { locus: 'workspace', handle: handleB, relativePath: 'mine.txt' },
      }),
    );
    const crossReadEvents = await drainEvents(crossReadConnection.events);
    const crossReadOutcome = probe.agent.interpretEvents(crossReadEvents);
    // ADR-0015 / ADR-0046 rule 3: an absent answer is `fail`, never a skipped branch. `x?.y` in
    // an `if` silently treats "the probe never reported readPath at all" the same as "readPath
    // reported succeeded: false" — round 1's bug. A probe that does not implement the `read-path`
    // seam must not get a free pass on the adversarial check it never actually ran.
    if (crossReadOutcome.readPath === undefined) {
      problems.push(
        "session A's read-path probe reported no result at all for session B's mine.txt — the adversarial cross-read check never ran",
      );
    } else if (crossReadOutcome.readPath.succeeded) {
      problems.push("session A's own sandbox could read session B's file (mine.txt)");
    }

    // The mounted-filesystem branch has a second, distinct boundary to prove: even when a probe
    // correctly rejects a workspace target carrying another handle, A's sandbox must not be able
    // to reach B's host-side mount by absolute path. The transfer branch deliberately does not run
    // this check because its workspace may have no host path at all (C2); the mounted branch does
    // because that host mount is the property persistentFilesystem exposes (ADR-0048).
    if (!usesFileTransfer && capabilities.persistentFilesystem) {
      const hostCrossReadConnection = await driver.startAgent(
        handleA,
        probe.agent.buildRequest({
          kind: 'read-path',
          target: {
            locus: 'host',
            absolutePath: path.join(handleB.workspacePath, 'mine.txt'),
          },
        }),
      );
      const hostCrossReadOutcome = probe.agent.interpretEvents(
        await drainEvents(hostCrossReadConnection.events),
      );
      if (hostCrossReadOutcome.readPath === undefined) {
        problems.push(
          "session A's read-path probe reported no result for session B's host-side mounted file — the mounted-workspace containment check never ran",
        );
      } else if (hostCrossReadOutcome.readPath.succeeded) {
        problems.push("session A's own sandbox could read session B's host-side mounted file");
      }
    }

    if (problems.length > 0) {
      return fail(problems.join('; '));
    }
    return pass(
      `two concurrent sessions each wrote and read back only their own file, and A's sandbox could not read B's file even when asked for it by B's own handle`,
    );
  } finally {
    await Promise.all([driver.destroy(handleA), driver.destroy(handleB)]);
  }
}

// --- 10. no host .claude configuration is visible inside the sandbox ---------------------------

async function runNoHostClaudeConfigVisible<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, probe } = ctx;

  // ADR-0047: a probe establishes its own precondition; it never inherits one from the host. The
  // REAL `homedir()/.claude` may not exist at all — every CI runner this programme is gated on has
  // none — and round 2's fix, which asked about that real path directly, could not distinguish "the
  // sandbox refused to read it" from "there was never anything there to read": both are `readPath:
  // { succeeded: false }`. So this scenario seeds its OWN marker, at a host location it designates
  // as "the Claude configuration root" for this run only, and asks the sandbox to read THAT — never
  // the real `~/.claude` (a probe must not write into the operator's own configuration, and a check
  // that only works on a machine that happens to have one is the defect being repaired). The read
  // is always meaningful, because the harness itself just wrote what is being asked for, so the
  // verdict no longer depends on what this machine's real home directory happens to contain.
  const designatedHostConfigRoot = await makeTempWorkspace('designated-host-claude-config');
  const markerPath = path.join(designatedHostConfigRoot, 'CLAUDE.md');
  await writeFile(
    markerPath,
    `a12 scenario 10's own designated-host-config marker — ${randomUUID()}`,
    'utf8',
  );

  const workspaceA = await makeTempWorkspace('claude-config-a');
  const workspaceB = await makeTempWorkspace('claude-config-b');
  const handleA = await driver.create({
    sessionId: `a12-config-a-${randomUUID()}`,
    engine: 'claude-agent-sdk',
    workspacePath: workspaceA,
  });
  const handleB = await driver.create({
    sessionId: `a12-config-b-${randomUUID()}`,
    engine: 'claude-agent-sdk',
    workspacePath: workspaceB,
  });
  try {
    const [connectionA, connectionB] = await Promise.all([
      driver.startAgent(
        handleA,
        probe.agent.buildRequest({ kind: 'trivial', marker: 'a12-config-probe-a' }),
      ),
      driver.startAgent(
        handleB,
        probe.agent.buildRequest({ kind: 'trivial', marker: 'a12-config-probe-b' }),
      ),
    ]);
    const [eventsA, eventsB] = await Promise.all([
      drainEvents(connectionA.events),
      drainEvents(connectionB.events),
    ]);
    const outcomeA = probe.agent.interpretEvents(eventsA);
    const outcomeB = probe.agent.interpretEvents(eventsB);

    const problems: string[] = [];
    for (const [label, outcome] of [
      ['A', outcomeA],
      ['B', outcomeB],
    ] as const) {
      if (!outcome.config) {
        problems.push(`session ${label}'s probe reported no configuration at all`);
        continue;
      }
      if (outcome.config.claudeConfigDir === designatedHostConfigRoot) {
        problems.push(
          `session ${label} was given this scenario's own designated host configuration root (${designatedHostConfigRoot}) as its CLAUDE_CONFIG_DIR`,
        );
      }
      if (outcome.config.settingSources.length > 0) {
        problems.push(
          `session ${label} reported non-empty settingSources: ${JSON.stringify(outcome.config.settingSources)}`,
        );
      }
    }
    if (
      outcomeA.config &&
      outcomeB.config &&
      outcomeA.config.claudeConfigDir === outcomeB.config.claudeConfigDir
    ) {
      problems.push('both sessions were given the same CLAUDE_CONFIG_DIR');
    }
    if (problems.length > 0) {
      return fail(problems.join('; '));
    }

    // The question A.12 actually names — *"no host `.claude` configuration is visible inside the
    // sandbox"* — is not "is the config-dir path distinct" (checked above, and kept: it is a
    // legitimate additional assertion, per §14.7's second rule). It is whether a host-side Claude
    // configuration location is REACHABLE FROM INSIDE THE SANDBOX, and that can only be answered by
    // driving a read through the driver — never by re-inspecting a value `buildFixtureRequest`
    // invented itself (ADR-0046), and never by asking about a location this scenario did not itself
    // seed (ADR-0047) — `homedir()`'s real `.claude` may not exist on this machine at all, which
    // would make "the read failed" indistinguishable from "there was nothing to find," exactly the
    // hole round 2's fix left open on every CI runner. The marker seeded above exists because THIS
    // scenario just wrote it, so the read below is meaningful regardless of what this host's own
    // home directory contains.
    const crossReadConnection = await driver.startAgent(
      handleA,
      probe.agent.buildRequest({
        kind: 'read-path',
        target: { locus: 'host', absolutePath: markerPath },
      }),
    );
    const crossReadOutcome = probe.agent.interpretEvents(
      await drainEvents(crossReadConnection.events),
    );
    if (crossReadOutcome.readPath === undefined) {
      return fail(
        `the probe reported no result for a read-path action against this scenario's own designated-host-config marker (${markerPath}) — the question this scenario asks was never answered`,
      );
    }
    if (crossReadOutcome.readPath.succeeded) {
      return fail(
        `a marker this scenario seeded at a host location it designated as the Claude configuration root (${markerPath}), never given to either sandbox's CLAUDE_CONFIG_DIR, was readable from inside the sandbox (content observed: ${JSON.stringify(crossReadOutcome.readPath.content)})`,
      );
    }

    return pass(
      `a marker seeded at a host location this scenario designated as the Claude configuration root (${designatedHostConfigRoot}) — never given to either sandbox's CLAUDE_CONFIG_DIR and never written into the operator's real ~/.claude — was not reachable from inside the sandbox, both sessions reported a CLAUDE_CONFIG_DIR distinct from it and from each other, and both reported empty settingSources. This verdict does not depend on whether this machine has a real ~/.claude of its own (ADR-0047).`,
    );
  } finally {
    await Promise.all([driver.destroy(handleA), driver.destroy(handleB)]);
  }
}

// --- the table -----------------------------------------------------------------------------

/**
 * The ten scenarios, in A.12's own order. `tests/conformance/scenario-names.test.ts` asserts the
 * `name` column against `docs/spec.md`; nothing here re-derives it.
 */
export function a12Scenarios<TRequest, TEvent>(): readonly A12Scenario<TRequest, TEvent>[] {
  return [
    {
      id: 'create-and-destroy',
      name: 'create and destroy a runtime',
      requirement: () => ALWAYS_REQUIRED,
      run: runCreateAndDestroy,
    },
    {
      id: 'trivial-agent-turn',
      name: 'run a trivial agent turn and stream events',
      requirement: () => ALWAYS_REQUIRED,
      run: runTrivialAgentTurn,
    },
    {
      id: 'hydrate-and-collect-files',
      name: 'hydrate files in, collect files out',
      requirement: () => ALWAYS_REQUIRED,
      run: runHydrateAndCollectFiles,
    },
    {
      id: 'resume-after-sandbox-gone',
      name: 'resume a session after the sandbox is gone',
      requirement: () => ALWAYS_REQUIRED,
      run: runResumeAfterSandboxGone,
    },
    {
      id: 'enforce-network-none',
      name: 'enforce networkPolicy "none" (egress to a blocked host fails)',
      requirement: (capabilities) =>
        capabilities.networkPolicies.includes('none')
          ? ALWAYS_REQUIRED
          : {
              met: false,
              reason: `capabilities.networkPolicies is ${JSON.stringify(capabilities.networkPolicies)}, which does not include "none"`,
            },
      run: (ctx) => runEnforceNetworkPolicy(ctx, 'none'),
    },
    {
      id: 'enforce-network-restricted',
      name: 'enforce networkPolicy "restricted" (allowed host succeeds, other host fails)',
      requirement: (capabilities) =>
        capabilities.networkPolicies.includes('allowlist')
          ? ALWAYS_REQUIRED
          : {
              met: false,
              reason: `capabilities.networkPolicies is ${JSON.stringify(capabilities.networkPolicies)}, which does not include "allowlist"`,
            },
      run: (ctx) => runEnforceNetworkPolicy(ctx, 'restricted'),
    },
    {
      id: 'enforce-resource-limits',
      name: 'enforce cpu / memory / timeout limits',
      // Gated on `maxSessionSeconds` — the one `RuntimeCapabilities` field that IS a timeout
      // ceiling — never on `isolation`, which this scenario's `run()` does not read at all. Round
      // 1 gated this on `isolation !== 'none'`, which let a driver claiming `maxSessionSeconds:
      // null` (no ceiling of any kind) still have this scenario attempted and pass (ADR-0046).
      requirement: (capabilities) =>
        capabilities.maxSessionSeconds !== null
          ? ALWAYS_REQUIRED
          : {
              met: false,
              reason:
                'capabilities.maxSessionSeconds is null — no ceiling is declared to enforce against',
            },
      run: runEnforceResourceLimits,
    },
    {
      id: 'interrupt-running-agent',
      name: 'interrupt a running agent',
      requirement: () => ALWAYS_REQUIRED,
      run: runInterruptRunningAgent,
    },
    {
      id: 'concurrent-sessions-file-isolation',
      name: "concurrent sessions do not see each other's files",
      requirement: (capabilities) =>
        capabilities.isolation !== 'none'
          ? ALWAYS_REQUIRED
          : {
              met: false,
              reason:
                'capabilities.isolation is "none" — sessions share one filesystem with no isolation boundary between them',
            },
      run: runConcurrentSessionsFileIsolation,
    },
    {
      id: 'no-host-claude-config-visible',
      name: 'no host .claude configuration is visible inside the sandbox',
      requirement: () => ALWAYS_REQUIRED,
      run: runNoHostClaudeConfigVisible,
    },
  ];
}
