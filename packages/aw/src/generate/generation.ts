/**
 * What every `aw generate` command shares (issues #1505, #1507, #1514): one run's files, in-place
 * edits and recorded edits, the refusals each makes before writing anything, and the write that
 * records it all in `aw-generated.json`.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  addGeneratedEntry,
  GENERATED_MANIFEST_FILE,
  generatedEntryKey,
  ProjectRenderError,
  type GeneratedEdit,
  type GeneratedEntryKind,
  type GeneratedManifest,
  type ProjectFile,
} from '@indx-workspace/sdk/project';

import type { LocalCommandContext } from '../command.js';
import { CommandRefusedError, UsageError } from '../io.js';
import { APP_CONFIG_FILE } from './edits.js';
import { entryNames, writeManifest } from './manifest.js';
import { conflicts, occupied, sha256Of, writeNewFiles } from './write.js';

/** A file `aw generate` changes in place, and the text it writes there. */
export interface InPlaceEdit {
  readonly path: string;
  readonly text: string;
}

/** What one generator run writes and records. */
export interface Generation {
  readonly kind: GeneratedEntryKind;
  readonly name: string;
  readonly files: readonly ProjectFile[];
  readonly inPlace: readonly InPlaceEdit[];
  readonly edits: readonly GeneratedEdit[];
}

export function cwdOf(context: LocalCommandContext, what: string): string {
  if (context.cwd === undefined) {
    throw new CommandRefusedError(`${what} needs a current directory to write the project into`);
  }
  return context.cwd;
}

/** The SDK's refusal of a name or field argument, as a usage error that lists every reason. */
export function rendered<T>(render: () => T): T {
  try {
    return render();
  } catch (error) {
    if (error instanceof ProjectRenderError) throw new UsageError(error.message);
    throw error;
  }
}

/** The one `<name>` positional, refused when missing, blank or followed by another word. */
export function onlyName(context: LocalCommandContext, what: string): string {
  const [name, ...extra] = context.positionals;
  if (name === undefined || name.trim() === '') throw new UsageError(`${what} needs a <name>`);
  if (extra.length > 0) throw new UsageError(`${what} takes one <name>; got ${extra.join(' ')}`);
  return name;
}

/** The app the manifest records; refused when there is none, with the command that makes one. */
export async function generatedApp(cwd: string, manifest: GeneratedManifest): Promise<string> {
  const [appName] = entryNames(manifest, 'app');
  if (appName === undefined || !(await occupied(path.join(cwd, APP_CONFIG_FILE)))) {
    throw new CommandRefusedError(
      `there is no generated app here (no ${APP_CONFIG_FILE} recorded in ${GENERATED_MANIFEST_FILE})`,
      'run aw generate app <name> first',
    );
  }
  return appName;
}

/** The resources this app has: generated ones and any `resources/<name>.ts` written by hand. */
export async function knownResource(
  cwd: string,
  manifest: GeneratedManifest,
  name: string,
): Promise<boolean> {
  return (
    entryNames(manifest, 'resource').includes(name) ||
    (await occupied(path.join(cwd, 'resources', `${name}.ts`)))
  );
}

export async function unknownResources(
  cwd: string,
  manifest: GeneratedManifest,
  names: readonly string[],
): Promise<string[]> {
  const unknown: string[] = [];
  for (const name of names) if (!(await knownResource(cwd, manifest, name))) unknown.push(name);
  return unknown;
}

/** Refuses a kind and name `aw-generated.json` already records: destroy it first. */
export function refuseRecorded(
  manifest: GeneratedManifest,
  kind: GeneratedEntryKind,
  name: string,
): void {
  if (Object.hasOwn(manifest.entries, generatedEntryKey(kind, name))) {
    throw new CommandRefusedError(
      `${kind} ${name} is already generated (${GENERATED_MANIFEST_FILE})`,
      `aw destroy ${kind} ${name}`,
    );
  }
}

/** Refuses the run when a path it writes is taken. */
export async function refuseTaken(cwd: string, generation: Generation): Promise<void> {
  const existing = await conflicts(cwd, generation.files);
  if (existing.length > 0) {
    throw new CommandRefusedError(
      `aw generate ${generation.kind} would overwrite existing files:\n${existing.map((file) => `  ${file}`).join('\n')}`,
      'move these files away, or pick another name',
    );
  }
}

/** Writes the files and the in-place edits, then records the run in `aw-generated.json`. */
export async function carryOut(
  context: LocalCommandContext,
  cwd: string,
  manifest: GeneratedManifest,
  generation: Generation,
): Promise<void> {
  const { io } = context;
  const next = addGeneratedEntry(manifest, generatedEntryKey(generation.kind, generation.name), {
    files: Object.fromEntries(generation.files.map((file) => [file.path, sha256Of(file.contents)])),
    edits: generation.edits,
  });
  await writeNewFiles(cwd, generation.files, io, `aw generate ${generation.kind}`);
  for (const edit of generation.inPlace) {
    await writeFile(path.join(cwd, edit.path), edit.text);
    io.stdout(`edited ${edit.path}\n`);
  }
  await writeManifest(cwd, next);
  io.stdout(`recorded ${generation.kind} ${generation.name} in ${GENERATED_MANIFEST_FILE}\n`);
}
