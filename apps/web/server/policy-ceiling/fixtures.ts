/**
 * Test fixture: the real {@link createCeilingFor} over in-memory lookups that record what they
 * read, and an audit sink that keeps every row (issue #535).
 */
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import type { ModelProvider } from '@indx-workspace/contracts/runs';

import type { DeploymentDefaultModels } from '../models/deployment-default';
import { createCeilingFor, type CeilingAuditEvent, type CeilingFor } from './ceiling';

export const CEILING_ACTOR = {
  workspaceId: '00000000-0000-4000-8000-0000000000aa',
  principalId: '00000000-0000-4000-8000-0000000000bb',
  userId: null,
  label: 'owner@example.com',
} as const;

export interface RecordingCeiling {
  readonly ceilingFor: CeilingFor;
  readonly audit: CeilingAuditEvent[];
  /** Every lookup, as `provider:<connection id>` or `connector:<id>`. */
  readonly lookups: string[];
}

export function recordingCeilingFor(
  policy: ProjectPolicy,
  options: {
    readonly defaults?: DeploymentDefaultModels;
    readonly providers?: Readonly<Record<string, ModelProvider>>;
    readonly connectors?: Readonly<Record<string, string>>;
  } = {},
): RecordingCeiling {
  const audit: CeilingAuditEvent[] = [];
  const lookups: string[] = [];
  const ceilingFor = createCeilingFor({
    policy,
    deploymentDefaultModels: options.defaults ?? {},
    modelProvider: (_workspaceId, connectionId) => {
      lookups.push(`provider:${connectionId}`);
      return Promise.resolve(options.providers?.[connectionId] ?? null);
    },
    connectorName: (_workspaceId, connectorId) => {
      lookups.push(`connector:${connectorId}`);
      return Promise.resolve(options.connectors?.[connectorId] ?? null);
    },
    identifyActor: () => Promise.resolve(CEILING_ACTOR),
    recordAuditEvent: (event) => {
      audit.push(event);
      return Promise.resolve();
    },
  });
  return { ceilingFor, audit, lookups };
}
