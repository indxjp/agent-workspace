/** Copying the sample files a template agent reads into the visitor's workspace. */
import type { AgentResourceAssignments } from '@indx-workspace/contracts/agents';

import type { StorageService } from '../../storage-and-sharing';
import type { Catalog, CatalogFile } from './catalog-rows';
import { DEMO_SAMPLE_FILE_MAX_BYTES } from './limits';
import { isReservedPath } from './template-layout';
import type { TemplateSource, Visitor } from './template-copy-types';

export interface FileCopyDependencies {
  /** The file catalog of a workspace: rows of files and folders, for reading and for paths. */
  readonly catalogs: (workspaceId: string) => Promise<Pick<Catalog, 'list' | 'get'>>;
  /** The files service: bytes are opened in the template and saved in the demo workspace. */
  readonly storage: Pick<StorageService, 'open' | 'save' | 'createFolder'>;
}

type FileOwner = Visitor;

/**
 * What a copy does with a sample file an earlier copy left at its path: a visitor's demo keeps it
 * (its runs may have changed it, and it is theirs), the verification workspace resets it to the
 * template's bytes so a real-model run starts from what the deployment seeded.
 */
export type SampleFileMode = 'keep' | 'reset';

/** The files a row stands for: itself, or for a folder the files under it. */
function filesUnder(row: CatalogFile, template: TemplateSource): readonly CatalogFile[] {
  if (row.kind !== 'folder') return [row];
  return template.rows.filter(
    (candidate) => candidate.kind === 'file' && candidate.path.startsWith(`${row.path}/`),
  );
}

async function createFolderCopy(
  deps: FileCopyDependencies,
  owner: FileOwner,
  path: string,
): Promise<void> {
  const made = await deps.storage.createFolder(owner, path);
  if (!made.ok && made.code !== 'name_conflict') {
    throw new Error(`demo template folder ${path} was not copied: ${made.code}`);
  }
}

async function copyFile(
  deps: FileCopyDependencies,
  file: CatalogFile,
  template: TemplateSource,
  owner: FileOwner,
  mode: SampleFileMode,
): Promise<void> {
  const opened = await deps.storage.open({ workspaceId: template.workspaceId }, file);
  if (opened === null) return;
  const saved = await deps.storage.save(owner, {
    area: 'files',
    path: file.path,
    body: opened.body,
    maxBytes: DEMO_SAMPLE_FILE_MAX_BYTES,
    contentType: file.contentType,
    replace: mode === 'reset',
  });
  // A file already at its path is a copy made before; any other refusal is a defect.
  if (!saved.ok && saved.code !== 'path_taken') {
    throw new Error(`demo template file ${file.path} was not copied: ${saved.code}`);
  }
}

/** Copy one template row (a file, or a folder with the files under it) into the visitor's workspace. */
async function copyRow(
  deps: FileCopyDependencies,
  row: CatalogFile,
  template: TemplateSource,
  visitor: Visitor,
  mode: SampleFileMode,
): Promise<void> {
  const owner = {
    workspaceId: visitor.workspaceId,
    principalId: visitor.principalId,
    userId: visitor.userId,
  };
  if (row.kind === 'folder') await createFolderCopy(deps, owner, row.path);
  for (const file of filesUnder(row, template)) {
    await copyFile(deps, file, template, owner, mode);
  }
}

/**
 * The visitor's file assignments for the template agent's: the same paths, the visitor's rows. A
 * file the template holds and the visitor's workspace does not is copied; one it holds is kept or
 * reset by `mode`.
 */
export async function copyFiles(
  deps: FileCopyDependencies,
  assigned: AgentResourceAssignments['files'],
  template: TemplateSource,
  visitor: Visitor,
  mode: SampleFileMode,
): Promise<AgentResourceAssignments['files']> {
  const copied: { fileId: string; access: 'read' | 'read-write' }[] = [];
  const visitorCatalog = await deps.catalogs(visitor.workspaceId);
  for (const grant of assigned) {
    const row = template.rows.find((candidate) => candidate.id === grant.fileId);
    // The deployment's own folder (records, digest) is never sample data a copy carries.
    if (row === undefined || isReservedPath(row.path)) continue;
    await copyRow(deps, row, template, visitor, mode);
    const made = await visitorCatalog.get(row.path);
    if (made !== null) copied.push({ fileId: made.id, access: grant.access });
  }
  return copied;
}
