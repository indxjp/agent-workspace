/** Skill reads, imports, revisions and file exports over the storage ports. */

import { UnsafeObjectKeyError } from '@agent-workspace/core/storage/keys';
import type { ApiResult } from '../http/result';
import { problem } from './result';
import { SkillSaveRefusedError } from './tree';

/**
 * A save the catalog service refused, as the 4xx the caller can act on: another push of the skill
 * is still writing (`upload_in_progress`), an older file outside the skill holds one of its paths
 * (`path_taken`), a concurrent delete moved the path (`path_changed`), or a file is too large.
 */
export function saveRefusedProblem(error: SkillSaveRefusedError): ApiResult {
  switch (error.code) {
    case 'upload_in_progress':
      return problem(
        409,
        'upload_in_progress',
        'Another upload of this skill is still writing its files; retry once it finishes.',
      );
    case 'path_taken':
      return problem(
        409,
        'path_taken',
        'A file that is not part of this skill already holds one of its paths.',
      );
    case 'path_changed':
      return problem(
        409,
        'path_changed',
        "One of this skill's files was removed or moved while it was written; retry.",
      );
    case 'too_large':
      return problem(413, 'too_large', 'A file is larger than a skill file may be.');
  }
}

/** A writer's refusal as this route's answer; anything else is rethrown. */
export function writeRefusedProblem(error: unknown): ApiResult {
  if (error instanceof UnsafeObjectKeyError) {
    return problem(400, 'invalid_path', `A file path is not valid: ${error.message}`);
  }
  if (error instanceof SkillSaveRefusedError) return saveRefusedProblem(error);
  throw error;
}
