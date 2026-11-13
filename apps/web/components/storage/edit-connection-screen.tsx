'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import { browserClient } from '../../lib/browser-client';
import type { VersionsLocale } from '../agents/versions-messages';

import {
  CredentialInputs,
  STORAGE_BUTTON as BUTTON,
  STORAGE_CARD as CARD,
  STORAGE_CONTROL as CONTROL,
  STORAGE_HELP as HELP,
  STORAGE_LABEL as LABEL,
} from './storage-form-parts';
import { storageStrings, type StorageStrings } from './storage-messages';
import {
  credentialFor,
  credentialProblem,
  editFormValues,
  EMPTY_CREDENTIALS,
  storageProblemMessage,
  updatePatch,
  URL_HINTS,
  type CredentialFields,
  type EditFormValues,
  type StorageConnectionResource,
} from './storage-model';

/** A message that takes focus when it appears, so a keyboard user lands on what went wrong. */
function Problem({ message }: Readonly<{ message: string }>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="mt-4 rounded-(--radius) border border-danger bg-danger-soft p-4 text-[13px] text-danger"
    >
      {message}
    </div>
  );
}

/**
 * While the dialog is open, the page behind it is `inert`: every sibling of the dialog and of each
 * of its ancestors up to `<body>`, the shell's navigation included. `aria-modal` alone leaves that
 * page clickable and reachable by a screen reader's virtual cursor. Only the elements this marked
 * are restored, so one that was already inert stays inert. Focus goes back to `returnFocusTo` once
 * the page is live again: an inert element cannot take focus.
 */
function useInertBackground(
  dialogRef: RefObject<HTMLElement | null>,
  returnFocusTo: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const marked: Element[] = [];
    for (let node = dialogRef.current; node?.parentElement; node = node.parentElement) {
      if (node === document.body) break;
      for (const sibling of node.parentElement.children) {
        if (sibling === node || sibling.hasAttribute('inert')) continue;
        sibling.setAttribute('inert', '');
        marked.push(sibling);
      }
    }
    return () => {
      for (const element of marked) element.removeAttribute('inert');
      returnFocusTo.current?.focus();
    };
  }, [dialogRef, returnFocusTo]);
}

