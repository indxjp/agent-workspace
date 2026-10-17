/**
 * `@agent-workspace/engine/testing` — the conformance kit and the scripted engine (ENG-04, #303).
 *
 * A separate entry point from the port itself so that importing {@link AgentEngine} does not drag
 * a fake gateway and a test double into a runtime image. `knip.json` lists this subpath as an
 * entry point for the same reason `@agent-workspace/core/db` is listed: it has no importer inside
 * its own package, and its consumers are tests.
 */
export * from './conformance.js';
export * from './gateway.js';
export * from './scripted-engine.js';
export * from './session-store.js';
