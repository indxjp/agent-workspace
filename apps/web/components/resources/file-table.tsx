'use client';

import { fileRouteId } from '@indx-workspace/contracts/files';
import {
  breadcrumbSegments,
  fileName,
  formatModified,
  formatSize,
  moveFolderChoices,
  moveInto,
  parentPath,
  type FileRow,
} from './file-browser-model';
import { BUTTON, INPUT } from './resource-styles';
import type { FilesSearchLocale } from './files-search-messages';
import { ENGLISH_FILES_STRINGS, type FilesStrings } from './files-messages';

export function Breadcrumbs({
  path,
  onNavigate,
  words = ENGLISH_FILES_STRINGS,
}: {
  readonly path: string;
  readonly onNavigate: (path: string) => void;
  readonly words?: FilesStrings;
}) {
  const crumbs = breadcrumbSegments(path);
  return (
    <nav aria-label={words.breadcrumb} className="mb-4 flex flex-wrap items-center gap-2 text-sm">
      <button
        className={path === '' ? 'font-semibold text-text' : 'text-accent underline'}
        onClick={() => onNavigate('')}
        type="button"
      >
        {words.home}
      </button>
      {crumbs.map((crumb, index) => (
        <span className="flex items-center gap-2" key={crumb.path}>
          <span aria-hidden="true">/</span>
          <button
            className={
              index === crumbs.length - 1 ? 'font-semibold text-text' : 'text-accent underline'
            }
            onClick={() => onNavigate(crumb.path)}
            type="button"
          >
            {crumb.name}
          </button>
        </span>
      ))}
      <button
        className={`${BUTTON} ml-auto`}
        disabled={path === ''}
        onClick={() => onNavigate(parentPath(path))}
        type="button"
      >
        {words.back}
      </button>
    </nav>
  );
}

const TH =
  'border-b border-border bg-surface-2 px-4 py-[9px] text-left text-[11.5px] font-semibold tracking-[.04em] whitespace-nowrap text-muted uppercase';

const TD = 'border-b border-border px-4 py-[11px] align-middle';

export interface FileTableRenameState {
  readonly id: string;
  readonly value: string;
}

interface FileTableProps {
  readonly rows: readonly FileRow[];
  readonly onNavigate: (path: string) => void;
  readonly onRenameStart?: (row: FileRow) => void;
  readonly onDelete?: (row: FileRow) => void;
  readonly renaming?: FileTableRenameState | null;
  readonly onRenameChange?: (value: string) => void;
  readonly onRenameSave?: (row: FileRow) => void;
  readonly onRenameCancel?: () => void;
  /** The open folder, whose breadcrumb and subfolders the rename row offers as destinations. */
  readonly folderPath?: string;
  readonly selection?: {
    readonly selected: ReadonlySet<string>;
    readonly onToggle: (row: FileRow) => void;
  };
  /** What an empty listing says; {@link emptyFolderText} tells an empty folder from a missing one. */
  readonly emptyText?: string;
  /** The reader's language, for the Modified column; English when not given. */
  readonly locale?: FilesSearchLocale;
  /** The table's words in the reader's language; English when not given. */
  readonly words?: FilesStrings;
}

/**
 * The one row-rendering table shared by {@link FilesScreen} (full actions) and {@link FilePicker}
 * (checkboxes, for `#133`'s reuse) — folders open on click *and* on Enter for free, because each
 * is a real `<button>` rather than a `<div onClick>`, and Download is structurally absent from
 * every folder row rather than merely hidden by a condition a future edit could invert.
 */
