'use client';

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';

import { SIGNED_UPLOAD_HARD_MAX_BYTES } from '@indx-workspace/contracts/files';

import {
  ENGLISH_FILES_STRINGS,
  type FilesLocale,
  type FilesStrings,
  type Said,
} from './files-messages';
import { SaidLine } from './said-line';
import { errorText, FilesClientError } from './resources-model';
import {
  MAX_FILES_PER_UPLOAD,
  pickedFiles,
  readDropped,
  type DroppedItem,
  type UploadFile,
} from './folder-upload';

/**
 * Several files sent from the Files screen one after another (UX-16 in #2086): the picker takes
 * more than one, the listing takes a drop, and each file is said to be done or not and why. A
 * picked or dropped folder is sent file by file at the same paths inside the folder on screen
 * (`folder-upload.ts`).
 */
type UploadState = 'waiting' | 'uploading' | 'done' | 'failed';

export interface UploadItem {
  readonly name: string;
  readonly state: UploadState;
  /** Why it was not uploaded, naming the file; only on `failed`. */
  readonly reason?: Said;
}

/** What a selection or drop hands over. */
export interface UploadBatch {
  /** Each file and its path relative to the folder on screen. */
  readonly files: readonly UploadFile[];
  /** Folders the browser could not read, by their path inside the drop: said, not sent. */
  readonly unreadable?: readonly string[];
  /** Empty folders of a dropped folder, created after the files. */
  readonly emptyFolders?: readonly string[];
  /** More than {@link MAX_FILES_PER_UPLOAD} files: the whole batch is refused before anything is sent. */
  readonly tooMany?: boolean;
}

/** A batch of loose files, each at its own name (or, from a folder pick, its path in the folder). */
export function fileBatch(files: readonly File[]): UploadBatch {
  if (files.length > MAX_FILES_PER_UPLOAD) return { files: [], tooMany: true };
  return { files: pickedFiles(files) };
}

const GIB = 1024 ** 3;

/** Why `file` is refused before anything is sent, or `null` to send it. */
export function refusedBeforeUpload(
  file: File,
  words: FilesStrings = ENGLISH_FILES_STRINGS,
  name: string = file.name,
): Said | null {
  // Said rather than skipped in silence (UX-19 in #2086).
  if (file.size === 0) return [{ text: words.emptyFile(name) }];
  // No deployment takes more than this, whether through the server or on a signed link.
  if (file.size > SIGNED_UPLOAD_HARD_MAX_BYTES) {
    return [{ text: words.overHardLimit(name, String(SIGNED_UPLOAD_HARD_MAX_BYTES / GIB)) }];
  }
  return null;
}

/**
 * Why a send failed, naming the file once. A sentence this screen worded is said in the reader's
 * language; the server's or the browser's is kept as sent, marked English, after a lead.
 */
function failedSend(name: string, error: unknown, words: FilesStrings): Said {
  const english = errorText(error);
  const named = english.includes(`"${name}"`);
  if (error instanceof FilesClientError) {
    const said = error.say(words);
    return named ? [{ text: said }] : [{ text: words.notUploaded(name) }, { text: said }];
  }
  return named
    ? [{ text: words.notUploadedNamed(name) }, { text: english, english: true }]
    : [{ text: words.notUploaded(name) }, { text: english, english: true }];
}

/**
 * Send each file in turn with `send`, then create the batch's empty folders with `makeFolder`,
 * telling `onChange` the whole list after every step. A failure is recorded against its file or
 * folder and the next one still goes; this never throws.
 */
export async function uploadEach(
  batch: UploadBatch,
  send: (upload: UploadFile) => Promise<void>,
  onChange: (items: readonly UploadItem[]) => void,
  words: FilesStrings = ENGLISH_FILES_STRINGS,
  makeFolder: (path: string) => Promise<void> = () => Promise.resolve(),
): Promise<readonly UploadItem[]> {
  let items: UploadItem[] = [
    ...(batch.unreadable ?? []).map((name): UploadItem => ({
      name,
      state: 'failed',
      reason: [{ text: words.folderUnreadable(name) }],
    })),
    ...batch.files.map((upload): UploadItem => ({ name: upload.path, state: 'waiting' })),
  ];
  const offset = items.length - batch.files.length;
  const set = (index: number, item: UploadItem) => {
    items = items.map((previous, at) => (at === offset + index ? item : previous));
    onChange(items);
  };
  onChange(items);
  for (const [index, upload] of batch.files.entries()) {
    const name = upload.path;
    const refused = refusedBeforeUpload(upload.file, words, name);
    if (refused !== null) {
      set(index, { name, state: 'failed', reason: refused });
      continue;
    }
    set(index, { name, state: 'uploading' });
    try {
      await send(upload);
      set(index, { name, state: 'done' });
    } catch (error) {
      set(index, { name, state: 'failed', reason: failedSend(name, error, words) });
    }
  }
  // An empty folder is said only when it could not be made: the files above are what was asked
  // for, and a folder the server already has is the same result.
  for (const folder of batch.emptyFolders ?? []) {
    try {
      await makeFolder(folder);
    } catch (error) {
      items = [
        ...items,
        {
          name: `${folder}/`,
          state: 'failed',
          reason: [
            { text: words.folderNotCreated(folder) },
            { text: errorText(error), english: true },
          ],
        },
      ];
      onChange(items);
    }
  }
  return items;
}

