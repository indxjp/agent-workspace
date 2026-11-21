/**
 * The refusals of a demo template seed: the error a refused seed carries, and the checks that find a
 * seed that does not hold together before anything is written (see `seed.ts`).
 */
import { isBuiltinSkillName } from '@indx-workspace/contracts/skills';
import type { DemoTemplateSeed } from '@indx-workspace/contracts/demo-operator';

import { RecordsTooLargeError, recordsServerCommand } from './records-server';
import { isReservedPath, recordSetPath } from './template-layout';

/** Why a seed is refused: the seed is wrong (`demo_seed_invalid`), or the slug is not the deployment's. */
export class DemoSeedRefusal extends Error {
  constructor(
    readonly code: 'demo_seed_invalid' | 'demo_template_not_deployment_owned',
    message: string,
  ) {
    super(message);
  }
}

export const invalid = (message: string): DemoSeedRefusal =>
  new DemoSeedRefusal('demo_seed_invalid', message);

/** The refusals of a seed that does not hold together, found before anything is written. */
export function checkSeed(seed: DemoTemplateSeed): void {
  checkSkills(seed);
  const declared = checkConnectors(seed);
  checkFiles(seed);
  checkRecordSets(seed, declared);
  checkRecordsFit(seed);
}

type DeclaredConnectors = ReadonlyMap<string, DemoTemplateSeed['connectors'][number]>;

/** Connectors are declared once each, and the definition names only declared ones. */
function checkConnectors(seed: DemoTemplateSeed): DeclaredConnectors {
  const declared = new Map(seed.connectors.map((connector) => [connector.name, connector]));
  if (declared.size !== seed.connectors.length) throw invalid('a connector is declared twice');
  for (const name of seed.definition.resources.connectors) {
    if (!declared.has(name))
      throw invalid(`the definition names the connector ${name}, which the seed does not declare`);
  }
  return declared;
}

/** Sample files are listed once each and stay out of the reserved folder. */
function checkFiles(seed: DemoTemplateSeed): void {
  const paths = seed.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) throw invalid('a sample file is listed twice');
  for (const path of paths) {
    if (isReservedPath(path)) throw invalid(`the sample file ${path} is in the reserved folder`);
  }
}

/** Every record set names a declared connector and its read tools, and is listed once. */
function checkRecordSets(seed: DemoTemplateSeed, declared: DeclaredConnectors): void {
  const sets = new Set<string>();
  for (const set of seed.records) {
    const connector = declared.get(set.connector);
    if (connector === undefined)
      throw invalid(
        `a record set names the connector ${set.connector}, which the seed does not declare`,
      );
    const unread = set.tools.find((tool) => !connector.reads.includes(tool));
    if (unread !== undefined)
      throw invalid(
        `a record set of ${set.connector} names ${unread}, which is not one of its read tools`,
      );
    const key = recordSetPath(set);
    if (sets.has(key)) throw invalid(`the record set ${key} is listed twice`);
    sets.add(key);
  }
}

/** A connector's records ride in one stand-in's arguments, so they must fit it. */
function checkRecordsFit(seed: DemoTemplateSeed): void {
  for (const connector of seed.connectors) {
    try {
      recordsServerCommand({
        reads: connector.reads,
        writes: connector.writes,
        sets: seed.records.filter((set) => set.connector === connector.name),
        ...(connector.recorded === undefined ? {} : { recorded: connector.recorded }),
      });
    } catch (error) {
      if (error instanceof RecordsTooLargeError) {
        throw invalid(
          `the records of the connector ${connector.name} are too large for one stand-in`,
        );
      }
      throw error;
    }
  }
}

/**
 * The skills of a seed hold together: the definition names each skill once, the seed carries every
 * one it names that is not a built-in and none it does not name, and no revision is pinned.
 */
function checkSkills(seed: DemoTemplateSeed): void {
  const named = seed.definition.resources.skills;
  if (new Set(named).size !== named.length) throw invalid('the definition names a skill twice');
  if (Object.keys(seed.definition.resources.skillRevisions ?? {}).length > 0) {
    throw invalid('the definition pins a skill revision, which a template does not keep');
  }
  const carried = seed.skills.map((skill) => skill.name);
  if (new Set(carried).size !== carried.length) throw invalid('a skill is carried twice');
  for (const name of named) {
    if (!isBuiltinSkillName(name) && !carried.includes(name))
      throw invalid(`the definition names the skill ${name}, which the seed does not carry`);
  }
  for (const name of carried) {
    if (!named.includes(name))
      throw invalid(`the seed carries the skill ${name}, which the definition does not name`);
  }
}
