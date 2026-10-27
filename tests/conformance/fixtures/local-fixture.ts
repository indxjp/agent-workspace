/**
 * `tests/conformance/fixtures/local-fixture.ts` — wires the real `local` driver
 * (`packages/runtime/src/local.ts`, unmodified) up to this suite's fixture starter, for
 * `tests/conformance/a12-local.test.ts` — the run the wave plan's Accept line actually names.
 *
 * `createLocalDriver` takes the starter as its one constructor argument (see `local.ts`'s header:
 * *"the driver takes the 'start an agent' function as an argument"*, so that
 * `apps/runner/src/claude.ts` stays the only file that may import the real Agent SDK, per §42).
 * This is the same seam, used the same way, with a fixture in the caller's role instead of
 * `apps/runner`.
 */
import {
  createLocalDriver,
  LOCAL_RUNTIME_CAPABILITIES,
} from '@agent-workspace/runtime/driver/local';
import type { RuntimeDriver } from '../types.js';
import {
  createFixtureStarter,
  fixtureAgentProbe,
  type FixtureEvent,
  type FixtureRequest,
} from './common.js';
import type { A12Probe } from '../types.js';

/** The real `local` driver's real capabilities — nothing here overrides or narrows them. */
export { LOCAL_RUNTIME_CAPABILITIES };

export function createLocalFixtureDriver(): RuntimeDriver<FixtureRequest, FixtureEvent> {
  // `local` shares the host's network and filesystem with no enforcement of either — the fixture
  // starter's defaults (`OPEN_NETWORK`, `OPEN_FILE_ACCESS`) already say exactly that, honestly,
  // which is why they need no arguments here.
  return createLocalDriver<FixtureRequest, FixtureEvent>(createFixtureStarter());
}

export const localFixtureProbe: A12Probe<FixtureRequest, FixtureEvent> = {
  agent: fixtureAgentProbe,
  // No `fileTransfer`: `local`'s `persistentFilesystem: true` and it implements neither
  // `putFiles` nor `getFiles`, so `tests/conformance/scenarios.ts`'s scenario 3 and 9 never reach
  // the branch that would need one (see `LOCAL_RUNTIME_CAPABILITIES.persistentFilesystem`).
};
