import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';

/**
 * The shape of a skill's name: a lower-case slug of letters, digits and single hyphens, 1–64
 * characters, exactly the directory name the Claude Agent SDK loads (`.claude/skills/<name>/`).
 * Transcribed from the `skills_name_shape` database CHECK that `apps/web/server/skills/keys.ts`
 * restates; `POST /api/skills` refuses a name outside it as `400 invalid_name`, and a `:name`
 * path segment outside it is a `404 skill_not_found` (no such skill could ever have been made).
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const SKILL_NAME_MAX_LENGTH = 64;

/** The one file every skill directory must contain; `removeFiles` may never name it. */
export const SKILL_MD_FILENAME = 'SKILL.md';

/**
 * The longest relative path one skill file may have, in UTF-8 bytes. The server admits a path by
 * grammar (every `/`-separated segment `[A-Za-z0-9][A-Za-z0-9._-]*`, none ending in `.` or a
 * space, none `.` or `..`) and refuses anything else as `400 inadmissible_path`; the grammar is
 * the server's to state, so only its byte ceiling is published here.
 */
export const SKILL_FILE_PATH_MAX_BYTES = 4096;

/**
 * The most bytes one `POST` or `PATCH /api/skills` request body may carry, base64 included; a
 * larger body is a `413 request_body_too_large`, refused while it streams. There is no per-file
 * or file-count bound: the body ceiling is the only size limit.
 */
export const MAX_SKILL_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Standard, padded base64 — the empty string included — as `contentBase64` must be encoded. The
 * server validates a request's bytes against this before decoding (a lenient decoder would turn
 * a malformed value into *some* bytes rather than refusing it: `400 malformed_content`), and an
 * export renders every file the same way.
 */
export const SKILL_FILE_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Problem codes the skills routes own, with the status each one travels under. The common
 * vocabulary (`malformed_body`, `request_body_too_large`, `unsupported_media_type`, …) is
 * `COMMON_PROBLEM_CODES` at the package root.
 */
export const SKILLS_PROBLEM_CODES = {
  missing_name: 400,
  /** A `name` outside {@link SKILL_NAME_PATTERN}. */
  invalid_name: 400,
  /** `files` absent or empty on import. */
  missing_files: 400,
  /** A `files` entry that is not `{ path, contentBase64 }` with a non-empty string path. */
  malformed_file_entry: 400,
  /** A path outside the server's admission grammar (see {@link SKILL_FILE_PATH_MAX_BYTES}). */
  inadmissible_path: 400,
  /** The same path twice in one request. */
  duplicate_path: 400,
  /** An import whose `files` has no `SKILL.md` entry. */
  missing_skill_md: 400,
  /** A `contentBase64` outside {@link SKILL_FILE_BASE64_PATTERN}. */
  malformed_content: 400,
  /** A path the object-store key guard refuses after admission. */
  invalid_path: 400,
  /** A `PATCH` body that sets none of `enabled`, `files`, `removeFiles`. */
  empty_patch: 400,
  /** `removeFiles` names `SKILL.md`, in any letter case. */
  cannot_remove_skill_md: 400,
  /** Also the answer for a `:name` outside {@link SKILL_NAME_PATTERN} (never a `400`). */
  skill_not_found: 404,
  skill_already_exists: 409,
  /** Two paths that differ only by letter case, in one request or against an existing file. */
  colliding_paths: 409,
  /** A `PATCH` whose deletes would have left the skill without `SKILL.md`; rolled back. */
  skill_md_removal_rejected: 409,
  /**
   * `DELETE /api/skills/:name` while an agent still has the skill assigned. `details` names each
   * agent as `agent:<id>` (`formatInUseReferrer`); nothing is deleted. Unassign, then retry.
   */
  skill_in_use: 409,
  /**
   * An export listed a file it could then not read back (a concurrent delete), or (K-4, issue
   * #234) a route that must answer with a catalog `id` — `GET /api/skills`, `GET /api/skills/:name`
   * or `PATCH /api/skills/:name` — found a row with no readable `SKILL.md`. That is a state
   * `POST`/`PATCH` refuse to create, so it can only be a pre-existing row; all three routes refuse
   * it identically rather than one of them answering a body without the required `id`.
   */
  store_inconsistent: 500,
  skills_runtime_not_configured: 503,
} as const;

export type SkillsProblemCode = keyof typeof SKILLS_PROBLEM_CODES;

const skillSummaryFields = {
  /**
   * The resource-catalog row's id, opaque. Required (K-4, issue #234): a route with no catalog
   * configured answers `503 skills_runtime_not_configured` rather than a body with no id, and
   * `POST`/`PATCH` refuse a `SKILL.md` whose bytes are not valid UTF-8 (`400 malformed_content`),
   * so no new skill can enter a state a catalog row cannot be written for. A skill is always
   * addressed by `name`, never by this.
   */
  id: z.string().min(1),
  name: z.string().regex(SKILL_NAME_PATTERN),
  enabled: z.boolean(),
  /** From `SKILL.md`'s frontmatter `description`, or `null` when it has none. */
  description: z.string().nullable(),
  /** Every file under the skill's directory, `SKILL.md` included. */
  fileCount: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
};

