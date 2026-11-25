/**
 * The two reserved roots of the workspace file tree that hold skills, owned by storage's key
 * layout (ADR W2-CP-04; refactoring part 10 step 6). The files routes refuse writes under them
 * (`files/file-path-policy.ts`), and the skills module builds its names on them (`skills/keys.ts`
 * re-exports both). They live here, in the storage and sharing context, so the files policy no
 * longer imports the agents context. Pure constants: importing this module loads nothing.
 */

/**
 * The top-level prefix under which a published revision's bytes lived before revisions became
 * `skills` rows (SDK-19, N-1). The files API still refuses it as the root of a path, so a published
 * revision's name never turns into a user file.
 */
export const SKILL_REVISIONS_PREFIX = 'skill-revisions';

/**
 * The reserved root of the files catalog under which skill files live as `skills`-area rows. The
 * catalog's unique key has no area, so a bare `<name>/…` path would collide with a user's own file
 * of that path; the files API refuses this root, as it does `.attachments/`.
 */
export const SKILL_ROWS_ROOT = '.skills';
