/**
 * Limits of the database layer that callers outside it enforce too, kept free of drizzle and the
 * schema so `@agent-workspace/core/db-model` can carry them.
 */

/** The most characters one passage may hold; longer text is split into several passages. */
export const FILE_TEXT_MAX_CHARS = 20_000;

/** The default page size of `SessionStateRepository.list`, and its ceiling. */
export const SESSION_STATE_PAGE_LIMIT = 2_000;
