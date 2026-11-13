'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { browserClient } from '../../lib/browser-client';
import {
  createFolder,
  deleteFile,
  ensureFolder,
  FilesClientError,
  renameFile,
  uploadFile,
} from './resources-model';
import { filesStrings, type FilesLocale, type FilesStrings, type Said } from './files-messages';
import { FilesStatus } from './said-line';
import { FileSearch, useFileSearch } from './files-search';
import { filesSearchStrings, type FilesSearchLocale } from './files-search-messages';
import { fileName, joinPath, sortedRows, type FileRow } from './file-browser-model';
import { Breadcrumbs, FileTable, type FileTableRenameState } from './file-table';
import { formString, title } from './resource-screen-state';
import { BUTTON, CARD, INPUT } from './resource-styles';
import {
  fileBatch,
  FileDropZone,
  UploadProgress,
  useNoFileDropNavigation,
  useUploads,
  type UploadItem,
} from './files-upload';
import { refusal, useEmptyFolderText, useFileBrowser } from './use-file-browser';

/** Why an action failed: a sentence this screen worded, or the server's after `lead`. */
function actionProblem(error: unknown, lead: string, words: FilesStrings): Said {
  return error instanceof FilesClientError ? [{ text: error.say(words) }] : refusal(lead, error);
}

export function FilesScreen({ locale = 'en' }: { readonly locale?: FilesSearchLocale } = {}) {
  const words = filesStrings(locale);
  const browser = useFileBrowser(words);
  const search = useFileSearch();
  const {
    renaming,
    setRenaming,
    uploads,
    fileRows,
    emptyText,
    createFolderFrom,
    upload,
    uploadFolder,
    saveRename,
    handleDelete,
  } = useFileActions(browser, words);

  return (
    <div lang={locale}>
      {title(words.title, words.description)}
      <FileSearch
        lang={locale}
        onOpenFolder={browser.navigateTo}
        search={search}
        strings={filesSearchStrings(locale)}
      />
      <FilesStatus problem={browser.state.problem} locale={locale} />
      <Breadcrumbs onNavigate={browser.navigateTo} path={browser.path} words={words} />
      {browser.state.loading ? (
        <p className="mb-4 text-sm text-muted" role="status">
          {words.loading}
        </p>
      ) : null}
      <FileUploadForm
        busy={uploads.busy}
        items={uploads.items}
        upload={upload}
        uploadFolder={uploadFolder}
        onProblem={(error) => browser.state.setProblem(refusal(words.leads.upload, error))}
        words={words}
        locale={locale}
      />
      <NewFolderForm
        createFolderFrom={createFolderFrom}
        onProblem={(error) => browser.state.setProblem(refusal(words.leads.createFolder, error))}
        words={words}
      />
      {search.active || browser.state.value === null ? null : (
        <FileDropZone
          className={CARD}
          disabled={uploads.busy}
          words={words}
          onDrop={(batch) =>
            void uploads
              .start(batch)
              .catch((error: unknown) =>
                browser.state.setProblem(refusal(words.leads.upload, error)),
              )
          }
        >
          <FileTable
            onDelete={(row) => void handleDelete(row)}
            onNavigate={browser.navigateTo}
            onRenameCancel={() => setRenaming(null)}
            onRenameChange={(value) =>
              setRenaming((previous) => (previous === null ? previous : { ...previous, value }))
            }
            onRenameSave={(row) => void saveRename(row)}
            onRenameStart={(row) => setRenaming({ id: row.id, value: row.path })}
            folderPath={browser.path}
            renaming={renaming}
            rows={fileRows}
            emptyText={emptyText}
            locale={locale}
            words={words}
          />
        </FileDropZone>
      )}
    </div>
  );
}

/** One selected row, as {@link FilePicker} reports it — `id` is the stable catalog id `GET
 * /api/files` resolves every entry to (`apps/web/app/api/files/route.ts` syncs it from
 * `ResourceCatalogRepository.putFile` before responding), the same id an agent/project
 * resource-assignment form already keys its own selections by. */
export interface FilePickerSelection {
  readonly id: string;
  readonly path: string;
  readonly kind: 'file' | 'folder';
}

/**
 * The reusable picker mode issue #132's card publishes for `#133` to adopt in W9.5 — not adopted
 * by any form in this task (declared gap G-3). Browsing is identical to {@link FilesScreen}; the
 * only difference is that a row is checked rather than acted on, and the current full selection is
 * reported to the caller on every change.
 */
