import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import {
  RUNTIME_DRIVERS,
  defaultRuntimeNetworkPolicy,
  type RuntimeDriver,
  type RuntimeNetworkPolicy,
} from '../../contracts/runtimes';

export type RuntimeOption = Readonly<{
  id: RuntimeDriver;
  label: string;
  description: string;
  side?: string;
  managed: boolean;
  defaultReason?: string;
}>;

/** Section 14.8's picker order, with visible descriptions transcribed from ui/runtimes.html. */
export const RUNTIME_OPTIONS: readonly RuntimeOption[] = [
  {
    id: 'local',
    label: 'This machine',
    description:
      'Development only. The agent runs as a child process of the runner, as the same user.',
    side: 'no isolation',
    managed: false,
  },
  {
    id: 'sandbox-runtime',
    label: 'Sandboxed process',
    description:
      'bubblewrap on Linux, Seatbelt on macOS. Filesystem and network allowlists without a container.',
    side: 'npx, no Docker',
    managed: false,
  },
  {
    id: 'docker',
    label: 'Docker',
    description:
      'One container per session, capabilities dropped, read-only root, egress network limited to the gateway.',
    side: 'recommended for self-hosting',
    managed: false,
  },
  {
    id: 'kubernetes',
    label: 'Kubernetes',
    description:
      'One Pod per runtime · namespace agent-sandboxes · default-deny NetworkPolicy · optional gVisor RuntimeClass',
    side: 'portable enterprise',
    managed: false,
  },
  {
    id: 'aca-sessions',
    label: 'Azure Container Apps dynamic sessions',
    description:
      'Pool registered · Hyper-V per session · network policy fixed when the pool is created, ' +
      'reported by the registry',
    managed: true,
  },
  {
    id: 'aws-agentcore',
    label: 'Amazon Bedrock AgentCore Runtime',
    description: 'Managed Firecracker microVM runtime.',
    managed: true,
    defaultReason: 'Image not published to ECR for this account (arm64 required).',
  },
  {
    id: 'aws-ecs',
    label: 'Amazon ECS on Fargate',
    description: 'VM-isolated Fargate task.',
    managed: true,
    defaultReason: 'Not configured — no task definition registered.',
  },
  {
    id: 'cloud-run-sandbox',
    label: 'Google Cloud Run sandboxes',
    description: 'Managed Cloud Run sandbox.',
    managed: true,
    defaultReason: 'Not configured — no runner deployed with --sandbox-launcher.',
  },
  {
    id: 'cloud-run-service',
    label: 'Google Cloud Run (per-session service)',
    description:
      'One private Cloud Run v2 service per session, deployed by the runner manager. Used in place of the unimplemented cloud-run-sandbox driver — see docs/adr/ADR-cloud-run-service-driver.md.',
    managed: true,
    defaultReason: 'Not configured — the runner manager is not set to this driver.',
  },
  {
    id: 'gke-agent-sandbox',
    label: 'GKE Agent Sandbox',
    description: 'Managed GKE Agent Sandbox runtime.',
    managed: true,
    defaultReason: 'Not configured — cluster does not expose the Sandbox CRDs.',
  },
  {
    id: 'vercel-sandbox',
    label: 'Vercel Sandbox',
    description: 'One Firecracker microVM per session, created through the Vercel Sandbox API.',
    managed: true,
    defaultReason: 'Not configured — the runner manager is not set to this driver.',
  },
  {
    id: 'cloudflare-sandbox',
    label: 'Cloudflare Sandbox',
    description:
      'One Cloudflare container per session behind a bridge Worker. Refuses every network policy until its egress denial is proven, so it cannot create sandboxes yet (ADR-0131). Not yet verified live.',
    managed: true,
    defaultReason: 'Not configured — the runner manager is not set to this driver.',
  },
  {
    id: 'external',
    label: 'External provider',
    description: 'E2B, Daytona, Modal, Cloudflare Sandboxes. None registered.',
    managed: false,
  },
];

export const SWITCH_COMPARISON = {
  heading: 'Changing runtime: Docker → Azure Container Apps dynamic sessions',
  warnings: [
    '⚠ Domain allowlist is not supported on this runtime.',
    '"Restricted" will become all-or-nothing egress.',
  ],
  blockers: [
    '✕ This agent uses a local command connector (Filesystem MCP).',
    'This runtime has no outbound network for package downloads.',
    'Bundle the connector into the runtime image, or switch it to a remote URL.',
  ],
} as const;

export type RuntimeTestResponse = Readonly<{
  driverId: string;
  transcript: readonly string[];
  destroyed: boolean;
}>;

/** The server's own sentence for a refusal, so Test Runtime can say which connection to fix. */
function problemMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const message = (body as { error?: { message?: unknown } }).error?.message;
  return typeof message === 'string' ? message : undefined;
}

