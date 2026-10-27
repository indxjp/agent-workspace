/**
 * What a technician may search: the folders `data/access.json` names for them, as the workspace
 * paths `runs.start({ fileScope })` takes. The built-in `search_files` and the run's sandbox then
 * cover only these, so another line's trouble log and notes never reach the model.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const AccessSchema = z.record(
  z.string(),
  z.object({
    /** Production-line folders under `trouble-log/`. */
    areas: z.array(z.string()),
    /** Folders under `expert-notes/`. */
    notes: z.array(z.string()),
    /** Manuals, by file name without `.md`. */
    manuals: z.array(z.string()),
  }),
);

export type Access = z.infer<typeof AccessSchema>;

export function loadAccess(
  file = fileURLToPath(new URL('../data/access.json', import.meta.url)),
): Access {
  return AccessSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** The paths `person` may search; empty for a person the access list does not name. */
export function fileScopeFor(access: Access, person: string): string[] {
  const entry = Object.hasOwn(access, person) ? access[person] : undefined;
  if (entry === undefined) return [];
  return [
    ...entry.areas.map((area) => `trouble-log/${area}`),
    ...entry.notes.map((folder) => `expert-notes/${folder}`),
    ...entry.manuals.map((manual) => `manuals/${manual}.md`),
  ];
}
