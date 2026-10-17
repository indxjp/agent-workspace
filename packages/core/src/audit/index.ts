/** The stable shape exposed by the enterprise audit API. */
export interface AuditRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly targetLabel: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}
