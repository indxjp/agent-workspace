/**
 * The one error a resource store throws (issue #1502), the page store's codes (issue #1520) among
 * them. Its `code`, `status`, `message` and
 * `details` are what a route renders as the problem envelope (ADR-0075); the message is fixed,
 * safe prose for each code and never carries a driver's or a database's own text. Pure.
 */

/** Every code a store throws, with the HTTP status it travels under. */
export const APP_STORE_ERROR_STATUS = {
  invalid_cursor: 400,
  invalid_limit: 400,
  invalid_query: 400,
  invalid_body: 400,
  search_unsupported: 400,
  forbidden: 403,
  resource_not_found: 404,
  revision_not_found: 404,
  page_cycle: 409,
  page_space_mismatch: 409,
  page_has_children: 409,
  page_conflict: 409,
  internal_error: 500,
} as const;

/** A code a store throws. */
export type AppStoreErrorCode = keyof typeof APP_STORE_ERROR_STATUS;

const MESSAGES: Readonly<Record<AppStoreErrorCode, string>> = {
  invalid_cursor: 'The cursor is not one this list issued for this workspace.',
  invalid_limit: 'The limit must be a whole number from 1 to 200.',
  invalid_query: 'The query is not one this list accepts.',
  invalid_body: 'The record is not valid for this resource.',
  search_unsupported: 'This resource does not declare search.',
  forbidden: 'You may not do this to this record.',
  resource_not_found: 'The record does not exist, or you may not see it.',
  revision_not_found: 'The page has no revision with this id.',
  page_cycle: 'A page cannot move under itself or under a page below it.',
  page_space_mismatch: 'A page and the page it nests under must be in the same space.',
  page_has_children: 'The page has pages below it; delete them too, or move them first.',
  page_conflict: 'The page changed since the revision you edited. Read it again and retry.',
  internal_error: 'The record store failed. Try again later.',
};

/** Why a store operation was refused or failed. */
export class AppStoreError extends Error {
  readonly code: AppStoreErrorCode;
  readonly status: (typeof APP_STORE_ERROR_STATUS)[AppStoreErrorCode];
  /** The dotted paths of the invalid input, or the fields an agent may not write. */
  readonly details?: readonly string[];

  constructor(
    code: AppStoreErrorCode,
    options: { readonly details?: readonly string[]; readonly cause?: unknown } = {},
  ) {
    super(MESSAGES[code], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppStoreError';
    this.code = code;
    this.status = APP_STORE_ERROR_STATUS[code];
    if (options.details !== undefined) this.details = Object.freeze([...options.details]);
  }
}