export function FilePicker({
  onChange,
  locale = 'en',
}: {
  readonly onChange: (selection: readonly FilePickerSelection[]) => void;
  /** The reader's language; English when not given. */
  readonly locale?: FilesLocale;
}) {
  const words = filesStrings(locale);
  const browser = useFileBrowser(words);
  const [selected, setSelected] = useState<readonly FilePickerSelection[]>([]);
  const fileRows = sortedRows(browser.state.value === null ? [] : browser.state.value.files);

  const toggle = (row: FileRow) => {
    const next = selected.some((entry) => entry.id === row.id)
      ? selected.filter((entry) => entry.id !== row.id)
      : [...selected, { id: row.id, path: row.path, kind: row.kind }];
    setSelected(next);
    onChange(next);
  };

  return (
    <div lang={locale}>
      <FilesStatus problem={browser.state.problem} locale={locale} />
      <Breadcrumbs onNavigate={browser.navigateTo} path={browser.path} words={words} />
      {browser.state.loading ? (
        <p className="mb-4 text-sm text-muted" role="status">
          {words.loading}
        </p>
      ) : null}
      {browser.state.value === null ? null : (
        <div className={CARD}>
          <FileTable
            onNavigate={browser.navigateTo}
            rows={fileRows}
            selection={{ selected: new Set(selected.map((entry) => entry.id)), onToggle: toggle }}
            locale={locale}
            words={words}
          />
        </div>
      )}
    </div>
  );
}

function useFileActions(browser: ReturnType<typeof useFileBrowser>, words: FilesStrings) {
  const [renaming, setRenaming] = useState<FileTableRenameState | null>(null);
  const fileRows = sortedRows(browser.state.value === null ? [] : browser.state.value.files);
  const emptyText = useEmptyFolderText(
    browser.path,
    browser.state.value !== null && browser.state.value.files.length === 0,
    words,
  );

  const { uploads, upload, uploadFolder } = useFileUpload(browser, words);
  const createFolderFrom = (event: FormEvent<HTMLFormElement>) =>
    createFolderFromForm(browser, event, words);

  /**
   * Reload the listing, then show why the action failed. In this order because `reload` clears the
   * status line first: the other way round, the message vanished as soon as it was shown (#2088).
   * A reload that fails too is not thrown on: the action's reason comes first, and the sentence
   * after it says the listing kept its last rows, which may no longer be true.
   */
  const reloadThenShow = async (error: unknown, lead: string) => {
    const refreshed = await browser.state.reload().then(
      () => true,
      () => false,
    );
    const problem = actionProblem(error, lead, words);
    browser.state.setProblem(refreshed ? problem : [...problem, { text: words.staleList }]);
  };

  const saveRename = async (row: FileRow) => {
    if (renaming === null) return;
    const newPath = renaming.value.trim();
    if (newPath === '' || newPath === row.path) {
      setRenaming(null);
      return;
    }
    try {
      await renameFile(browserClient(), row.path, newPath);
      setRenaming(null);
      await browser.state.reload();
    } catch (error) {
      await reloadThenShow(error, words.leads.rename);
    }
  };

  const handleDelete = async (row: FileRow) => {
    const name = fileName(row.path);
    const impact =
      row.kind === 'folder' ? words.confirmDeleteFolder(name) : words.confirmDeleteFile(name);
    if (!window.confirm(impact)) return;
    try {
      await deleteFile(browserClient(), row.path, () =>
        window.confirm(words.confirmNotEmpty(name)),
      );
      await browser.state.reload();
    } catch (error) {
      // Never remove the row optimistically: reload and let the server's own listing say what is
      // actually still there, which is what keeps a `partial` result from looking like success.
      await reloadThenShow(error, words.leads.delete);
    }
  };

  return {
    renaming,
    setRenaming,
    uploads,
    fileRows,
    emptyText,
    createFolderFrom,
    upload,
    uploadFolder,
    saveRename,
    handleDelete,
  };
}

