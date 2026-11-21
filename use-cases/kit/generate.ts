/**
 * The use-case generator (SSOT §3.3): copy `templates/<archetype>/` into `<slug>/` and write
 * `aw-generated.json`, whose one `project:<archetype>` entry records every file it wrote with its
 * sha256. The entry declares the archetype; the budget (`./budget.ts`) recomputes the files from
 * the template itself and skips only those still exactly as the template makes them.
 *
 * `__slug__` in a template's file paths and text becomes the slug. `pnpm use-cases:new <QA|RV|…>
 * <slug>` runs it (`./new.ts`).
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  addGeneratedEntry,
  EMPTY_GENERATED_MANIFEST,
  GENERATED_MANIFEST_FILE,
  serializeGeneratedManifest,
} from '@indx-workspace/sdk/project';

import { ARCHETYPES, sha256, templateFiles } from './archetypes.ts';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface GenerateRequest {
  /** The `use-cases/` folder: it holds `templates/` and receives `<slug>/`. */
  readonly useCasesDir: string;
  /** An archetype code, `QA` or `qa`. */
  readonly archetype: string;
  readonly slug: string;
}

/** Write the new use case; returns the files written, relative to it, sorted. */
export async function generateUseCase(request: GenerateRequest): Promise<string[]> {
  const { useCasesDir, slug } = request;
  const archetype = ARCHETYPES.find((code) => code === request.archetype.toUpperCase());
  if (archetype === undefined) {
    throw new Error(`unknown archetype ${request.archetype}; one of ${ARCHETYPES.join(', ')}`);
  }
  if (!SLUG.test(slug)) throw new Error(`${slug} is not a kebab-case catalog slug`);
  const code = archetype.toLowerCase();
  if (!existsSync(path.join(useCasesDir, 'templates', code))) {
    throw new Error(`no template templates/${code}`);
  }
  const target = path.join(useCasesDir, slug);
  if (existsSync(target)) throw new Error(`${slug} already exists`);

  const written: Record<string, string> = {};
  for (const [file, text] of await templateFiles(useCasesDir, archetype, slug)) {
    await mkdir(path.dirname(path.join(target, file)), { recursive: true });
    await writeFile(path.join(target, file), text);
    written[file] = sha256(text);
  }
  const manifest = addGeneratedEntry(EMPTY_GENERATED_MANIFEST, `project:${code}`, {
    files: written,
    edits: [],
  });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, GENERATED_MANIFEST_FILE), serializeGeneratedManifest(manifest));
  return Object.keys(written).sort();
}
