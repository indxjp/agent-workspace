/** The undo journal of one setup attempt: every write registers the step that takes it back. */
import { log } from '../telemetry/logger';

export type SetupFailure = Readonly<{ ok: false; status: number; code: string; message: string }>;

/**
 * One write a setup attempt made, as the step that takes it back (issue #415). `label` names the
 * step and the row by id only, never a value, so it can be logged; `run` answers whether it worked.
 */
export type SetupUndoStep = Readonly<{ label: string; run: () => Promise<boolean> }>;
export type SetupUndo = SetupUndoStep[];

/**
 * Take back an attempt's writes, newest first. A step that fails or throws does not stop the rest;
 * the labels of the steps that failed are logged together, with the error's name only, since a
 * provider or storage error could carry a value.
 */
export async function rollBack(undo: SetupUndo): Promise<void> {
  const failed: string[] = [];
  for (const step of undo.toReversed()) {
    try {
      if (!(await step.run())) failed.push(step.label);
    } catch (error) {
      failed.push(`${step.label} (${error instanceof Error ? error.name : 'non-error thrown'})`);
    }
  }
  if (failed.length > 0) {
    log.error(`[setup] rolling back a refused setup attempt left writes in place`, {
      failed,
    });
  }
}
