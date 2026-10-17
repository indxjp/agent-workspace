/**
 * Skill materialisation, as the port divides it (ENG-04b, #325).
 *
 * Spec §7 gives a tenant a set of `SKILL.md` skills and says a run may use the ones its agent is
 * assigned. Two halves follow, and ENG-04 (#324) could only deliver one of them:
 *
 *   * **Writing bytes into a sandbox safely** is engine-neutral, and the runner has already solved
 *     it once — a symlink anywhere on the path is refused rather than followed, files land `0o444`
 *     under `0o555` directories, and a manifest removes what an assignment revoked since the last
 *     turn. Nothing about that changes per engine.
 *   * **Where a skill goes** is entirely the engine's business. The Claude Agent SDK reads
 *     `${CLAUDE_CONFIG_DIR}/skills/<name>/`; the next engine will not.
 *
 * So `AgentEngine.placeSkills` answers the second question and the runner does the first. This
 * module is the check that joins them: the runner is handed paths by code it does not own, and a
 * placement that escaped the engine's own configuration directory would put tenant bytes somewhere
 * the platform never agreed to — the sandbox root, another skill's directory, or (through `..`)
 * outside the workspace altogether.
 *
 * `packages/engine` has no filesystem and no `node:path` (see `./port.ts`'s header), which is the
 * right place for this check rather than an obstacle to it: what is being decided is whether a
 * *string* names a location the platform allows, and that decision must not depend on which
 * platform's separator rules happen to apply. `./path-grant.ts` is the same argument in full.
 */
import { normaliseGrantPath } from './path-grant.js';
import type { EngineSkillFile, EngineSkillGrant } from './port.js';

/** Why a skill placement may not be written. */
export const SKILL_PLACEMENT_REFUSALS = [
  /** The path does not normalise to a location inside the workspace. */
  'unusable_path',
  /** The path normalises outside the engine's own declared configuration directory. */
  'outside_config_directory',
  /** The placement names a skill the request did not grant. */
  'unknown_skill',
  /** Two placements normalise to one path, so one would silently overwrite the other. */
  'duplicate_path',
  /** A granted skill has files and the adapter placed none of them. */
  'skill_dropped',
] as const;
export type SkillPlacementRefusal = (typeof SKILL_PLACEMENT_REFUSALS)[number];

export type SkillPlacementVerdict =
  | {
      readonly ok: true;
      /** How many files will be written. Counted, so a verdict over nothing is visible. */
      readonly files: number;
      /** The normalised path of each placement, in the order the adapter returned them. */
      readonly paths: readonly string[];
    }
  | {
      readonly ok: false;
      readonly refusal: SkillPlacementRefusal;
      readonly reason: string;
    };

function refuse(refusal: SkillPlacementRefusal, reason: string): SkillPlacementVerdict {
  return { ok: false, refusal, reason };
}

/**
 * Check an adapter's skill placement against the grants it was derived from, and against the
 * directory the adapter itself declared.
 *
 * A **positive** assertion (ADR-0015): the verdict is `ok` because every placement was classified
 * and every granted skill was accounted for, never because no rule objected. The five refusals are
 * five different mistakes an adapter can make, and each is named rather than folded into "invalid":
 *
 *   * a path that does not normalise, or that climbs out of the workspace (`unusable_path`);
 *   * a path inside the workspace but outside the engine's configuration directory
 *     (`outside_config_directory`) — this is the one the conformance kit's negative adapter breaks;
 *   * a placement for a skill nobody granted (`unknown_skill`) — bytes from somewhere else;
 *   * two placements on one path (`duplicate_path`), because the second write wins silently and the
 *     run would then use a skill whose contents nobody chose;
 *   * a granted skill with no placement at all (`skill_dropped`), which is the vacuity control: an
 *     adapter that returns `[]` must not pass a check about where its skills land.
 */