export function FileTable(table: FileTableProps) {
  const {
    rows: fileRows,
    onRenameStart,
    onDelete,
    renaming,
    selection,
    words = ENGLISH_FILES_STRINGS,
  } = table;
  const emptyText = table.emptyText ?? words.emptyFolder;
  if (fileRows.length === 0) {
    // A status region: the sentence can change once the parent folder has been checked.
    return (
      <p className="text-sm text-muted" role="status">
        {emptyText}
      </p>
    );
  }
  const hasActions = onRenameStart !== undefined || onDelete !== undefined;
  const columnCount = 5 + (selection === undefined ? 0 : 1) + (hasActions ? 1 : 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {selection === undefined ? null : (
              <th className={TH}>
                <span className="sr-only">{words.columns.select}</span>
              </th>
            )}
            <th className={TH}>{words.columns.name}</th>
            <th className={TH}>{words.columns.type}</th>
            <th className={TH}>{words.columns.size}</th>
            <th className={TH}>{words.columns.contentType}</th>
            <th className={TH}>{words.columns.modified}</th>
            {hasActions ? <th className={TH}>{words.columns.actions}</th> : null}
          </tr>
        </thead>
        <tbody>
          {fileRows.map((row) =>
            renaming != null && renaming.id === row.id ? (
              <FileRenameRow
                key={row.id}
                row={row}
                table={table}
                renaming={renaming}
                columnCount={columnCount}
              />
            ) : (
              <FileDisplayRow key={row.id} row={row} table={table} hasActions={hasActions} />
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function FileRenameRow({
  row,
  table,
  renaming,
  columnCount,
}: {
  readonly row: FileRow;
  readonly table: FileTableProps;
  readonly renaming: FileTableRenameState;
  readonly columnCount: number;
}) {
  const {
    rows: fileRows,
    folderPath = '',
    onRenameSave,
    onRenameChange,
    onRenameCancel,
    words = ENGLISH_FILES_STRINGS,
  } = table;
  const name = fileName(row.path);
  const choices = moveFolderChoices(folderPath, fileRows, row.path);
  const typedFolder = parentPath(renaming.value.trim());
  // A typed folder the screen does not know is still shown as the current choice.
  const options = choices.includes(typedFolder) ? choices : [...choices, typedFolder];
  return (
    <tr key={row.id}>
      <td className={TD} colSpan={columnCount}>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onRenameSave?.(row);
          }}
        >
          {/* The name stays visible while it is edited (UX-27 in #2086). */}
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor={`rename-${row.id}`}>
              {words.newPathFor} <strong className="break-all">{name}</strong>
            </label>
            <input
              className={INPUT}
              id={`rename-${row.id}`}
              onChange={(event) => onRenameChange?.(event.target.value)}
              value={renaming.value}
            />
          </div>
          <label className="flex flex-col gap-1 text-sm">
            {words.moveToFolder}
            <select
              className={INPUT}
              onChange={(event) =>
                onRenameChange?.(moveInto(event.target.value, renaming.value, name))
              }
              value={typedFolder}
            >
              {options.map((folder) => (
                <option key={folder} value={folder}>
                  {folder === '' ? words.home : folder}
                </option>
              ))}
            </select>
          </label>
          <button className={BUTTON} type="submit">
            {words.save}
          </button>
          <button className={BUTTON} onClick={onRenameCancel} type="button">
            {words.cancel}
          </button>
        </form>
      </td>
    </tr>
  );
}

function FileDisplayRow({
  row,
  table,
  hasActions,
}: {
  readonly row: FileRow;
  readonly table: FileTableProps;
  readonly hasActions: boolean;
}) {
  const { selection, onNavigate, words = ENGLISH_FILES_STRINGS } = table;
  const name = fileName(row.path);
  return (
    <tr className="hover:bg-surface-2" key={row.id}>
      {selection === undefined ? null : (
        <td className={TD}>
          <input
            aria-label={words.selectRow(name)}
            checked={selection.selected.has(row.id)}
            onChange={() => selection.onToggle(row)}
            type="checkbox"
          />
        </td>
      )}
      {/* A minimum width: in a narrow table a Japanese name, which has no spaces, would otherwise
          break into one character per line. A longer name still wraps; the table scrolls inside
          its card. */}
      <td className={`${TD} min-w-32 break-words`}>
        {row.kind === 'folder' ? (
          <button
            className="font-medium text-accent underline"
            onClick={() => onNavigate(row.path)}
            type="button"
          >
            {name}/
          </button>
        ) : (
          name
        )}
      </td>
      {/* Short cells stay on one line: Japanese has no spaces to break at. */}
      <td className={`${TD} whitespace-nowrap`}>{words.kind[row.kind]}</td>
      <td className={`${TD} whitespace-nowrap`}>{formatSize(row.sizeBytes)}</td>
      <td className={TD}>{row.contentType ?? '—'}</td>
      <td lang={table.locale ?? 'en'} className={`${TD} whitespace-nowrap`}>
        {formatModified(row.lastModified, table.locale)}
      </td>
      {hasActions ? (
        <td className={`${TD} whitespace-nowrap`}>
          <FileRowActions row={row} table={table} />
        </td>
      ) : null}
    </tr>
  );
}

function FileRowActions({ row, table }: { readonly row: FileRow; readonly table: FileTableProps }) {
  const { onRenameStart, onDelete, words = ENGLISH_FILES_STRINGS } = table;
  return (
    <div className="flex gap-2">
      {row.kind === 'file' ? (
        <a className={BUTTON} href={`/api/files/${fileRouteId(row.path)}`}>
          {words.download}
        </a>
      ) : null}
      {onRenameStart ? (
        <button className={BUTTON} onClick={() => onRenameStart(row)} type="button">
          {words.rename}
        </button>
      ) : null}
      {onDelete ? (
        <button className={BUTTON} onClick={() => onDelete(row)} type="button">
          {words.delete}
        </button>
      ) : null}
    </div>
  );
}
