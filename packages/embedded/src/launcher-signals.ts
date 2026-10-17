/**
 * The signals the local runtime launcher owns (S1-06, S1-25). A module of its own so `launch.ts`
 * can name them without statically importing the launcher.
 */

/**
 * The signals the launcher stops on. SIGHUP is a terminal or SSH session closing, and on Windows a
 * console window closing; SIGBREAK is Windows' Ctrl+Break. Node's default action for both ends the
 * process without an `exit` event, so without a listener the detached postmaster would be left
 * running (S1-25, #510, ADR-0112).
 */
export type LauncherSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGBREAK';

/** Every {@link LauncherSignal}, in the order the launcher registers them. */
export const LAUNCHER_SIGNALS: readonly LauncherSignal[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGBREAK',
];