/**
 * The workspace's runtime connection for a driver, to name in Test Runtime. A provider sandbox
 * (`external`, `vercel-sandbox`, `cloudflare-sandbox`) is tested with its connection's key; the
 * server ignores the connection for any other driver. With several, the first listed is used.
 */
export async function runtimeConnectionIdFor(
  client: AgentWorkspaceClient,
  driverId: string,
): Promise<string | undefined> {
  const connections = await client.runtimes.connections.list();
  return connections.find((connection) => connection.driver === driverId)?.id;
}

/**
 * Test Runtime as the page runs it. A failed connection lookup (no secrets service, a transient
 * error) tests without an id: a driver that needs none still runs, and a provider driver gets the
 * server's own `runtime_connection_missing` refusal.
 */
export async function testSelectedRuntime(
  client: AgentWorkspaceClient,
  request: typeof fetch,
  driverId: string,
): Promise<RuntimeTestResponse> {
  const connectionId = await runtimeConnectionIdFor(client, driverId).catch(() => undefined);
  return testRuntime(request, driverId, connectionId);
}

/**
 * `POST /api/runtimes/test` stays a raw request until S-4 gives it the standard envelope and the
 * SDK a method for it (docs/sdk/07-structure-map.md, unit 9).
 */
export async function testRuntime(
  request: typeof fetch,
  driverId: string,
  runtimeConnectionId?: string,
): Promise<RuntimeTestResponse> {
  const response = await request('/api/runtimes/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      driver: driverId,
      echo: 'agent-workspace runtime test',
      ...(runtimeConnectionId === undefined ? {} : { runtimeConnectionId }),
    }),
  });
  if (!response.ok) {
    const detail = problemMessage(await response.json().catch(() => undefined));
    throw new Error(detail ?? `Test Runtime failed with HTTP ${String(response.status)}.`);
  }
  const body = (await response.json()) as Partial<RuntimeTestResponse>;
  if (!Array.isArray(body.transcript) || typeof body.driverId !== 'string') {
    throw new Error('Test Runtime returned an invalid transcript.');
  }
  return {
    driverId: body.driverId,
    transcript: body.transcript as string[],
    destroyed: body.destroyed === true,
  };
}

export type RuntimeProfileDraft = Readonly<{
  name: string;
  driver: string;
  networkPolicy: 'none' | 'restricted' | 'open';
  filesystem: 'read-only' | 'read-write';
}>;

export type SavedRuntimeProfile = Readonly<{ id: string; name: string }>;

/**
 * The policy the Save draft asks for: what the registry entry reports this runtime can actually
 * enforce here, and only otherwise the strongest policy the driver generally supports.
 *
 * A managed pool fixes its network mode at creation, so a draft built from the driver-wide default
 * alone would overwrite the working profile first-run setup created with a policy the pool cannot
 * honour — which `/api/runtime-profiles` now refuses with `network_policy_not_enforceable`.
 */
export function draftRuntimeNetworkPolicy(
  driver: string,
  enforceable: readonly RuntimeNetworkPolicy[] | null,
): RuntimeNetworkPolicy {
  const preferred = defaultRuntimeNetworkPolicy(driver);
  if (enforceable === null) return preferred;
  const first = enforceable[0];
  if (first === undefined) return preferred;
  return enforceable.includes(preferred) ? preferred : first;
}

/**
 * The whole draft the Runtimes screen's Save button submits for a listed entry. The screen calls
 * this rather than assembling the draft inline so `runtimes-screen.test.ts` asserts the same code
 * path the button runs, DOM or no DOM.
 */
export function runtimeProfileDraftFor(
  entry: Readonly<{ id: string; networkPolicies: readonly RuntimeNetworkPolicy[] | null }>,
): RuntimeProfileDraft {
  return {
    name: `${entry.id} default`,
    driver: entry.id,
    networkPolicy: draftRuntimeNetworkPolicy(entry.id, entry.networkPolicies),
    filesystem: 'read-write',
  };
}

/**
 * Save the draft: update the workspace's profile for the driver, or create the first one. The
 * server's own sentence for a refusal (for example `network_policy_not_enforceable`) rejects.
 */
export async function saveRuntimeProfile(
  client: AgentWorkspaceClient,
  draft: RuntimeProfileDraft,
): Promise<SavedRuntimeProfile> {
  const driver = RUNTIME_DRIVERS.find((known) => known === draft.driver);
  if (driver === undefined) throw new Error(`Unknown runtime driver ${draft.driver}.`);
  const body = { ...draft, driver };
  const existing = (await client.runtimes.profiles.list()).find(
    (profile) => profile.driver === driver,
  );
  return existing === undefined
    ? client.runtimes.profiles.create(body)
    : client.runtimes.profiles.update(existing.id, body);
}
