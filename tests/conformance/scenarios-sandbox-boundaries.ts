/** A.12 scenarios 5, 6 and 10: network policy and host configuration visibility. */
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { fail, makeTempWorkspace, pass, type A12RunOutcome } from './support.js';
import {
  createSandbox,
  drainEvents,
  runAgentAction,
  type A12ScenarioContext,
} from './scenario-types.js';
import type { A12AgentOutcome } from './types.js';

// --- 5 & 6. enforce networkPolicy "none" / "restricted" ---------------------------------------

const NETWORK_ALLOWED_HOST = 'gateway.internal.a12-fixture';
const NETWORK_BLOCKED_HOST = 'blocked.external.a12-fixture';

type NetworkReach = NonNullable<A12AgentOutcome['network']>;

function judgeNetworkNone(network: NetworkReach): A12RunOutcome {
  if (network.blockedReachable) {
    return fail(
      `capabilities.networkPolicies claims "none" is supported (all non-gateway egress blocked), but the sandbox reached ${JSON.stringify(NETWORK_BLOCKED_HOST)}`,
    );
  }
  return pass(
    `networkPolicy "none": ${JSON.stringify(NETWORK_BLOCKED_HOST)} was unreachable, as claimed`,
  );
}

function judgeNetworkRestricted(network: NetworkReach): A12RunOutcome {
  if (!network.allowedReachable) {
    return fail(
      `capabilities.networkPolicies claims "allowlist" is supported, but the sandbox could not reach the allowed host ${JSON.stringify(NETWORK_ALLOWED_HOST)}`,
    );
  }
  if (network.blockedReachable) {
    return fail(
      `capabilities.networkPolicies claims "allowlist" is supported, but the sandbox reached the host it should have blocked, ${JSON.stringify(NETWORK_BLOCKED_HOST)}`,
    );
  }
  return pass(
    `networkPolicy "restricted": ${JSON.stringify(NETWORK_ALLOWED_HOST)} reachable, ${JSON.stringify(NETWORK_BLOCKED_HOST)} blocked, as claimed`,
  );
}

export async function runEnforceNetworkPolicy<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
  policy: 'none' | 'restricted',
): Promise<A12RunOutcome> {
  const { driver } = ctx;
  const handle = await createSandbox(driver, `network-${policy}`, `net-${policy}`);
  try {
    const outcome = await runAgentAction(ctx, handle, {
      kind: 'network-probe',
      allowedHost: NETWORK_ALLOWED_HOST,
      blockedHost: NETWORK_BLOCKED_HOST,
    });
    if (!outcome.network) {
      return fail(
        'the network-probe request produced events that report reachability for neither host',
      );
    }
    return policy === 'none'
      ? judgeNetworkNone(outcome.network)
      : judgeNetworkRestricted(outcome.network);
  } finally {
    await driver.destroy(handle);
  }
}

// --- 10. no host .claude configuration is visible inside the sandbox ---------------------------

/**
 * ADR-0047: a probe establishes its own precondition; it never inherits one from the host. The
 * REAL `homedir()/.claude` may not exist at all — every CI runner this programme is gated on has
 * none — and round 2's fix, which asked about that real path directly, could not distinguish "the
 * sandbox refused to read it" from "there was never anything there to read": both are `readPath:
 * { succeeded: false }`. So this scenario seeds its OWN marker, at a host location it designates
 * as "the Claude configuration root" for this run only, and asks the sandbox to read THAT — never
 * the real `~/.claude` (a probe must not write into the operator's own configuration, and a check
 * that only works on a machine that happens to have one is the defect being repaired). The read
 * is always meaningful, because the harness itself just wrote what is being asked for, so the
 * verdict no longer depends on what this machine's real home directory happens to contain.
 */
async function seedDesignatedConfigMarker(): Promise<{
  readonly root: string;
  readonly markerPath: string;
}> {
  const root = await makeTempWorkspace('designated-host-claude-config');
  const markerPath = path.join(root, 'CLAUDE.md');
  await writeFile(
    markerPath,
    `a12 scenario 10's own designated-host-config marker — ${randomUUID()}`,
    'utf8',
  );
  return { root, markerPath };
}

function configProblems(
  label: string,
  outcome: A12AgentOutcome,
  designatedHostConfigRoot: string,
): readonly string[] {
  if (!outcome.config) {
    return [`session ${label}'s probe reported no configuration at all`];
  }
  const problems: string[] = [];
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
  return problems;
}

function sessionConfigProblems(
  outcomeA: A12AgentOutcome,
  outcomeB: A12AgentOutcome,
  designatedHostConfigRoot: string,
): readonly string[] {
  const problems = [
    ...configProblems('A', outcomeA, designatedHostConfigRoot),
    ...configProblems('B', outcomeB, designatedHostConfigRoot),
  ];
  if (
    outcomeA.config &&
    outcomeB.config &&
    outcomeA.config.claudeConfigDir === outcomeB.config.claudeConfigDir
  ) {
    problems.push('both sessions were given the same CLAUDE_CONFIG_DIR');
  }
  return problems;
}

export async function runNoHostClaudeConfigVisible<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, probe } = ctx;
  const { root: designatedHostConfigRoot, markerPath } = await seedDesignatedConfigMarker();

  const handleA = await createSandbox(driver, 'claude-config-a', 'config-a');
  const handleB = await createSandbox(driver, 'claude-config-b', 'config-b');
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
    const problems = sessionConfigProblems(
      probe.agent.interpretEvents(eventsA),
      probe.agent.interpretEvents(eventsB),
      designatedHostConfigRoot,
    );
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
    const crossReadOutcome = await runAgentAction(ctx, handleA, {
      kind: 'read-path',
      target: { locus: 'host', absolutePath: markerPath },
    });
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
