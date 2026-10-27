// Types for the package entry point, plain JavaScript (index.mjs) so it needs no build.
import type { BuiltinSkillName, SkillFile } from '@indx-workspace/contracts/skills';

/**
 * The files of a built-in skill, sorted by path, in the shape `POST /api/skills` takes. Type
 * declarations are left out: they are for this repository's tests, not for a run's sandbox.
 *
 * @throws {Error} when the skill is not bundled.
 */
export function builtinSkillFiles(name: BuiltinSkillName): readonly SkillFile[];
