import type { EgressPolicyConfig, OutboundProxyConfig } from '@agent-workspace/core';

import type { StorageConnectionsStoreProvider } from './store';

type StorageConnectionAuditEvent = {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
  readonly action:
    | 'storage-connection-created'
    | 'storage-connection-updated'
    | 'storage-connection-credential-changed'
    | 'storage-connection-tested'
    | 'storage-connection-deleted'
    | 'storage-connection-written';
  readonly subjectId: string;
  readonly subjectLabel: string;
};

export interface StorageConnectionsRuntime {
  readonly store: StorageConnectionsStoreProvider;
  /** The operator's folders a `file` connection may name (`AW_STORAGE_CONNECTION_FILE_ROOTS`). */
  readonly fileRoots: readonly string[];
  /** The deployment's egress policy; `test` and `browse` dial customer endpoints under it. */
  readonly egress: EgressPolicyConfig;
  /**
   * The deployment's outbound proxy (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`); `test` and `browse`
   * tunnel through it once the endpoint has passed the egress check. Absent means none.
   */
  readonly proxy?: OutboundProxyConfig;
  /** Whether an agent version of the workspace still grants a folder of connection `connectionId`. */
  isConnectionGranted(workspaceId: string, connectionId: string): Promise<boolean>;
  audit(event: StorageConnectionAuditEvent): Promise<void>;
}

/**
 * The storage-connection routes as the application context holds them: `unavailable` when the
 * encrypted secrets service did not start, because credentials need it. The routes then answer
 * `503 storage_connections_not_configured`.
 */
export type StorageConnections =
  | { readonly kind: 'serving'; readonly runtime: StorageConnectionsRuntime }
  | { readonly kind: 'unavailable' };
