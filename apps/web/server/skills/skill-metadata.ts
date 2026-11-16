/** Skill reads, imports, revisions and file exports over the storage ports. */

import { skillMetaKey } from './keys';
import { readWhole } from '../storage/objects';
import type { SkillObjects } from '../storage-and-sharing';

// ── The platform's own record about a skill (`skill-meta/<name>.json`) ──────────────────────

export interface SkillMetaRecord {
  readonly name: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function isSkillMetaRecord(value: unknown): value is SkillMetaRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['name'] === 'string' &&
    typeof record['enabled'] === 'boolean' &&
    typeof record['createdAt'] === 'string' &&
    typeof record['updatedAt'] === 'string'
  );
}

export async function readSkillMeta(
  store: SkillObjects,
  name: string,
): Promise<SkillMetaRecord | null> {
  const object = await readWhole(store, skillMetaKey(name));
  if (object === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8').decode(object.body));
  } catch {
    return null;
  }
  return isSkillMetaRecord(parsed) ? parsed : null;
}

export async function writeSkillMeta(store: SkillObjects, record: SkillMetaRecord): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(record));
  await store.write(skillMetaKey(record.name), body, { contentType: 'application/json' });
}
