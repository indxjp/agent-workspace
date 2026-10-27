export interface SessionRetentionPolicy {
  readonly transcriptDays: number;
  readonly leaseTtlMs: number;
  readonly dryRun: boolean;
}

export interface RetentionLease {
  tryAcquire(name: string, ttlMs: number): Promise<null | { release(): Promise<void> }>;
}

export interface PurgeableTranscriptStore {
  purgeBefore(projectKey: string, before: Date): Promise<number>;
}

/**
 * The engine-scoped store (ENG-06, ADR-0071), purged under the same policy and cutoff as the legacy
 * transcript tables. Since ENG-06 every new conversation lives here, so a pass that purged only the
 * legacy tables would report success over an ever-emptier set while the real content stayed.
 */
export interface PurgeableSessionStateStore {
  purgeBefore(
    workspaceId: string,
    before: Date,
  ): Promise<{
    readonly entries: number;
    readonly blobs: number;
    /** The sessions the pass left with no stream at all: their conversation is purged. */
    readonly sessionIds: readonly string[];
  }>;
}

/**
 * ADR-0146 D6: a visitor's `.attachments/<sessionId>/` lives as long as its session, so the pass
 * deletes the prefix of each session it purged, objects and catalogue rows together. A file a member
 * promoted (renamed out) is no longer under the prefix and stays. Answers how many files went.
 */
export interface PurgeableSessionAttachments {
  purgeSessions(workspaceId: string, sessionIds: readonly string[]): Promise<number>;
}

export type SessionRetentionResult =
  | { readonly kind: 'lease-held' }
  | { readonly kind: 'dry-run'; readonly cutoff: Date }
  | {
      readonly kind: 'purged';
      readonly cutoff: Date;
      readonly transcripts: number;
      readonly stateEntries: number;
      readonly stateBlobs: number;
      readonly attachments: number;
    };

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const text = value.trim();
  // Matches packages/core/src/db/client.ts's parseMaxConnections: digits only, so exponential
  // notation ('1e3') or a leading '+' cannot slip past bare Number(value) as a silently-accepted
  // retention/TTL value.
  if (!/^[0-9]+$/u.test(text)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function readSessionRetentionPolicy(
  env: Readonly<Record<string, string | undefined>>,
): SessionRetentionPolicy {
  const dryRun = env['AW_SESSION_RETENTION_DRY_RUN'];
  if (dryRun !== undefined && dryRun !== 'true' && dryRun !== 'false') {
    throw new Error('AW_SESSION_RETENTION_DRY_RUN must be true or false');
  }
  return {
    transcriptDays: positiveInteger(
      env['AW_SESSION_TRANSCRIPT_RETENTION_DAYS'],
      30,
      'AW_SESSION_TRANSCRIPT_RETENTION_DAYS',
    ),
    leaseTtlMs: positiveInteger(
      env['AW_SESSION_RETENTION_LEASE_TTL_MS'],
      300_000,
      'AW_SESSION_RETENTION_LEASE_TTL_MS',
    ),
    dryRun: dryRun !== 'false',
  };
}

/** One bounded retention pass. The lease is always released, including when purge fails. */
export async function runSessionRetention(
  input: Readonly<{
    workspaceId: string;
    store: PurgeableTranscriptStore;
    stateStore: PurgeableSessionStateStore;
    attachments?: PurgeableSessionAttachments;
    lease: RetentionLease;
    policy: SessionRetentionPolicy;
    now?: Date;
  }>,
): Promise<SessionRetentionResult> {
  const held = await input.lease.tryAcquire(
    `session-retention:${input.workspaceId}`,
    input.policy.leaseTtlMs,
  );
  if (held === null) return { kind: 'lease-held' };
  try {
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - input.policy.transcriptDays * 86_400_000);
    if (input.policy.dryRun) return { kind: 'dry-run', cutoff };
    const transcripts = await input.store.purgeBefore(input.workspaceId, cutoff);
    const state = await input.stateStore.purgeBefore(input.workspaceId, cutoff);
    const attachments =
      input.attachments === undefined || state.sessionIds.length === 0
        ? 0
        : await input.attachments.purgeSessions(input.workspaceId, state.sessionIds);
    return {
      kind: 'purged',
      cutoff,
      transcripts,
      stateEntries: state.entries,
      stateBlobs: state.blobs,
      attachments,
    };
  } finally {
    await held.release();
  }
}

/** One pass over every workspace PostgreSQL knows; the unit both the scheduler and the cron route run. */
export async function runSessionRetentionPass(
  input: Readonly<{
    listWorkspaceIds(): Promise<readonly string[]>;
    store: PurgeableTranscriptStore;
    stateStore: PurgeableSessionStateStore;
    attachments?: PurgeableSessionAttachments;
    lease: RetentionLease;
    policy: SessionRetentionPolicy;
    onResult?: (workspaceId: string, result: SessionRetentionResult) => void;
  }>,
): Promise<readonly SessionRetentionResult[]> {
  const results: SessionRetentionResult[] = [];
  for (const workspaceId of await input.listWorkspaceIds()) {
    const result = await runSessionRetention({
      workspaceId,
      store: input.store,
      stateStore: input.stateStore,
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      lease: input.lease,
      policy: input.policy,
    });
    input.onResult?.(workspaceId, result);
    results.push(result);
  }
  return results;
}

export interface SessionRetentionScheduler {
  stop(): void;
  runNow(): Promise<void>;
}

/** Start one unref'd, replica-safe retention loop covering every workspace known to PostgreSQL. */
export function startSessionRetentionScheduler(
  input: Readonly<{
    listWorkspaceIds(): Promise<readonly string[]>;
    store: PurgeableTranscriptStore;
    stateStore: PurgeableSessionStateStore;
    attachments?: PurgeableSessionAttachments;
    lease: RetentionLease;
    policy: SessionRetentionPolicy;
    intervalMs: number;
    onError?: (error: unknown) => void;
    /** Each workspace's result, so a deployment can report what a pass removed. */
    onResult?: (workspaceId: string, result: SessionRetentionResult) => void;
  }>,
): SessionRetentionScheduler {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1) {
    throw new Error('session retention interval must be a positive safe integer');
  }
  let stopped = false;
  let active: Promise<void> | null = null;
  const runNow = async (): Promise<void> => {
    if (stopped) return;
    active ??= runSessionRetentionPass(input)
      .then(() => undefined)
      .finally(() => {
        active = null;
      });
    return active;
  };
  const timer = setInterval(() => void runNow().catch(input.onError), input.intervalMs);
  timer.unref();
  void runNow().catch(input.onError);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow,
  };
}
