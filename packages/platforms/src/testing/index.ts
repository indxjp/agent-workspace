/**
 * `@indx-workspace/platforms/testing` — the platform conformance kit (ADR-0133 D6-D8).
 *
 * A separate entry point from the port so that importing {@link PlatformTarget} does not pull the
 * sample project and `node:fs` (the golden-file helpers) into a bundle. It uses no test
 * framework: a check throws an `Error`, and the caller's runner reports the throw as a failure.
 */
export {
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
} from './sample.js';
export {
  CREDENTIAL_PATTERNS,
  assertVerdictInvariants,
  runPlatformConformance,
} from './invariants.js';
export { expectGoldenBundle, expectGoldenFiles, loadGoldenProject } from './golden.js';