type SubmitFileForm = (event: FormEvent<HTMLFormElement>) => Promise<void>;
function FileUploadForm({
  busy,
  items,
  upload,
  uploadFolder,
  onProblem,
  words,
  locale,
}: {
  readonly busy: boolean;
  readonly items: readonly UploadItem[];
  readonly upload: SubmitFileForm;
  readonly uploadFolder: SubmitFileForm;
  readonly onProblem: (error: unknown) => void;
  readonly words: FilesStrings;
  readonly locale: FilesLocale;
}) {
  return (
    <div className={`${CARD} mb-5 flex flex-wrap items-center gap-3`}>
      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(event) => void upload(event).catch(onProblem)}
      >
        <label className="flex flex-col gap-1 text-sm">
          {words.uploadLabel}
          <input className={INPUT} multiple name="file" required type="file" />
        </label>
        <button className={BUTTON} disabled={busy} type="submit">
          {words.uploadButton}
        </button>
      </form>
      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(event) => void uploadFolder(event).catch(onProblem)}
      >
        <label className="flex flex-col gap-1 text-sm">
          {words.uploadFolderLabel}
          {/* `webkitdirectory` picks a folder and hands over every file in it with its path inside
              the folder (`File.webkitRelativePath`); React passes the attribute through as is. */}
          <input
            className={INPUT}
            multiple
            name="folder"
            required
            type="file"
            {...{ webkitdirectory: '' }}
          />
        </label>
        <button className={BUTTON} disabled={busy} type="submit">
          {words.uploadFolderButton}
        </button>
      </form>
      <UploadProgress items={items} words={words} locale={locale} />
      <p className="w-full text-sm text-muted">
        {words.grantHintBefore} <code>files(&apos;&lt;folder or file path&gt;&apos;)</code>{' '}
        {words.grantHintAfter}
      </p>
    </div>
  );
}
function NewFolderForm({
  createFolderFrom,
  onProblem,
  words,
}: {
  readonly createFolderFrom: SubmitFileForm;
  readonly onProblem: (error: unknown) => void;
  readonly words: FilesStrings;
}) {
  return (
    <form
      className={`${CARD} mb-5 flex flex-wrap items-center gap-3`}
      onSubmit={(event) => void createFolderFrom(event).catch(onProblem)}
    >
      <label className="flex flex-col gap-1 text-sm">
        {words.newFolderLabel}
        <input className={INPUT} name="name" placeholder={words.newFolderPlaceholder} required />
      </label>
      <button className={BUTTON} type="submit">
        {words.newFolderButton}
      </button>
    </form>
  );
}

async function createFolderFromForm(
  browser: ReturnType<typeof useFileBrowser>,
  event: FormEvent<HTMLFormElement>,
  words: FilesStrings,
) {
  event.preventDefault();
  const element = event.currentTarget;
  const name = formString(new FormData(element), 'name').trim();
  if (name === '' || name.includes('/')) {
    browser.state.setProblem([{ text: words.folderNameIsName }]);
    return;
  }
  await createFolder(browserClient(), joinPath(browser.path, name));
  element.reset();
  await browser.state.reload();
}
function useFileUpload(browser: ReturnType<typeof useFileBrowser>, words: FilesStrings) {
  useNoFileDropNavigation();
  // The files go to the folder the batch started in, but the listing refreshed at the end is the
  // one on screen then: a person may open another folder while a long batch runs, and the reload
  // captured at the start would put the first folder's rows under the second one's breadcrumbs.
  const listing = useRef(browser.state);
  useEffect(() => {
    listing.current = browser.state;
  });
  const uploads = useUploads(
    (item) => uploadFile(browserClient(), joinPath(browser.path, item.path), item.file),
    async (problem, wroteAny) => {
      const current = listing.current;
      // Reload first, then say what failed: `reload` clears the status line (#2088).
      const refreshed = wroteAny
        ? await current.reload().then(
            () => true,
            () => false,
          )
        : true;
      const stale = { text: words.staleList };
      if (problem !== null) current.setProblem(refreshed ? problem : [...problem, stale]);
      else if (!refreshed) current.setProblem([stale]);
    },
    words,
    (path) => ensureFolder(browserClient(), joinPath(browser.path, path)),
  );
  const picked = (event: FormEvent<HTMLFormElement>, name: string) => {
    event.preventDefault();
    const element = event.currentTarget;
    const files = new FormData(element)
      .getAll(name)
      .filter((entry): entry is File => entry instanceof File);
    element.reset();
    return fileBatch(files);
  };
  const upload = (event: FormEvent<HTMLFormElement>) => uploads.start(picked(event, 'file'));
  const uploadFolder = (event: FormEvent<HTMLFormElement>) =>
    uploads.start(picked(event, 'folder'));

  return { uploads, upload, uploadFolder };
}
