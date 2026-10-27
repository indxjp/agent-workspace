/**
 * A definition pins a skill to a published revision by name (SDK-19, N-1). The name must resolve
 * to a skill, which `resolveFromRows` already checks; this checks the revision exists, so an
 * unknown pin is reported as a missing reference rather than surfacing later as a foreign-key
 * violation (which a write would retry and then fail with a 500).
 */
import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '../client.js';
import { skillRevisions } from '../schema/skill-revisions.js';
import { skills } from '../schema/skills.js';
import type {
  DefinitionReferences,
  ResolveDefinitionOutcome,
} from './agent-versions-resolution.js';

/** A pin the workspace has no revision for is missing, named `<skill>@<revision>`. */
export async function checkSkillRevisionPins(
  db: Database,
  workspaceId: string,
  references: DefinitionReferences,
  outcome: ResolveDefinitionOutcome,
): Promise<ResolveDefinitionOutcome> {
  const pins = Object.entries(references.skillRevisions ?? {});
  if (outcome.kind !== 'resolved' || pins.length === 0) return outcome;
  const published = await db
    .select({ name: skills.name, number: skillRevisions.number })
    .from(skillRevisions)
    .innerJoin(
      skills,
      and(
        eq(skills.id, skillRevisions.skillId),
        eq(skills.workspaceId, skillRevisions.workspaceId),
      ),
    )
    .where(
      and(
        eq(skillRevisions.workspaceId, workspaceId),
        eq(skillRevisions.pending, false),
        inArray(
          skills.name,
          pins.map(([name]) => name),
        ),
      ),
    );
  const found = new Set(published.map((row) => `${row.name}@${String(row.number)}`));
  const missing = pins
    .map(([name, revision]) => `${name}@${String(revision)}`)
    .filter((pin) => !found.has(pin))
    .map((name) => ({ kind: 'skill' as const, name }));
  return missing.length === 0 ? outcome : { kind: 'unresolved', missing, ambiguous: [] };
}
