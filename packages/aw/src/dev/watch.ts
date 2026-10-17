import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

import { PROJECT_FILE_NAME } from '@indx-workspace/sdk/project';

/**
 * The directories `aw dev` loads definitions and tools from, each watched recursively; below the
 * root only these and the directories of the tools' documents are watched.
 */
export const WATCHED_DIRECTORIES = ['agents', 'surfaces', 'tools', 'skills'] as const;

export interface ProjectWatchOptions {
  readonly root: string;
  readonly signal: AbortSignal;
  /** A definition or instructions file may have changed. */
  readonly onChange: () => void;
  /** `agent-workspace.yaml` changed: `aw dev` reads it again and applies it (issue #695). */
  readonly onProjectFileChange: () => void;
  /** The project directory itself can no longer be watched. */
  readonly onError: (error: Error) => void;
}

/**
 * A `.ts` definition (not a `.d.ts` declaration) or a `.md` instructions file. A `null` name — a
 * platform that does not say which file changed — counts as a change.
 */
function isDefinitionName(name: string | null): boolean {
  if (name === null) return true;
  if (name.endsWith('.d.ts')) return false;
  return name.endsWith('.ts') || name.endsWith('.md');
}

export interface ProjectWatch {
  /**
   * Watch exactly these project-relative files too — the OpenAPI documents the tools name — and
   * stop watching the ones the last call gave. Each distinct directory gets one non-recursive
   * watcher filtered by name, so a rename-based editor save is followed.
   * ponytail: a document directory created after the sync is followed from the next sync.
   */
  readonly watchFiles: (files: readonly string[]) => void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Watch a project for edits to `agents/`, `surfaces/`, `tools/` and `skills/` (issue #453, #549). Each is watched
 * recursively, so an instructions file in a folder beside its definition
 * (`instructions: { file: './prompts/en.md' }`) is followed on every platform. The root is
 * never watched recursively, because `node_modules` and the runtime's own state live under it and
 * would flood the loop. The root's watcher only notices `agents/` or `surfaces/` appearing,
 * disappearing or being replaced — a `rename` event — and attaches a fresh watcher on that
 * directory each time, so a directory created after `aw dev` started, or recreated by a rename
 * based save, is followed. A `change` event on the directory itself is ignored: Windows raises one
 * whenever a file below it is read, so the loader's own run would otherwise schedule a second sync
 * at every start. Any event naming `agent-workspace.yaml` calls `onProjectFileChange`. Every definition event also re-attaches that directory's watcher (#662): a save that
 * renames over the file silences a recursive watcher on some platforms. Everything is closed when
 * `signal` aborts.
 *
 * A tool's OpenAPI document is watched once {@link ProjectWatch.watchFiles} names it. Any other
 * file outside those directories that a definition reads — an instructions file elsewhere in the
 * project, or a module a definition imports — is not watched: its edit is synced by the next save
 * of a watched file.
 */
export function watchProject(options: ProjectWatchOptions): ProjectWatch {
  const { root, signal, onChange, onProjectFileChange, onError } = options;
  const documents = new Map<string, FSWatcher>();
  const closeDocuments = (): void => {
    for (const watcher of documents.values()) watcher.close();
    documents.clear();
  };
  const watchFiles = (files: readonly string[]): void => {
    closeDocuments();
    if (signal.aborted) return;
    const byDirectory = new Map<string, Set<string>>();
    for (const file of files) {
      const directory = path.posix.dirname(file);
      const names = byDirectory.get(directory) ?? new Set<string>();
      names.add(path.posix.basename(file));
      byDirectory.set(directory, names);
    }
    for (const [directory, names] of byDirectory) {
      let watcher: FSWatcher;
      try {
        watcher = watch(
          path.join(root, ...directory.split('/')),
          { persistent: false },
          (_e, name) => {
            if (name === null || names.has(name)) onChange();
          },
        );
      } catch {
        continue;
      }
      watcher.on('error', () => {
        watcher.close();
        if (documents.get(directory) === watcher) documents.delete(directory);
      });
      documents.set(directory, watcher);
    }
  };
  const watching: ProjectWatch = { watchFiles };
  if (signal.aborted) return watching;
  const directories = new Map<string, FSWatcher>();

  /** (Re)attach the watcher of one directory; a directory that does not exist has none. */
  const attach = (directory: string): void => {
    directories.get(directory)?.close();
    directories.delete(directory);
    let watcher: FSWatcher;
    try {
      watcher = watch(
        path.join(root, directory),
        { persistent: false, recursive: true },
        (_event, name) => {
          // A skill folder holds any file (a PDF, a script), so every event under it counts.
          if (directory !== 'skills' && !isDefinitionName(name)) return;
          // #662: a save that replaces the file (write a temporary, rename over it) leaves a
          // watcher on the old inode on some platforms; a fresh watcher on the directory follows
          // the next save, whether or not the load this one starts fails.
          attach(directory);
          onChange();
        },
      );
    } catch {
      // Absent (or not a directory): the root's watcher attaches it when it appears.
      return;
    }
    // The directory was removed or replaced: drop this watcher; the root's notices the change.
    watcher.on('error', () => {
      watcher.close();
      if (directories.get(directory) === watcher) directories.delete(directory);
      onChange();
    });
    directories.set(directory, watcher);
  };

  let rootWatcher: FSWatcher;
  try {
    rootWatcher = watch(root, { persistent: false }, (event, name) => {
      if (name === PROJECT_FILE_NAME) onProjectFileChange();
      if (event !== 'rename') return;
      for (const directory of WATCHED_DIRECTORIES) {
        if (name === null || name === directory) {
          attach(directory);
          onChange();
        }
      }
    });
  } catch (error) {
    onError(asError(error));
    return watching;
  }
  for (const directory of WATCHED_DIRECTORIES) attach(directory);

  const close = (): void => {
    rootWatcher.close();
    for (const watcher of directories.values()) watcher.close();
    directories.clear();
    closeDocuments();
  };
  rootWatcher.on('error', (error) => {
    close();
    signal.removeEventListener('abort', close);
    onError(error);
  });
  signal.addEventListener('abort', close, { once: true });
  return watching;
}
