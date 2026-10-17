/**
 * The Compose project-name rules every command shares: `create` derives a name with them
 * (`render/env.ts`), and `start`, `validate` and `stop` refuse a hand-edited one that breaks them
 * (`deployment.ts`). Each keeps its own length cap: `create` writes at most 48 characters, and the
 * commands accept up to 63, the session cookie's suffix limit (issue #394).
 */

/** Compose's own rule for a project name: lowercase letters, digits, `_` and `-`, led by neither. */
export const COMPOSE_PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;

/**
 * The repository's own development stack (`compose.yaml`) is the Compose project `agent-workspace`
 * with networks of that prefix. A generated project of the same name would adopt its containers
 * and remove them as orphans, and `agent-workspace stop` would take that stack down.
 */
export const RESERVED_COMPOSE_PROJECT_NAME = 'agent-workspace';
