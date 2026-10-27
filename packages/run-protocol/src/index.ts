/**
 * `@agent-workspace/run-protocol` — the private contract between the control plane, the runner and
 * the engine adapters (F-08): the agent configuration schemas, the `/run` request (`RunRequest`),
 * and the Claude Agent SDK event stream with its mapping onto the neutral `agent.*` frames.
 *
 * It holds no I/O and depends only on the wire contracts, `zod` and the engine port (for the frame
 * builder the mapping shares with every adapter), so a caller that needs `RunRequest` does not
 * inherit the database and cloud SDKs of `@agent-workspace/core`.
 */
export * from './types.js';
export * from './schemas.js';
