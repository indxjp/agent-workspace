import { resolveReplayCursor } from './replay-cursor';
import type { SseEvent } from './sse';
import { isStoppedRunStatus, type RunStore, type RunStreamHandle } from './store';

const EVENT_PAGE_SIZE = 500;
const POLL_MIN_MS = 250;
const POLL_MAX_MS = 2_000;

interface ReplayRepositories {
  readonly runs: Pick<RunStore, 'get'>;
  readonly events: {
    bounds(runId: string): Promise<Parameters<typeof resolveReplayCursor>[2]>;
    list(runId: string, after: bigint, limit: number): Promise<readonly SseEvent[]>;
  };
}

interface StreamContext {
  readonly runId: string;
  readonly repositories: ReplayRepositories;
  readonly waiters: Map<string, Set<() => void>>;
}

interface ReplayProgress {
  cursor: bigint;
  terminal: boolean;
  idleMs: number;
}

export async function openRepositoryStream(
  context: StreamContext & { readonly after: bigint | null },
): Promise<RunStreamHandle> {
  const bounds = await context.repositories.events.bounds(context.runId);
  const replay = resolveReplayCursor(context.runId, context.after, bounds);
  return new DurableRunStream(context, replay);
}

class DurableRunStream implements RunStreamHandle {
  readonly reset: RunStreamHandle['reset'];
  readonly events: AsyncIterable<SseEvent>;
  private closed = false;
  private releaseCurrentWait: (() => void) | null = null;

  constructor(
    private readonly context: StreamContext,
    replay: ReturnType<typeof resolveReplayCursor>,
  ) {
    this.reset = replay.reset;
    this.events = this.readEvents(replay.cursor);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseCurrentWait?.();
  }

  private subscribe() {
    const { runId, waiters } = this.context;
    let notify: (() => void) | undefined;
    const notified = new Promise<void>((resolve) => {
      notify = resolve;
    });
    if (notify === undefined) throw new Error('The Promise executor did not run synchronously.');
    const release = notify;
    const listeners = waiters.get(runId) ?? new Set<() => void>();
    listeners.add(release);
    waiters.set(runId, listeners);
    this.releaseCurrentWait = release;
    return {
      notified,
      close: () => {
        listeners.delete(release);
        if (listeners.size === 0) waiters.delete(runId);
        this.releaseCurrentWait = null;
      },
    };
  }

  private async advanceReplay(pageLength: number, progress: ReplayProgress) {
    if (this.closed) return 'stop';
    if (pageLength === EVENT_PAGE_SIZE) return 'drain';
    if (progress.terminal) return 'stop';
    const run = await this.context.repositories.runs.get(this.context.runId);
    if (run === null) return 'stop';
    if (isStoppedRunStatus(run.status)) {
      // Append and finish share the run lock; one final drain includes an event that committed
      // between the preceding page read and observing this terminal status.
      progress.terminal = true;
      return 'drain';
    }
    progress.idleMs = pageLength > 0 ? POLL_MIN_MS : Math.min(progress.idleMs * 2, POLL_MAX_MS);
    return 'wait';
  }

  private async *readEvents(cursor: bigint): AsyncGenerator<SseEvent> {
    const { runId, repositories } = this.context;
    const progress: ReplayProgress = { cursor, terminal: false, idleMs: POLL_MIN_MS };
    try {
      for (;;) {
        const waiting = this.subscribe();
        try {
          const page = await repositories.events.list(runId, progress.cursor, EVENT_PAGE_SIZE);
          for (const event of page) {
            progress.cursor = event.id;
            yield event;
          }
          const next = await this.advanceReplay(page.length, progress);
          if (next === 'stop') return;
          if (next === 'drain') continue;
          // Notifications wake this replica; polling also observes commits from other replicas.
          await Promise.race([
            waiting.notified,
            new Promise<void>((resolve) => setTimeout(resolve, progress.idleMs)),
          ]);
        } finally {
          waiting.close();
        }
      }
    } finally {
      this.close();
    }
  }
}
