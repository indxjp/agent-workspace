/** Reading a template agent's skills and making them in the visitor's workspace. */
import { isBuiltinSkillName } from '@indx-workspace/contracts/skills';

import type { WorkspaceSkills } from '../../agents';
import type { Visitor } from './template-copy-types';

/**
 * The names of the template agent's skills, in assignment order. A template agent with a skill on
 * a deployment that keeps no skills is not copied: its copy would run without it.
 */
export async function templateSkillNames(
  skills: WorkspaceSkills | null,
  templateId: string,
  skillIds: readonly string[],
): Promise<readonly string[]> {
  if (skillIds.length === 0) return [];
  if (skills === null) {
    throw new Error('the demo template agent has skills and this deployment keeps none');
  }
  const byId = new Map((await skills.list(templateId)).map((skill) => [skill.id, skill]));
  return skillIds.map((id) => {
    const skill = byId.get(id);
    if (skill === undefined) throw new Error(`the demo template has no skill ${id}`);
    return skill.name;
  });
}

type SkillOwner = { readonly principalId: string; readonly userId: string };

/** Make one non-built-in skill in the visitor's workspace from the template's files. */
async function makeSkillFromTemplate(
  skills: WorkspaceSkills,
  name: string,
  templateId: string,
  visitor: Visitor,
): Promise<string> {
  if (isBuiltinSkillName(name)) throw new Error(`the built-in skill ${name} was not installed`);
  const files = await skills.files(templateId, name);
  if (files === null) throw new Error(`the demo template's skill ${name} has no files`);
  const owner: SkillOwner = { principalId: visitor.principalId, userId: visitor.userId };
  const made = await skills.create(visitor.workspaceId, owner, { name, files });
  if (made.kind === 'refused') {
    throw new Error(`the demo skill ${name} was not copied: ${made.code}`);
  }
  return made.id;
}

/**
 * The visitor workspace's skills for the template agent's `names`, through the skills domain: a
 * built-in installed from the platform's release, any other made from the template's files under
 * the same name. Found by name when an earlier copy made it. The ids, in the order of `names`.
 */
export async function copySkills(
  skills: WorkspaceSkills | null,
  names: readonly string[],
  templateId: string,
  visitor: Visitor,
): Promise<readonly string[]> {
  if (names.length === 0 || skills === null) return [];
  const owner = { principalId: visitor.principalId, userId: visitor.userId };
  await skills.installBuiltins(visitor.workspaceId, owner, names.filter(isBuiltinSkillName));
  const ids: string[] = [];
  for (const name of names) {
    const present = (await skills.list(visitor.workspaceId)).find((skill) => skill.name === name);
    ids.push(present?.id ?? (await makeSkillFromTemplate(skills, name, templateId, visitor)));
  }
  return ids;
}
