/** Why the embedded package build stopped. Each code names one failed rule of ADR-0109's build. */
export type EmbeddedBuildErrorCode =
  | 'external_version_conflict'
  | 'external_unresolved'
  | 'external_not_pinned'
  | 'external_pin_mismatch'
  | 'pin_not_imported'
  | 'unexplained_server_load'
  | 'next_build_failed'
  | 'web_tree_changed'
  | 'foreign_scope_in_bundle'
  | 'engine_packages_drift';

/** A typed failure of `node src/packaging/main.ts`; `code` is stable, the message names the cause. */
export class EmbeddedBuildError extends Error {
  readonly code: EmbeddedBuildErrorCode;

  constructor(code: EmbeddedBuildErrorCode, message: string) {
    super(message);
    this.name = 'EmbeddedBuildError';
    this.code = code;
  }
}

/** Whether a file-system error says the path does not exist. */
export function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
