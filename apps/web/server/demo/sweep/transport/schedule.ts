import type { DemoSweepResult } from './sweep';

/**
 * Call `sweep` every `intervalMs` on an unref'd timer; the returned function stops it. The timer is
 * for long-lived servers; where `CRON_SECRET` is set the trigger cron route calls the same `sweep`
 * on each delivery instead (`triggers/schedule-cron.ts`). `intervalMs` should be well under
 * `DEMO_SWEEP_MIN_INTERVAL_MS`: the sweep itself decides whether it is due.
 */
export function startDemoSweepScheduler(options: {
  readonly sweep: () => Promise<DemoSweepResult>;
  readonly intervalMs: number;
  readonly onError: (error: unknown) => void;
}): () => void {
  const timer = setInterval(() => void options.sweep().catch(options.onError), options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
