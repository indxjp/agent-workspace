/**
 * `@agent-workspace/core` — persistence, object storage and secrets.
 *
 * The agent configuration schemas, the run request and the `agent.*` mapping live in
 * `@agent-workspace/run-protocol` (F-08); import them from there.
 *
 * The database layer is **not** re-exported here. It has its own entry point,
 * `@agent-workspace/core/db`, so that importing a schema does not drag a Postgres client into a
 * caller that only wanted to validate a form.
 */
export const PACKAGE_NAME = '@agent-workspace/core';

export * from './net/egress-policy.js';
export * from './net/outbound-proxy.js';
export * from './cleanup.js';
