/**
 * The reserved head of every API key name the local runtime (`aw dev`, ADR-0109) mints. Owned by
 * core so that `DatabaseWorkspaceDirectory.reassignLocalRuntimeKeyOwnership` selects exactly
 * these keys and no caller can widen the selection to hosted keys (issue #509, S1-24).
 */
export const LOCAL_RUNTIME_API_KEY_NAME_PREFIX = 'aw dev local runtime ';
