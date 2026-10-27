/**
 * Request-body validation for `POST` and `PATCH /api/skills`. Pure: nothing here reads the store, so
 * `handlers.ts` owns every decision that needs one.
 */
import { SKILL_FILE_PATH_MAX_BYTES, SKILL_MD_FILENAME } from '@indx-workspace/contracts/skills';

import { createCaseFoldGuard, isAdmissibleRelativePath, isValidSkillName } from './keys';
import type { ApiResult } from '../http/result';
import { problem } from './result';

// ── Input shapes, validated field by field (ADR-0015: positive assertion, explicit rejecting else) ─

export interface ImportFileEntry {
  readonly path: string;
  readonly contentBase64: string;
}

interface ValidatedImport {
  readonly name: string;
  readonly files: readonly ImportFileEntry[];
}

export function validateImportBody(
  raw: unknown,
): { ok: true; value: ValidatedImport } | { ok: false; result: ApiResult } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      result: problem(400, 'malformed_body', 'The request body must be a JSON object.'),
    };
  }
  const body = raw as Record<string, unknown>;

  const name = body['name'];
  if (typeof name !== 'string' || name === '') {
    return {
      ok: false,
      result: problem(400, 'missing_name', '"name" is required and must be a non-empty string.'),
    };
  }
  if (!isValidSkillName(name)) {
    return {
      ok: false,
      result: problem(
        400,
        'invalid_name',
        `"name" must match ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$ (lower-case letters, digits and ` +
          `single hyphens, 1-64 characters) — got ${JSON.stringify(name)}.`,
      ),
    };
  }

  const rawFiles = body['files'];
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return {
      ok: false,
      result: problem(400, 'missing_files', '"files" is required and must be a non-empty array.'),
    };
  }

  const files: ImportFileEntry[] = [];
  const seenPaths = new Set<string>();
  // Round 4 (ADR-0048, B2-PATCH): this used to be an inline `Map`, the only copy of this check in
  // the module. `patchSkill`'s `files` array had no copy at all — the two call sites had drifted,
  // which is exactly what B2-PATCH's confirmer found. `keys.ts#createCaseFoldGuard` is now the one
  // implementation both this function and `patchSkill` call; a new skill has no prior files, so it
  // is seeded empty here (see `patchSkill` for the seeded case).
  const caseFoldGuard = createCaseFoldGuard([]);
  for (const [index, entry] of rawFiles.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return {
        ok: false,
        result: problem(400, 'malformed_file_entry', `files[${index}] must be an object.`),
      };
    }
    const fileEntry = entry as Record<string, unknown>;
    const path = fileEntry['path'];
    const contentBase64 = fileEntry['contentBase64'];
    if (typeof path !== 'string' || path === '') {
      return {
        ok: false,
        result: problem(
          400,
          'malformed_file_entry',
          `files[${index}].path must be a non-empty string.`,
        ),
      };
    }
    if (typeof contentBase64 !== 'string') {
      return {
        ok: false,
        result: problem(
          400,
          'malformed_file_entry',
          `files[${index}].contentBase64 must be a string.`,
        ),
      };
    }
    // Round 3, B1/B2 (ADR-0044): admit by grammar before anything else runs. Round 2 tried to keep
    // `SKILL.md` safe by widening a blocklist (exact string, then case-fold) and was defeated both
    // times by a spelling neither rule enumerated — `SKILL.md::$DATA`, NTFS's default-data-stream
    // syntax. That string is not a "different file that happens to collide"; it is not a legal name
    // at all under the grammar this task now enforces (`:` and `$` are outside
    // `keys.ts#isAdmissibleRelativePath`'s character class), so it is refused here, by name, before
    // it is ever compared to another path or handed to `skillFileKey`. `key-safety.ts`'s own guard
    // still runs again when `store.put` executes below — this check does not replace it, it runs
    // first and for a different reason (ADR-0044: refuse by grammar, not by enumerating aliases).
    if (!isAdmissibleRelativePath(path)) {
      return {
        ok: false,
        result: problem(
          400,
          'inadmissible_path',
          `files[${index}].path ${JSON.stringify(path)} is not an admissible file path: every ` +
            'segment must match [A-Za-z0-9][A-Za-z0-9._-]*, no segment may end in "." or a space, ' +
            'no segment may be "." or "..", and the whole path must be at most ' +
            `${String(SKILL_FILE_PATH_MAX_BYTES)} bytes (docs/adr/` +
            '0044-a-caller-supplied-name-is-admitted-by-a-grammar-never-screened-by-a-blocklist.md).',
        ),
      };
    }
    if (seenPaths.has(path)) {
      return {
        ok: false,
        result: problem(
          400,
          'duplicate_path',
          `files[${index}].path ${JSON.stringify(path)} is repeated.`,
        ),
      };
    }
    // Round 3, B2 (ADR-0044): now that `path` has already passed the admission grammar above, every
    // character in it is ASCII alphanumeric, `.`, `_` or `-` — an alphabet with no case-folding
    // surprise comparable to `'ſ'` or Turkish `İ`/`ı` (those are refused by the grammar itself, not
    // reached here). So this comparison is a real, decidable check over a bounded alphabet, not the
    // guess round 2's comment claimed it had to be over an unbounded one: two admitted paths that
    // are equal once case-folded (`SKILL.md` and `skill.md`) would still merge into one file on a
    // case-insensitive filesystem, and this refuses that combination — 409, not a silently merged
    // 201 — rather than trying to guess which of the two bytes payloads would have survived.
    const collidesWith = caseFoldGuard.check(path);
    if (collidesWith !== null) {
      return {
        ok: false,
        result: problem(
          409,
          'colliding_paths',
          `files[${index}].path ${JSON.stringify(path)} and ${JSON.stringify(collidesWith)} are ` +
            'the same name once case is folded — a filesystem-backed store cannot be relied on to ' +
            'keep them as two files, so this import is refused rather than silently merging them.',
        ),
      };
    }
    caseFoldGuard.add(path);
    seenPaths.add(path);
    files.push({ path, contentBase64 });
  }

  if (!files.some((file) => file.path === SKILL_MD_FILENAME)) {
    return {
      ok: false,
      result: problem(
        400,
        'missing_skill_md',
        `"files" must include one entry with path ${JSON.stringify(SKILL_MD_FILENAME)} — spec §7 ` +
          'requires every skill directory to contain it.',
      ),
    };
  }

  return { ok: true, value: { name, files } };
}

