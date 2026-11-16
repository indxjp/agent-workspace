/** Skill reads, imports, revisions and file exports over the storage ports. */
import { SKILL_FILE_BASE64_PATTERN, SKILL_MD_FILENAME } from '@indx-workspace/contracts/skills';
import type { ApiResult } from '../http/result';
import { problem } from './result';
import { type ImportFileEntry } from './validate';

// ── Base64, validated rather than merely decoded (see this module's own `importSkill`) ───────

// `Buffer.from(x, 'base64')` silently drops characters it does not recognise rather than throwing,
// so a caller's malformed value would decode to *some* bytes rather than being refused (ADR-0015: a
// check that cannot run must fail). The positive grammar is checked before any decoding happens.
function decodeBase64(value: string): Uint8Array | null {
  if (!SKILL_FILE_BASE64_PATTERN.test(value)) return null;
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/**
 * The SKILL.md text of an import as `describeSkill` will read it back (BOM stripped), or `null` when
 * its base64 or its UTF-8 is invalid, which `importSkill` refuses before it writes anything.
 */
export function skillMdText(files: readonly ImportFileEntry[]): string | null {
  const entry = files.find((file) => file.path === SKILL_MD_FILENAME);
  const bytes = entry === undefined ? null : decodeBase64(entry.contentBase64);
  return bytes === null ? null : utf8Text(bytes);
}

/** `bytes` as UTF-8 text with a BOM stripped, or `null` when they are not valid UTF-8. */
export function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * K-4 (issue #234): true only for bytes that decode as UTF-8 without loss. `SKILL.md`'s bytes must
 * pass this before `POST`/`PATCH` will write them, so a skill can no longer enter the "exists with
 * an unreadable `SKILL.md`" state that used to make {@link describeSkill}'s `source` (and, before
 * K-4, the catalog `id`) `null`. A pre-existing row in that state is the residual K-4 cannot close
 * retroactively — see {@link listSkills}'s `store_inconsistent` answer.
 */
function isValidUtf8(bytes: Uint8Array): boolean {
  return utf8Text(bytes) !== null;
}

// ── POST /api/skills/:name/revisions ───────────────────────────────────────────────────────────

export interface ReplacedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export function decodeSkillFiles(
  entries: readonly ImportFileEntry[],
):
  | { readonly ok: true; readonly files: ReplacedFile[] }
  | { readonly ok: false; readonly result: ApiResult } {
  const files: ReplacedFile[] = [];
  for (const file of entries) {
    const bytes = decodeBase64(file.contentBase64);
    if (bytes === null) {
      return {
        ok: false,
        result: problem(
          400,
          'malformed_content',
          `files entry ${JSON.stringify(file.path)} is not valid base64.`,
        ),
      };
    }
    if (file.path === SKILL_MD_FILENAME && !isValidUtf8(bytes)) {
      return {
        ok: false,
        result: problem(
          400,
          'malformed_content',
          `${SKILL_MD_FILENAME}'s bytes are not valid UTF-8.`,
        ),
      };
    }
    files.push({ path: file.path, bytes });
  }

  return { ok: true, files };
}