/**
 * The fields every skill body carries. No route renders exactly this today — each item of
 * `GET /api/skills` is a full {@link SkillDetailSchema} — so this is the narrow projection a
 * consumer that lists skills may keep, not a wire shape of its own.
 */
export const SkillSummarySchema = z.object(skillSummaryFields).strict().readonly();

export type SkillSummary = z.infer<typeof SkillSummarySchema>;

/** One file of a skill as the detail lists it: its relative path and stored size, no bytes. */
export const SkillFileStatSchema = z
  .object({
    path: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export type SkillFileStat = z.infer<typeof SkillFileStatSchema>;

/**
 * One skill as `GET /api/skills/:name`, the `201` of `POST /api/skills`, the `200` of
 * `PATCH /api/skills/:name` and every item of `GET /api/skills` render it, wrapped as `{ skill }`
 * everywhere but the list.
 *
 * `source` is `SKILL.md`'s complete text, so an editor can preserve frontmatter fields the
 * platform does not parse; `instructions` is its Markdown body and `allowedTools` its
 * `allowed-tools` list. All three are `null` when `SKILL.md` is missing or not valid UTF-8
 * (`allowedTools` also when the field is absent); the bytes are still stored and exported.
 */
export const SkillDetailSchema = z
  .object({
    ...skillSummaryFields,
    source: z.string().nullable(),
    instructions: z.string().nullable(),
    allowedTools: z.array(z.string()).readonly().nullable(),
    files: z.array(SkillFileStatSchema).readonly(),
  })
  .strict()
  .readonly();

export type SkillDetail = z.infer<typeof SkillDetailSchema>;

/**
 * One file with its bytes, as an import or patch sends it and an export returns it. `path` is
 * relative to the skill directory with forward slashes; `contentBase64` is the file's bytes in
 * standard padded base64 (see {@link SKILL_FILE_BASE64_PATTERN}) — an empty file is `""`.
 */
export const SkillFileSchema = z
  .object({
    path: z.string().min(1),
    contentBase64: z.string().regex(SKILL_FILE_BASE64_PATTERN),
  })
  .strict()
  .readonly();

export type SkillFile = z.infer<typeof SkillFileSchema>;

/** The body of `GET /api/skills`: every skill of the workspace, by name, each in full detail. */
export const SkillListResponseSchema = z
  .object({ skills: z.array(SkillDetailSchema).readonly() })
  .strict()
  .readonly();

export type SkillListResponse = z.infer<typeof SkillListResponseSchema>;

/** The body of `GET /api/skills/:name`, `PATCH /api/skills/:name` and the `201` of `POST`. */
export const SkillResponseSchema = z.object({ skill: SkillDetailSchema }).strict().readonly();

export type SkillResponse = z.infer<typeof SkillResponseSchema>;

/**
 * A skill's directory, byte for byte: every stored file re-served exactly as it was imported,
 * `SKILL.md` included, in a stable order by path. Importing it under another name reproduces
 * the skill.
 */
export const SkillExportSchema = z
  .object({
    name: z.string().regex(SKILL_NAME_PATTERN),
    files: z.array(SkillFileSchema).readonly(),
  })
  .strict()
  .readonly();

export type SkillExport = z.infer<typeof SkillExportSchema>;

/** The body of `GET /api/skills/:name?export=true`: the export wrapped as `{ skill }`. */
export const SkillExportResponseSchema = z.object({ skill: SkillExportSchema }).strict().readonly();

export type SkillExportResponse = z.infer<typeof SkillExportResponseSchema>;

/**
 * The body of `POST /api/skills`, which both creates a skill (one `SKILL.md`) and imports a
 * whole directory. `files` must be non-empty, contain a `SKILL.md` entry, and hold no two paths
 * that are equal once letter case is folded (`409 colliding_paths`); the name must be free in
 * the workspace (`409 skill_already_exists`).
 */
export interface ImportSkillInput {
  readonly name: string;
  readonly files: readonly SkillFile[];
}

/**
 * The body of `PATCH /api/skills/:name`. At least one field must be present (`400 empty_patch`).
 * `files` writes or overwrites by exact path; `removeFiles` deletes by path and may never name
 * `SKILL.md`. Writes run before deletes, so a case-only rename in one request is refused as a
 * collision — do it as two requests.
 */
export interface UpdateSkillPatch {
  readonly enabled?: boolean;
  readonly files?: readonly SkillFile[];
  readonly removeFiles?: readonly string[];
}