export function skillPlacementVerdict(
  placements: readonly EngineSkillFile[],
  grants: readonly EngineSkillGrant[],
  protectedConfigDirectory: string,
): SkillPlacementVerdict {
  const root = normaliseGrantPath(protectedConfigDirectory);
  if (!root.ok) {
    return refuse(
      'outside_config_directory',
      `the engine declares ${JSON.stringify(protectedConfigDirectory)} as its configuration directory and it is not a usable workspace-relative path: ${root.reason}`,
    );
  }
  const granted = new Set(grants.map((grant) => grant.name));
  const placed = new Set<string>();
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const placement of placements) {
    // A `..` is *resolved* by `normaliseGrantPath`, not refused: `.claude/skills/x/../../settings.json`
    // normalises to `.claude/settings.json`, which is inside the declared directory and is the
    // engine's own settings file. A placement that means a path inside a skill's own directory never
    // needs the segment, so refuse it outright rather than resolve it somewhere else. Checked against
    // both separators: `normaliseGrantPath` already refuses a raw backslash as `illegal_character`,
    // but a `..` segment spelled either way is refused here, by name, before that check runs.
    if (placement.path.split('/').includes('..') || placement.path.split('\\').includes('..')) {
      return refuse(
        'unusable_path',
        `skill ${JSON.stringify(placement.skill)} would be written to ${JSON.stringify(placement.path)}, which uses ".." to leave the directory its own name puts it in.`,
      );
    }
    const normalised = normaliseGrantPath(placement.path);
    if (!normalised.ok) {
      return refuse(
        'unusable_path',
        `skill ${JSON.stringify(placement.skill)} would be written to ${JSON.stringify(placement.path)}, which is not a usable workspace path: ${normalised.reason}`,
      );
    }
    // Compared segment by segment, never as a string prefix: `.claude-backup/x` starts with
    // `.claude` as text and is a different directory as a path.
    const inside =
      normalised.segments.length > root.segments.length &&
      root.segments.every((segment, index) => normalised.segments[index] === segment);
    if (!inside) {
      return refuse(
        'outside_config_directory',
        `skill ${JSON.stringify(placement.skill)} would be written to ${JSON.stringify(normalised.path)}, which is outside the engine's declared configuration directory ${JSON.stringify(root.path)}. A skill is tenant-supplied content; the platform materialises it only where the engine said it reads it from.`,
      );
    }
    if (!granted.has(placement.skill)) {
      return refuse(
        'unknown_skill',
        `the adapter placed a file for skill ${JSON.stringify(placement.skill)}, which this request does not grant. Granted: ${granted.size === 0 ? '(none)' : [...granted].join(', ')}.`,
      );
    }
    if (seen.has(normalised.path)) {
      return refuse(
        'duplicate_path',
        `two skill files would be written to ${JSON.stringify(normalised.path)}; the second would silently replace the first.`,
      );
    }
    seen.add(normalised.path);
    placed.add(placement.skill);
    paths.push(normalised.path);
  }
  for (const grant of grants) {
    if (grant.files.length > 0 && !placed.has(grant.name)) {
      return refuse(
        'skill_dropped',
        `skill ${JSON.stringify(grant.name)} was granted with ${String(grant.files.length)} file(s) and the adapter placed none of them, so the run would proceed without a skill its author assigned.`,
      );
    }
  }
  return { ok: true, files: paths.length, paths };
}

/**
 * The placement an engine that keeps skills at `<config>/skills/<name>/<file>` produces.
 *
 * Offered by the port because it is the layout of every engine researched for #299 that has skills
 * at all, and an adapter that shares it should not re-derive the string concatenation — but it is a
 * helper, not the rule: an engine with a different layout writes its own `placeSkills` and is held
 * to {@link skillPlacementVerdict} exactly the same way.
 */
export function skillsUnderConfigDirectory(
  grants: readonly EngineSkillGrant[],
  protectedConfigDirectory: string,
): readonly EngineSkillFile[] {
  return grants.flatMap((grant) =>
    grant.files.map((file) => ({
      skill: grant.name,
      path: `${protectedConfigDirectory}/skills/${grant.name}/${file.path}`,
      contentBase64: file.contentBase64,
    })),
  );
}