function DeleteDialog({
  name,
  busy,
  returnFocusTo,
  onCancel,
  onConfirm,
  strings,
}: Readonly<{
  name: string;
  busy: boolean;
  strings: StorageStrings;
  /** Focused when the dialog closes, whichever way it closes. */
  returnFocusTo: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useInertBackground(dialogRef, returnFocusTo);
  useEffect(() => cancelRef.current?.focus(), []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable =
      panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    const first = focusable?.[0];
    const last = focusable?.[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="storage-delete-title"
      aria-describedby="storage-delete-description"
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <div ref={panelRef} className={`${CARD} w-full max-w-[480px] p-5`}>
        <h2 id="storage-delete-title" className="text-[18px]">
          {strings.deleteTitle(name)}
        </h2>
        <p id="storage-delete-description" className="mt-2 text-[13px] text-muted">
          {strings.deleteDescription}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className={`${BUTTON} bg-surface`}
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onCancel();
            }}
          >
            {strings.cancel}
          </button>
          <button
            type="button"
            className={`${BUTTON} border-danger bg-danger text-white`}
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onConfirm();
            }}
          >
            {strings.deleteConnection}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EditConnectionScreen({
  id,
  locale = 'en',
}: Readonly<{
  id: string;
  /** The reader's language (UX-15 in #2086); English by default. */
  locale?: VersionsLocale;
}>) {
  const strings = storageStrings(locale);
  const router = useRouter();
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const [connection, setConnection] = useState<StorageConnectionResource | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [values, setValues] = useState<EditFormValues | null>(null);
  const [credentials, setCredentials] = useState<CredentialFields>(EMPTY_CREDENTIALS);
  const [settingsProblem, setSettingsProblem] = useState<string | null>(null);
  const [credentialProblemText, setCredentialProblemText] = useState<string | null>(null);
  const [deleteProblem, setDeleteProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    let active = true;
    void browserClient()
      .storage.connections.get(id)
      .then(
        (loaded) => {
          if (!active) return;
          setConnection(loaded);
          setValues(editFormValues(loaded));
        },
        (error: unknown) => {
          if (active) {
            setLoadProblem(storageProblemMessage(error, strings.couldNotLoad, strings));
          }
        },
      );
    return () => {
      active = false;
    };
  }, [id, strings]);

  const heading = (
    <div className="mb-[22px]">
      <h1 className="text-[21px]">{strings.editTitle}</h1>
      {connection === null ? null : (
        <p className="mt-[3px] text-[13px] text-muted">
          {connection.name} · {connection.provider}
        </p>
      )}
    </div>
  );

  if (connection === null || values === null) {
    return (
      <main lang={locale} className="w-full max-w-[760px] px-8 pt-[26px] pb-[90px]">
        {heading}
        {loadProblem === null ? (
          <p className="text-[13px] text-muted">{strings.loadingConnection}</p>
        ) : (
          <>
            <Problem message={loadProblem} />
            <p className="mt-4 text-[13px]">
              <Link href="/admin/storage">{strings.backToStorage}</Link>
            </p>
          </>
        )}
      </main>
    );
  }

  const setValue = (patch: Partial<EditFormValues>) =>
    setValues((current) => (current === null ? current : { ...current, ...patch }));
  const setCredential = (patch: Partial<CredentialFields>) =>
    setCredentials((current) => ({ ...current, ...patch }));

  function reset() {
    setNotice(null);
    setSettingsProblem(null);
    setCredentialProblemText(null);
    setDeleteProblem(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || connection === null || values === null) return;
    reset();
    const refused = credentialProblem(connection.provider, credentials, strings);
    if (refused !== null) {
      setCredentialProblemText(refused);
      setCredentials(EMPTY_CREDENTIALS);
      return;
    }
    const patch = updatePatch(connection, values, credentialFor(connection.provider, credentials));
    if (Object.keys(patch).length === 0) {
      setSettingsProblem(strings.nothingChanged);
      return;
    }
    setBusy(true);
    try {
      const updated = await browserClient().storage.connections.update(connection.id, patch);
      setConnection(updated);
      setValues(editFormValues(updated));
      setNotice(strings.changesSaved);
    } catch (error) {
      setSettingsProblem(storageProblemMessage(error, strings.couldNotSaveChanges, strings));
    } finally {
      // A credential is write-only: it leaves the page state whatever the outcome.
      setCredentials(EMPTY_CREDENTIALS);
      setBusy(false);
    }
  }

  async function rotate() {
    if (busy || connection === null) return;
    reset();
    const refused = credentialProblem(connection.provider, credentials, strings);
    const credential = credentialFor(connection.provider, credentials);
    if (refused !== null || credential === undefined) {
      setCredentialProblemText(refused ?? strings.enterNewCredential);
      setCredentials(EMPTY_CREDENTIALS);
      return;
    }
    setBusy(true);
    try {
      setConnection(
        await browserClient().storage.connections.rotateCredential(connection.id, credential),
      );
      setNotice(strings.credentialRotated);
    } catch (error) {
      setCredentialProblemText(storageProblemMessage(error, strings.couldNotRotate, strings));
    } finally {
      setCredentials(EMPTY_CREDENTIALS);
      setBusy(false);
    }
  }

  async function remove() {
    if (busy || connection === null) return;
    reset();
    setBusy(true);
    try {
      await browserClient().storage.connections.remove(connection.id);
      router.push('/admin/storage');
    } catch (error) {
      setConfirmingDelete(false);
      setDeleteProblem(storageProblemMessage(error, strings.couldNotDelete, strings));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main lang={locale} className="w-full max-w-[760px] px-8 pt-[26px] pb-[90px]">
      {heading}
      <form
        method="post"
        onSubmit={(event) => {
          void save(event);
        }}
      >
        <div className={`${CARD} space-y-4 p-4`}>
          <div>
            <label className={LABEL} htmlFor="storage-url">
              {strings.url}
            </label>
            <input
              id="storage-url"
              className={`${CONTROL} mt-1 font-mono`}
              value={values.url}
              required
              aria-describedby="storage-url-help"
              onChange={(event) => setValue({ url: event.target.value })}
            />
            <p id="storage-url-help" className={HELP}>
              {strings.urlExample(URL_HINTS[connection.provider])} {strings.urlMoveNeedsCredential}
            </p>
          </div>
          <div>
            <label className={LABEL} htmlFor="storage-folders">
              {strings.allowedFolders}
            </label>
            <textarea
              id="storage-folders"
              className={`${CONTROL} mt-1 font-mono`}
              rows={3}
              value={values.folders}
              required
              aria-describedby="storage-folders-help"
              onChange={(event) => setValue({ folders: event.target.value })}
            />
            <p id="storage-folders-help" className={HELP}>
              {strings.foldersHelp}
            </p>
          </div>
          <label
            className="flex items-center gap-2 text-[13px] font-semibold"
            htmlFor="storage-write"
          >
            <input
              id="storage-write"
              type="checkbox"
              checked={values.writeAllowed}
              onChange={(event) => setValue({ writeAllowed: event.target.checked })}
            />
            {strings.allowWriting}
          </label>
          <p className="-mt-2 text-[11.5px] text-muted">{strings.allowWritingHelp}</p>
        </div>

        {connection.provider === 'file' ? null : (
          <section
            className={`${CARD} mt-4 space-y-4 p-4`}
            aria-labelledby="storage-credential-heading"
          >
            <h2 id="storage-credential-heading" className="text-[15px] font-semibold">
              {strings.credential}
            </h2>
            <p className="text-[12.5px] text-muted">
              {connection.hasCredential ? strings.credentialStoredHelp : strings.credentialNoneHelp}{' '}
              {strings.enterNewToReplace}
            </p>
            <CredentialInputs
              provider={connection.provider}
              credentials={credentials}
              onChange={setCredential}
              strings={strings}
            />
            <div>
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={() => {
                  void rotate();
                }}
              >
                {strings.rotateCredential}
              </button>
            </div>
            {credentialProblemText === null ? null : <Problem message={credentialProblemText} />}
          </section>
        )}

        {settingsProblem === null ? null : <Problem message={settingsProblem} />}
        {notice === null ? null : (
          <div role="status" className="mt-4 text-[13px]">
            {notice}
          </div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Link href="/admin/storage" className={`${BUTTON} bg-surface no-underline`}>
            {strings.backToStorage}
          </Link>
          <button
            type="submit"
            disabled={busy}
            className={`${BUTTON} border-accent bg-accent text-white`}
          >
            {strings.saveChanges}
          </button>
        </div>
      </form>

      <section className={`${CARD} mt-8 p-4`} aria-labelledby="storage-delete-heading">
        <h2 id="storage-delete-heading" className="text-[15px] font-semibold">
          {strings.deleteHeading}
        </h2>
        <p className="mt-1 text-[12.5px] text-muted">{strings.deleteHelp}</p>
        <button
          ref={deleteTriggerRef}
          type="button"
          className={`${BUTTON} mt-3 border-danger bg-surface text-danger`}
          disabled={busy}
          onClick={() => {
            reset();
            setConfirmingDelete(true);
          }}
        >
          {strings.deleteThis}
        </button>
        {deleteProblem === null ? null : <Problem message={deleteProblem} />}
      </section>

      {confirmingDelete ? (
        <DeleteDialog
          name={connection.name}
          busy={busy}
          returnFocusTo={deleteTriggerRef}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            void remove();
          }}
          strings={strings}
        />
      ) : null}
    </main>
  );
}