/** The line said for a finished batch: a lone failure's own reason, else how many failed. */
export function uploadProblem(
  items: readonly UploadItem[],
  words: FilesStrings = ENGLISH_FILES_STRINGS,
): Said | null {
  const failed = items.filter((item) => item.state === 'failed');
  if (failed.length === 0) return null;
  if (items.length === 1) return failed[0]?.reason ?? null;
  return [{ text: words.someNotUploaded(String(failed.length), String(items.length)) }];
}

/** The status line while a batch runs or after it. */
export function uploadStatus(
  items: readonly UploadItem[],
  words: FilesStrings = ENGLISH_FILES_STRINGS,
): string | null {
  const current = items.findIndex((item) => item.state === 'uploading');
  if (current !== -1) {
    const name = items[current]?.name ?? '';
    return items.length === 1
      ? words.uploadingOne(name)
      : words.uploadingOf(String(current + 1), String(items.length), name);
  }
  if (items.length < 2 || items.some((item) => item.state === 'waiting')) return null;
  const done = items.filter((item) => item.state === 'done').length;
  return words.finished(String(done), String(items.length));
}

/**
 * The upload state of one screen. `finish` runs once a batch ends, with the line to show (or
 * `null`) and whether anything was written, so the screen can reload before it shows the line.
 * A drop hands over a promise: its folders are still being read, and the screen is busy meanwhile.
 */
export function useUploads(
  send: (upload: UploadFile) => Promise<void>,
  finish: (problem: Said | null, wroteAny: boolean) => Promise<void>,
  words: FilesStrings = ENGLISH_FILES_STRINGS,
  makeFolder?: (path: string) => Promise<void>,
) {
  const [items, setItems] = useState<readonly UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  // The state above only changes on the next render, so two drops in a row would both start;
  // the ref is read and set synchronously.
  const running = useRef(false);
  const start = async (pending: UploadBatch | Promise<UploadBatch>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const batch = await pending;
      if (batch.tooMany === true) {
        setItems([]);
        await finish([{ text: words.tooManyFiles(String(MAX_FILES_PER_UPLOAD)) }], false);
        return;
      }
      const count =
        batch.files.length + (batch.unreadable?.length ?? 0) + (batch.emptyFolders?.length ?? 0);
      if (count === 0) return;
      const result = await uploadEach(batch, send, setItems, words, makeFolder);
      await finish(
        uploadProblem(result, words),
        result.some((item) => item.state === 'done') || (batch.emptyFolders?.length ?? 0) > 0,
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { items, busy, start };
}

/** The status line, and for more than one file each file's state and reason. */
export function UploadProgress({
  items,
  words = ENGLISH_FILES_STRINGS,
  locale = 'en',
}: {
  readonly items: readonly UploadItem[];
  readonly words?: FilesStrings;
  readonly locale?: FilesLocale;
}) {
  const status = uploadStatus(items, words);
  return (
    <>
      {status === null ? null : (
        <p className="w-full text-sm text-muted" role="status">
          {status}
        </p>
      )}
      {items.length < 2 ? null : (
        <ul aria-label={words.uploadResults} className="w-full text-sm">
          {items.map((item, index) => (
            <li
              className={`break-words ${item.state === 'failed' ? 'text-danger' : 'text-muted'}`}
              key={`${String(index)}:${item.name}`}
            >
              <span className="text-text">{item.name}</span>: {words.state[item.state]}
              {item.reason === undefined ? null : (
                <>
                  {' — '}
                  <SaidLine said={item.reason} locale={locale} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The files and folders of a drop. The entries are taken while the drop event runs (a
 * `DataTransfer`'s items stop answering after it), and the folders are read after.
 */
export function droppedBatch(transfer: DataTransfer): Promise<UploadBatch> {
  const items = Array.from(transfer.items);
  if (items.length === 0) return Promise.resolve(fileBatch(Array.from(transfer.files)));
  const dropped: DroppedItem[] = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    dropped.push({ entry, file: entry?.isDirectory === true ? null : item.getAsFile() });
  }
  return readDropped(dropped).then((read) =>
    read.tooMany
      ? { files: [], tooMany: true }
      : { files: read.files, unreadable: read.unreadable, emptyFolders: read.emptyFolders },
  );
}

function carriesFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

/**
 * Takes files dropped anywhere on its children and says so while they are dragged over it. The
 * upload button above stays the way in from a keyboard.
 */
export function FileDropZone({
  children,
  className,
  disabled,
  onDrop,
  words = ENGLISH_FILES_STRINGS,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly disabled: boolean;
  readonly onDrop: (batch: Promise<UploadBatch>) => void;
  readonly words?: FilesStrings;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`${className} ${over ? 'outline-2 outline-dashed outline-accent' : ''}`}
      data-drop-over={over ? 'true' : undefined}
      onDragLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        setOver(false);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
        setOver(true);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setOver(false);
        if (!disabled) onDrop(droppedBatch(event.dataTransfer));
      }}
    >
      {over ? (
        <p className="mb-3 text-sm font-medium text-text">
          {disabled ? words.dropWait : words.dropHere}
        </p>
      ) : null}
      {children}
    </div>
  );
}

/**
 * While the Files screen is open, a file dropped outside the drop zone does nothing. Without this
 * the browser opens the dropped file in place of the console, and an upload the person was
 * waiting on is lost with the page.
 */
export function useNoFileDropNavigation(): void {
  useEffect(() => {
    const swallow = (event: globalThis.DragEvent) => {
      // A file input takes a drop as its own default action: leave that one alone.
      if (event.target instanceof HTMLInputElement && event.target.type === 'file') return;
      if (event.dataTransfer?.types.includes('Files') === true) event.preventDefault();
    };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);
}
