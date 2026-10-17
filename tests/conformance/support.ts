/** Small, scenario-agnostic helpers shared by `tests/conformance/scenarios.ts`. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** What a scenario's `run()` returns, before the harness turns it into an `A12ScenarioResult`. */
export type A12RunOutcome = { readonly ok: boolean; readonly detail: string };

export function pass(detail: string): A12RunOutcome {
  return { ok: true, detail };
}

export function fail(detail: string): A12RunOutcome {
  return { ok: false, detail };
}

/** A fresh, empty directory under the OS temp dir, named for the scenario that asked for it. */
export async function makeTempWorkspace(label: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), `a12-${label}-`));
}