export interface PatchFileEntry {
  readonly path: string;
  readonly contentBase64: string;
}

export function validatePatchBody(raw: unknown):
  | {
      ok: true;
      value: {
        enabled?: boolean;
        files?: readonly PatchFileEntry[];
        removeFiles?: readonly string[];
      };
    }
  | { ok: false; result: ApiResult } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      result: problem(400, 'malformed_body', 'The request body must be a JSON object.'),
    };
  }
  const body = raw as Record<string, unknown>;
  const out: { enabled?: boolean; files?: PatchFileEntry[]; removeFiles?: string[] } = {};

  if ('enabled' in body) {
    if (typeof body['enabled'] !== 'boolean') {
      return {
        ok: false,
        result: problem(400, 'malformed_body', '"enabled" must be true or false.'),
      };
    }
    out.enabled = body['enabled'];
  }

  if ('files' in body) {
    const rawFiles = body['files'];
    if (!Array.isArray(rawFiles)) {
      return { ok: false, result: problem(400, 'malformed_body', '"files" must be an array.') };
    }
    const files: PatchFileEntry[] = [];
    for (const [index, entry] of rawFiles.entries()) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return {
          ok: false,
          result: problem(400, 'malformed_file_entry', `files[${index}] must be an object.`),
        };
      }
      const fileEntry = entry as Record<string, unknown>;
      const path = fileEntry['path'];
      const contentBase64 = fileEntry['contentBase64'];
      if (typeof path !== 'string' || path === '') {
        return {
          ok: false,
          result: problem(
            400,
            'malformed_file_entry',
            `files[${index}].path must be a non-empty string.`,
          ),
        };
      }
      if (typeof contentBase64 !== 'string') {
        return {
          ok: false,
          result: problem(
            400,
            'malformed_file_entry',
            `files[${index}].contentBase64 must be a string.`,
          ),
        };
      }
      // ADR-0044, same rule as `validateImportBody`: admit by grammar before this path is compared
      // to anything or turned into a key. See that function's comment for the full account.
      if (!isAdmissibleRelativePath(path)) {
        return {
          ok: false,
          result: problem(
            400,
            'inadmissible_path',
            `files[${index}].path ${JSON.stringify(path)} is not an admissible file path: every ` +
              'segment must match [A-Za-z0-9][A-Za-z0-9._-]*, no segment may end in "." or a ' +
              'space, no segment may be "." or "..", and the whole path must be at most ' +
              `${String(SKILL_FILE_PATH_MAX_BYTES)} bytes (docs/adr/` +
              '0044-a-caller-supplied-name-is-admitted-by-a-grammar-never-screened-by-a-blocklist.md).',
          ),
        };
      }
      files.push({ path, contentBase64 });
    }
    out.files = files;
  }

  if ('removeFiles' in body) {
    const rawRemove = body['removeFiles'];
    if (!Array.isArray(rawRemove) || rawRemove.some((entry) => typeof entry !== 'string')) {
      return {
        ok: false,
        result: problem(400, 'malformed_body', '"removeFiles" must be an array of strings.'),
      };
    }
    const removeFiles = rawRemove as string[];
    // ADR-0044, B1: this is the exact place round 2's guard was defeated —
    // `removeFiles: ["SKILL.md::$DATA"]` reached `patchSkill` as an ordinary string and was only
    // ever compared, case-folded, against the literal name "skill.md". Admitting by grammar here
    // means `SKILL.md::$DATA` (`:` and `$` are outside the admitted class) is refused with a 400
    // naming the rule, before `patchSkill` ever sees it, rather than reaching `store.delete` and
    // destroying `SKILL.md` under a name that was never `SKILL.md` to begin with.
    for (const [index, relativePath] of removeFiles.entries()) {
      if (!isAdmissibleRelativePath(relativePath)) {
        return {
          ok: false,
          result: problem(
            400,
            'inadmissible_path',
            `removeFiles[${index}] ${JSON.stringify(relativePath)} is not an admissible file ` +
              'path: every segment must match [A-Za-z0-9][A-Za-z0-9._-]*, no segment may end in ' +
              '"." or a space, no segment may be "." or "..", and the whole path must be at most ' +
              `${String(SKILL_FILE_PATH_MAX_BYTES)} bytes (docs/adr/` +
              '0044-a-caller-supplied-name-is-admitted-by-a-grammar-never-screened-by-a-blocklist.md).',
          ),
        };
      }
    }
    out.removeFiles = removeFiles;
  }

  if (out.enabled === undefined && out.files === undefined && out.removeFiles === undefined) {
    return {
      ok: false,
      result: problem(
        400,
        'empty_patch',
        'The request body must set at least one of "enabled", "files" or "removeFiles".',
      ),
    };
  }
  return { ok: true, value: out };
}
