/**
 * The Platforms tab's decisions (issue #973), kept apart from React and from the SDK client so
 * they run directly in tests.
 */
import type { AgentVersionListResponse } from '@indx-workspace/contracts/agent-versions';
import {
  HOSTED_PLATFORM_IDS,
  type FieldVerdict,
  type HostedPlatformId,
  type PlatformDescriptor,
  type PlatformExportResponse,
  type PlatformId,
} from '@indx-workspace/contracts/platforms';
import { ApiProblemError } from '@indx-workspace/sdk';

/** The version the tab opens on: what production runs, else local's, else the newest. */
export function defaultExportVersion(listing: AgentVersionListResponse): number | null {
  const saved = new Set(listing.items.map((item) => item.number));
  for (const environment of ['production', 'local'] as const) {
    const pointer = listing.pointers.find((candidate) => candidate.environment === environment);
    if (pointer !== undefined && saved.has(pointer.number)) return pointer.number;
  }
  return saved.size === 0 ? null : Math.max(...saved);
}

/** Every capability field any platform reports, in first-seen order, so a new one needs no UI change. */
export function capabilityFields(platforms: readonly PlatformDescriptor[]): readonly string[] {
  const fields = new Set<string>();
  for (const platform of platforms) {
    for (const field of Object.keys(platform.capabilities)) fields.add(field);
  }
  return [...fields];
}

export function isHostedPlatform(id: PlatformId): id is HostedPlatformId {
  return (HOSTED_PLATFORM_IDS as readonly string[]).includes(id);
}

export type VerdictCounts = {
  readonly native: number;
  readonly mapped: number;
  readonly dropped: number;
};

export function verdictCounts(report: readonly FieldVerdict[]): VerdictCounts {
  const count = (verdict: FieldVerdict['verdict']): number =>
    report.filter((field) => field.verdict === verdict).length;
  return { native: count('native'), mapped: count('mapped'), dropped: count('dropped') };
}

const PLAIN_NAME = /^[A-Za-z0-9._-]+$/u;

/** `aw platforms publish --platform <id> --agent <agent>`; the name is shell-quoted unless it is plain. */
export function publishCommand(platform: PlatformId, agentName: string): string {
  const agent = PLAIN_NAME.test(agentName) ? agentName : `'${agentName.replaceAll("'", "'\\''")}'`;
  return `aw platforms publish --platform ${platform} --agent ${agent}`;
}

/** The Agent Card URL the control plane serves for one agent. */
export function agentCardUrl(origin: string, agentName: string): string {
  return `${origin}/api/a2a/agents/${encodeURIComponent(agentName)}/.well-known/agent-card.json`;
}

export type PlatformCheck =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking'; readonly platform: PlatformId }
  | {
      readonly kind: 'exported';
      readonly platform: PlatformId;
      readonly response: PlatformExportResponse;
    }
  | {
      readonly kind: 'refused';
      readonly platform: PlatformId;
      readonly code: string;
      readonly details: readonly string[];
    }
  | { readonly kind: 'failed'; readonly platform: PlatformId };

/** An SDK error as a check: a problem is a refusal with its code and details, anything else a failure. */
export function checkFailure(platform: PlatformId, error: unknown): PlatformCheck {
  return error instanceof ApiProblemError
    ? { kind: 'refused', platform, code: error.code, details: error.details }
    : { kind: 'failed', platform };
}

export type AgentTab = 'configuration' | 'versions' | 'platforms';

/** The agent page's tab for a `?tab=` value; anything else is Configuration. */
export const agentTab = (tab: string | string[] | undefined): AgentTab =>
  tab === 'versions' || tab === 'platforms' ? tab : 'configuration';
