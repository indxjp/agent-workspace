/**
 * Reading a folder the person picked or dropped into the files of one upload (the Upload item of
 * #2086). Each file keeps its path inside the folder, so `photos/2026/a.jpg` lands at
 * `<current folder>/photos/2026/a.jpg`; the server adds the parent folders a nested path names, and
 * an empty subfolder of a dropped folder is created on its own.
 *
 * Nothing here decides whether a path is safe: the server refuses `..`, absolute paths,
 * backslashes, control characters and empty segments for every write (`toObjectKey`), whatever a
 * browser reports as a name.
 */

/** One file of an upload, and where it goes relative to the folder on screen. */
export interface UploadFile {
  readonly file: File;
  /** `a.txt` for a lone file; `photos/2026/a.jpg` for a file inside a picked or dropped folder. */
  readonly path: string;
}

/**
 * The most files one upload sends. Uploads go one after another and cannot be stopped part way, so
 * a folder dropped by mistake (a project's `node_modules`, a photo library) would hold the screen
 * for a long time. Reading stops once the folder holds more than this.
 */
export const MAX_FILES_PER_UPLOAD = 1000;

/** What reading a picked or dropped folder found. */
export interface FolderRead {
  readonly files: readonly UploadFile[];
  /** Folders that hold nothing, by their path inside the drop (`photos/empty`). */
  readonly emptyFolders: readonly string[];
  /** Folders the browser could not read, by their path inside the drop. */
  readonly unreadable: readonly string[];
  /** More than {@link MAX_FILES_PER_UPLOAD} files: nothing is sent. */
  readonly tooMany: boolean;
}

/** The part of the File and Directory Entries API this reads; plain objects stand in for it in tests. */
interface EntryLike {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
}
interface FileEntryLike extends EntryLike {
  file(success: (file: File) => void, failure?: (error: unknown) => void): void;
}
interface DirectoryReaderLike {
  readEntries(success: (entries: EntryLike[]) => void, failure?: (error: unknown) => void): void;
}
interface DirectoryEntryLike extends EntryLike {
  createReader(): DirectoryReaderLike;
}

/** One thing in a drop: a folder or file entry when the browser gives one, else the file itself. */
export interface DroppedItem {
  readonly entry: EntryLike | null;
  readonly file: File | null;
}

const fileOf = (entry: FileEntryLike) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/** Every child of a folder. A reader answers in batches (100 at a time in Chrome) until empty. */
async function childrenOf(entry: DirectoryEntryLike): Promise<EntryLike[]> {
  const reader = entry.createReader();
  const children: EntryLike[] = [];
  for (;;) {
    const batch = await new Promise<EntryLike[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return children;
    children.push(...batch);
  }
}

/** The files a picked folder hands over, each at its path inside that folder. */
export function pickedFiles(files: readonly File[]): UploadFile[] {
  return files.map((file) => {
    // Set for a file of a `webkitdirectory` pick ("photos/2026/a.jpg"), empty otherwise (and
    // missing in a browser or test DOM without the API).
    const relative: unknown = file.webkitRelativePath;
    return { file, path: typeof relative === 'string' && relative !== '' ? relative : file.name };
  });
}

/**
 * Read the folders and files of a drop. Entries are read after the drop event has returned, which
 * the API allows: only `DataTransfer.items` stop working then, so the caller takes the entries
 * from them during the event.
 */
export async function readDropped(
  dropped: readonly DroppedItem[],
  limit: number = MAX_FILES_PER_UPLOAD,
): Promise<FolderRead> {
  const files: UploadFile[] = [];
  const emptyFolders: string[] = [];
  const unreadable: string[] = [];
  let tooMany = false;
  const add = (file: File, path: string) => {
    if (files.length >= limit) tooMany = true;
    else files.push({ file, path });
  };
  const walk = async (entry: EntryLike, parent: string): Promise<void> => {
    if (tooMany) return;
    const path = parent === '' ? entry.name : `${parent}/${entry.name}`;
    if (entry.isDirectory) {
      let children: EntryLike[];
      try {
        children = await childrenOf(entry as DirectoryEntryLike);
      } catch {
        unreadable.push(path);
        return;
      }
      if (children.length === 0) emptyFolders.push(path);
      for (const child of children) await walk(child, path);
      return;
    }
    if (!entry.isFile) return;
    try {
      add(await fileOf(entry as FileEntryLike), path);
    } catch {
      unreadable.push(path);
    }
  };
  for (const item of dropped) {
    if (tooMany) break;
    if (item.entry?.isDirectory === true) await walk(item.entry, '');
    else if (item.file !== null) add(item.file, item.file.name);
    else if (item.entry !== null) await walk(item.entry, '');
  }
  const byPath = (a: { path: string } | string, b: { path: string } | string) => {
    const left = typeof a === 'string' ? a : a.path;
    const right = typeof b === 'string' ? b : b.path;
    return left < right ? -1 : left > right ? 1 : 0;
  };
  return {
    files: tooMany ? [] : files.sort(byPath),
    emptyFolders: tooMany ? [] : emptyFolders.sort(byPath),
    unreadable: tooMany ? [] : unreadable.sort(byPath),
    tooMany,
  };
}
