import type { Server } from 'node:http';
import { type DockerReapReport } from '@agent-workspace/runtime/driver/docker';
import { type ShutdownGate } from './shutdown-gate.js';

/**
 * How long a shutdown waits for in-flight sandbox creates before it reaps: well inside the 30 s
 * stop grace period the generated `compose.yaml` gives the runner, leaving time for the reap.
 */
export const IN_FLIGHT_SETTLE_TIMEOUT_MS = 15_000;

/** How the shutdown went: `clean` only when every owned sandbox was positively removed. */
export type ManagerShutdownOutcome = 'clean' | 'sandboxes-left';

/**
 * Stop serving and remove this manager's sandboxes (issue #394).
 *
 * `docker compose down` stops the manager with `SIGTERM` and then removes the project's networks.
 * A sandbox still attached to `<project>-runtime-control` keeps that network, and itself, alive
 * after `down` reports success, so the manager removes them first. New requests are refused from
 * the first step; open proxied streams end when their sandbox is removed, and are then closed. A
 * sandbox that could not be removed is named on stderr and reported as `sandboxes-left`, never
 * read as a clean stop (ADR-0015); `agent-workspace stop` removes it by its labels.
 *
 * Before the reap, the gate refuses new creates and waits up to `settleTimeoutMs` for those in
 * flight. A create still running when that wait ends may start a sandbox after the reap, or after
 * this process has exited, so the outcome is then `sandboxes-left`, never `clean`.
 */
export async function shutdownRunnerManager(
  server: Server,
  reap: (() => Promise<DockerReapReport>) | undefined,
  log: Pick<NodeJS.WriteStream, 'write'> = process.stderr,
  gate?: Pick<ShutdownGate, 'close'>,
  settleTimeoutMs: number = IN_FLIGHT_SETTLE_TIMEOUT_MS,
): Promise<ManagerShutdownOutcome> {
  server.close();
  let outcome: ManagerShutdownOutcome = 'clean';
  // Refuse new sandboxes (503), and let the ones already being created finish before the reap
  // lists what exists.
  if (gate !== undefined && !(await gate.close(settleTimeoutMs))) {
    log.write(
      `runner manager: sandbox creation still in progress after ${String(settleTimeoutMs)}ms; ` +
        'removing what exists now, but a sandbox it starts later may be left: run ' +
        '`agent-workspace stop` to remove it\n',
    );
    outcome = 'sandboxes-left';
  }
  if (reap !== undefined) {
    try {
      const report = await reap();
      log.write(`runner manager: removed ${String(report.removed.length)} sandbox(es)\n`);
      for (const failure of report.failed) {
        log.write(`runner manager: could not remove ${failure.container}: ${failure.reason}\n`);
      }
      if (report.failed.length > 0) outcome = 'sandboxes-left';
    } catch (error) {
      log.write(
        `runner manager: sandbox removal failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      outcome = 'sandboxes-left';
    }
  }
  server.closeAllConnections();
  return outcome;
}

/**
 * The signal listener: the first signal runs `shutdown` and exits with its outcome, a second one
 * leaves at once. A shutdown that throws is still a failed stop, so it exits 2 like
 * `sandboxes-left` instead of crashing through the unhandled-rejection path with exit 1.
 */
export function createShutdownSignalHandler(
  shutdown: () => Promise<ManagerShutdownOutcome>,
  exit: (code: number) => void = (code) => process.exit(code),
  log: Pick<NodeJS.WriteStream, 'write'> = process.stderr,
): (signal: NodeJS.Signals) => void {
  let stopping = false;
  return (signal) => {
    if (stopping) {
      log.write(`runner manager: second ${signal}; leaving now\n`);
      exit(2);
      return;
    }
    stopping = true;
    log.write(`runner manager: ${signal} received; removing sandboxes\n`);
    shutdown().then(
      (outcome) => {
        exit(outcome === 'clean' ? 0 : 2);
      },
      (error: unknown) => {
        log.write(
          `runner manager: shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        exit(2);
      },
    );
  };
}
