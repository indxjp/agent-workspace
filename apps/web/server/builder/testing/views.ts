import type { AgentVersionVia } from '@indx-workspace/contracts/agent-versions';
import type { AgentCreatedAuditDetails } from '@indx-workspace/contracts/observability';

/** What a test reads back of an agent. */
export interface AgentState {
  readonly versions: readonly {
    readonly number: number;
    readonly via: AgentVersionVia;
    readonly createdByPrincipalId: string;
  }[];
  readonly local: number | null;
  readonly production: number | null;
}

/** What a test reads back of an `audit_events` row. */
export interface AuditEventRow {
  readonly action: string;
  readonly subjectId: string;
  readonly subjectLabel: string;
  readonly actorPrincipalId: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
  /** Set only on an `agent-created` row. */
  readonly details: AgentCreatedAuditDetails | null;
}
