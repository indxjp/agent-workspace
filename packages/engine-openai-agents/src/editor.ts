/**
 * The Editor: `apply_patch`'s executor, one function per kind of patch operation.
 *
 * Split out of `./executors.ts`, which re-exports it. Every path goes through `./workspace.ts` and
 * `./workspace-links.ts` before the filesystem is touched, and a refusal is an answer to the model
 * (`ERROR: …`), never an exception.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, toolError } from './tool-output.js';
import { absolute, linkRefusal } from './workspace-links.js';
import { workspaceWriteVerdict, type OpenAiAgentsWorkspace } from './workspace.js';

/** The SDK's `applyDiff`, as the Editor takes it. */
export type ApplyDiff = (input: string, diff: string, mode?: 'default' | 'create') => string;

/** One patch operation, in the shape the SDK's `ApplyPatchOperation` has. */
export type PatchOperation =
  | { readonly type: 'create_file'; readonly path: string; readonly diff: string }
  | {
      readonly type: 'update_file';
      readonly path: string;
      readonly diff: string;
      readonly moveTo?: string | null | undefined;
    }
  | { readonly type: 'delete_file'; readonly path: string };

type CreateFile = Extract<PatchOperation, { type: 'create_file' }>;
type UpdateFile = Extract<PatchOperation, { type: 'update_file' }>;

/** The Editor: `apply_patch`'s executor. Answers a sentence for the model, never throws. */
export async function applyPatch(
  workspace: OpenAiAgentsWorkspace,
  operation: PatchOperation,
  applyDiff: ApplyDiff,
): Promise<string> {
  const target = workspaceWriteVerdict(workspace, operation.path);
  if (!target.ok) {
    return toolError(`refused to write ${JSON.stringify(operation.path)}: ${target.reason}`);
  }
  try {
    const linked = await linkRefusal(workspace, 'write', operation.path, target.relative);
    if (linked !== null) return linked;
    switch (operation.type) {
      case 'delete_file':
        return await deleteFile(workspace, target.relative);
      case 'create_file':
        return await createFile(workspace, operation, target.relative, applyDiff);
      case 'update_file':
        return await updateFile(workspace, operation, target.relative, applyDiff);
    }
  } catch (cause) {
    return toolError(`${operation.type} ${target.relative} failed: ${describe(cause)}`);
  }
}

async function deleteFile(workspace: OpenAiAgentsWorkspace, relative: string): Promise<string> {
  await rm(absolute(workspace, relative));
  return `deleted ${relative}`;
}

async function createFile(
  workspace: OpenAiAgentsWorkspace,
  operation: CreateFile,
  relative: string,
  applyDiff: ApplyDiff,
): Promise<string> {
  const file = absolute(workspace, relative);
  const content = applyDiff('', operation.diff, 'create');
  await mkdir(path.posix.dirname(file), { recursive: true });
  await writeFile(file, content, { flag: 'wx' });
  return `created ${relative}`;
}

/** Where an update moves the file to, or the refusal sentence that ends the operation. */
type MoveDestination = { readonly absolute: string } | { readonly refusal: string };

async function resolveMoveDestination(
  workspace: OpenAiAgentsWorkspace,
  moveTo: string,
): Promise<MoveDestination> {
  const moved = workspaceWriteVerdict(workspace, moveTo);
  if (!moved.ok) {
    return { refusal: toolError(`refused to move to ${JSON.stringify(moveTo)}: ${moved.reason}`) };
  }
  const link = await linkRefusal(workspace, 'move to', moveTo, moved.relative);
  return link === null ? { absolute: absolute(workspace, moved.relative) } : { refusal: link };
}

async function updateFile(
  workspace: OpenAiAgentsWorkspace,
  operation: UpdateFile,
  relative: string,
  applyDiff: ApplyDiff,
): Promise<string> {
  const file = absolute(workspace, relative);
  const moveTo = operation.moveTo ?? null;
  const destination = moveTo === null ? null : await resolveMoveDestination(workspace, moveTo);
  if (destination !== null && 'refusal' in destination) return destination.refusal;
  const updated = applyDiff(await readFile(file, 'utf8'), operation.diff);
  await writeFile(file, updated);
  if (destination === null) return `updated ${relative}`;
  await mkdir(path.posix.dirname(destination.absolute), { recursive: true });
  await rename(file, destination.absolute);
  return `updated ${relative} and moved it to ${moveTo ?? ''}`;
}
