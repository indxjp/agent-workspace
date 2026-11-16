/**
 * Reading and writing the project's `aw-generated.json` for `aw generate` and `aw destroy`. An
 * absent file is the empty manifest; a file that is there but not exactly a manifest is refused,
 * never treated as empty, so a destroy cannot forget what it may delete.
 */
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  EMPTY_GENERATED_MANIFEST,
  GENERATED_MANIFEST_FILE,
  parseGeneratedManifest,
  ProjectRenderError,
  serializeGeneratedManifest,
  type GeneratedEntryKind,
  type GeneratedManifest,
} from '@indx-workspace/sdk/project';

import { CommandRefusedError } from '../io.js';
import { readTextIfPresent } from './write.js';

export async function readManifest(cwd: string): Promise<GeneratedManifest> {
  const text = await readTextIfPresent(cwd, GENERATED_MANIFEST_FILE);
  if (text === undefined) return EMPTY_GENERATED_MANIFEST;
  try {
    return parseGeneratedManifest(text);
  } catch (error) {
    if (error instanceof ProjectRenderError) {
      throw new CommandRefusedError(
        error.message,
        `restore ${GENERATED_MANIFEST_FILE} from version control`,
      );
    }
    throw error;
  }
}

/** Writes the manifest; one with no entries left is removed, as before anything was generated. */
export async function writeManifest(cwd: string, manifest: GeneratedManifest): Promise<void> {
  const target = path.join(cwd, GENERATED_MANIFEST_FILE);
  if (Object.keys(manifest.entries).length === 0) {
    await rm(target, { force: true });
    return;
  }
  await writeFile(target, serializeGeneratedManifest(manifest));
}

/** The names of the manifest's entries of one kind, in key order. */
export function entryNames(manifest: GeneratedManifest, kind: GeneratedEntryKind): string[] {
  const prefix = `${kind}:`;
  return Object.keys(manifest.entries)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}
