import { isIP } from 'node:net';

import type { PortableAgentConfig } from '@agent-workspace/run-protocol';

import { DomainError } from '../errors';
import { narrowFileGrants } from '../storage-and-sharing';
import { atStep } from '../runs/failures';
import type { RunAgent } from '../agent-versions/session-version';
import type { LaunchContext } from '../execution';
import { withMemoryFiles } from './agent-memory';
import {
  assertRunFilesFit,
  loadAttachedFiles,
  withAttachedFiles,
  type AgentRunResourceLoader,
  type AgentRunResourceSelection,
} from './resource-loader';
import {
  loadResourcesWithinCeiling,
  meetRunCeiling,
  type RunResourceSources,
} from './run-request-ceiling';

/** One granted path: what the read-only denials and the runner's materialisation need to know. */
export interface GrantedPath {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly access: 'read' | 'read-write';
}

export type GrantedFiles = AgentRunResourceSelection['files'] | readonly GrantedPath[];

const lowest = (resolved: number | null, cap: number | undefined): number | null =>
  cap === undefined ? resolved : resolved === null ? cap : Math.min(resolved, cap);

/**
 * The met limits under every override a launch carries: the caller's, in this context, and the one
 * the run row stores. A launch built from the row alone (an approval continuation, a requeue) has
 * only the second. Both lower and neither raises, so applying both is the lower of them.
 */
export function launchLimits(
  limits: PortableAgentConfig['limits'],
  context: Pick<LaunchContext, 'limits' | 'run'>,
): PortableAgentConfig['limits'] {
  return lowerLimits(lowerLimits(limits, context.limits), context.run.limitsOverride ?? undefined);
}

/** The met limits under one run's override: the lower of each, so an override never raises a limit. */
export function lowerLimits(
  limits: PortableAgentConfig['limits'],
  override: LaunchContext['limits'],
): PortableAgentConfig['limits'] {
  return {
    maxTurns: lowest(limits.maxTurns, override?.maxTurns),
    maxBudgetUsd: lowest(limits.maxBudgetUsd, override?.maxBudgetUsd),
  };
}

/**
 * A run's composed limits: the met limits under its overrides ({@link launchLimits}), then under the spend ceiling stored
 * on the run (ADR-0162 decision 2), so the engine's own cap is never looser than the gateway's.
 */
export function runLimitsFor(
  met: PortableAgentConfig['limits'],
  context: LaunchContext,
): PortableAgentConfig['limits'] {
  const ceiling = context.run.spendCeilingUsd;
  return lowerLimits(launchLimits(met, context), {
    ...(ceiling === undefined || ceiling === null ? {} : { maxBudgetUsd: Number(ceiling) }),
  });
}

/**
 * What a run's sandbox may be granted on the network (ADR-0117 decision 9, issue #785): the met
 * `unrestrictedNetwork` switch and the DNS names of the met remote (`http`/`sse`) connectors, which
 * the sandbox itself calls. It narrows exactly as `buildRunRequestFor` does — the stored arm's
 * withholding, then the ceiling's meet, then the connectors the ceiling allows — so a switch the
 * ceiling turned off lowers the network too. IP-literal hosts are left out: the egress proxy
 * allowlist holds names only (ADR-0117 decision 3).
 */
export async function runNetworkGrant(
  context: LaunchContext,
  runAgent: RunAgent,
  sources: RunResourceSources,
): Promise<{ readonly unrestrictedNetwork: boolean; readonly connectorHosts: readonly string[] }> {
  const permissions = context.permissionOverride ?? runAgent.agent.permissions;
  const { met } = meetRunCeiling(
    { agent: runAgent.agent, permissions, model: null },
    sources.ceiling,
  );
  const resources = await runResourcesWithinCeiling(context, runAgent, sources);
  const hosts: string[] = [];
  for (const server of Object.values(resources.mcpServers)) {
    if (!('url' in server) || !URL.canParse(server.url)) continue;
    const host = new URL(server.url).hostname;
    if (isIP(host.replace(/^\[|\]$/g, '')) === 0) hosts.push(host);
  }
  return { unrestrictedNetwork: met.permissions.unrestrictedNetwork, connectorHosts: hosts };
}

/**
 * The run's resources as `buildRunRequestFor` loads them — the session's assignments, the
 * project's (issue #125), capped by the met permissions and the ceiling — for a caller that runs
 * before compose: the network grant, and the input archive, whose files must be the ones the
 * `/run` body references.
 */
export async function runResourcesWithinCeiling(
  context: Pick<LaunchContext, 'permissionOverride'> & {
    readonly principal: Pick<LaunchContext['principal'], 'workspaceId'>;
  },
  runAgent: RunAgent,
  sources: RunResourceSources,
): Promise<AgentRunResourceSelection> {
  const permissions = context.permissionOverride ?? runAgent.agent.permissions;
  const { met } = meetRunCeiling(
    { agent: runAgent.agent, permissions, model: null },
    sources.ceiling,
  );
  return loadResourcesWithinCeiling(
    context.principal.workspaceId,
    runAgent,
    { permissions, met },
    sources,
  );
}

/**
 * The loaded resources with `files` narrowed to the run's `fileScope` (ADR-0147, issue #1539), or
 * unchanged when the run has none. A scope path outside the agent's effective grants (after the
 * readFiles switch and the ceiling) refuses the run, built here as `policy_cannot_widen` is.
 */
export function narrowedToFileScope<R extends { readonly files: readonly GrantedPath[] }>(
  resources: R,
  fileScope: readonly string[] | undefined,
): R {
  if (fileScope === undefined) return resources;
  const { kept, widens } = narrowFileGrants(resources.files, fileScope);
  if (widens.length > 0) {
    throw new DomainError({
      category: 'validation',
      code: 'run_file_scope_not_granted',
      // Names no path: which ones failed would tell the caller what lies inside the grants.
      publicMessage:
        "run_file_scope_not_granted: fileScope names a path this run cannot narrow to. The scope can only narrow the agent's file grants.",
    });
  }
  return { ...resources, files: kept };
}

/**
 * The `/run` body's `resources.files`: the run's grants, already narrowed by
 * {@link narrowedToFileScope}, with its attachments after them, then its memory folder in place of
 * anything else under `memory/` (ADR-0163). Exported so the delivery tests' runner double receives
 * the body this composes.
 */
export async function attachedRunFiles(
  context: LaunchContext,
  resources: Pick<AgentRunResourceSelection, 'files' | 'skills' | 'memoryFiles'>,
  resourceLoader: AgentRunResourceLoader | undefined,
): Promise<AgentRunResourceSelection['files']> {
  // Each attachment is also a `read` reference in `resources.files`, so the runner checks it like
  // any grant; its bytes arrive in the input archive.
  // @story US-STO-11
  const attached = await atStep('resources', () =>
    loadAttachedFiles(resourceLoader, context.principal.workspaceId, context.attachments ?? []),
  );
  const runFiles = withMemoryFiles(
    withAttachedFiles(resources.files, attached.files),
    resources.memoryFiles,
  );
  // The total after the scope narrowed the grants and the attachments joined them; the input
  // archive judged the same total before the sandbox, so this is the backstop.
  // @story US-STO-06
  assertRunFilesFit(runFiles, resources.skills);
  return runFiles;
}
