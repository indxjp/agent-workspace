// The package entry point, plain JavaScript like the skill scripts it bundles, so Node, Vitest and
// Next.js all load it from source: there is no build step, and no `dist/` a consumer must wait for.
// Types are in index.d.mts.
import { Buffer } from 'node:buffer';

import skills from './skills.json' with { type: 'json' };

/**
 * The files of a built-in skill, sorted by path, in the shape `POST /api/skills` takes. Type
 * declarations are left out: they are for this repository's tests, not for a run's sandbox.
 *
 * @param {import('@indx-workspace/contracts/skills').BuiltinSkillName} name
 * @returns {readonly import('@indx-workspace/contracts/skills').SkillFile[]}
 * @throws {Error} when the skill is not bundled.
 */
export function builtinSkillFiles(name) {
  const files = Object.hasOwn(skills, name) ? skills[name] : undefined;
  if (files === undefined) throw new Error(`built-in skill ${name} is not bundled`);
  return files.map((file) => ({
    path: file.path,
    contentBase64: Buffer.from(file.content, 'utf8').toString('base64'),
  }));
}
