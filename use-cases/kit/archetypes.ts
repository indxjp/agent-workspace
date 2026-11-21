/**
 * The seven archetypes (SSOT §3.3) with their handwritten budgets (SSOT §4), and the files the
 * generator writes for one: its template, `templates/<code>/`, with `__slug__` in every path and
 * text replaced by the slug. The generator (`./generate.ts`) writes exactly these, and the budget
 * (`./budget.ts`) recomputes them to tell an unedited generated file from a handwritten one, so an
 * entry's own `aw-generated.json` is never trusted for that.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { GENERATED_MANIFEST_FILE } from '@indx-workspace/sdk/project';

import { filesOf } from '../../tests/apps/handwritten.ts';

export const ARCHETYPE_BUDGETS = {
  QA: 40,
  RV: 80,
  TR: 80,
  RP: 80,
  DR: 80,
  AC: 80,
  AN: 150,
} as const;
export type Archetype = keyof typeof ARCHETYPE_BUDGETS;
export const ARCHETYPES = Object.keys(ARCHETYPE_BUDGETS) as readonly Archetype[];

const PLACEHOLDER = /__slug__/gu;

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * What the generator writes for `slug` from `templates/<archetype>/`: each file's path in the use
 * case and its text. Empty when the archetype has no template yet.
 */
export async function templateFiles(
  useCasesDir: string,
  archetype: Archetype,
  slug: string,
): Promise<Map<string, string>> {
  const template = path.join(useCasesDir, 'templates', archetype.toLowerCase());
  const written = new Map<string, string>();
  if (!existsSync(template)) return written;
  for (const source of await filesOf(template)) {
    if (source === GENERATED_MANIFEST_FILE) continue;
    const text = await readFile(path.join(template, source), 'utf8');
    written.set(source.replace(PLACEHOLDER, slug), text.replace(PLACEHOLDER, slug));
  }
  return written;
}
