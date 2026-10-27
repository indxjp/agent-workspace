'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { browserClient } from '../../lib/browser-client';

import {
  CredentialInputs,
  STORAGE_BUTTON as BUTTON,
  STORAGE_CARD as CARD,
  STORAGE_CONTROL as CONTROL,
  STORAGE_HELP as HELP,
  STORAGE_LABEL as LABEL,
} from './storage-form-parts';
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

function DeleteDialog({
  name,
  busy,
  onCancel,
  onConfirm,
}: Readonly<{ name: string; busy: boolean; onCancel: () => void; onConfirm: () => void }>) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
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
      role="dialog"
      aria-modal="true"
      aria-labelledby="storage-delete-title"
      aria-describedby="storage-delete-description"
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <div ref={panelRef} className={`${CARD} w-full max-w-[480px] p-5`}>
        <h2 id="storage-delete-title" className="text-[18px]">
          Delete {name}?
        </h2>
        <p id="storage-delete-description" className="mt-2 text-[13px] text-muted">
          The connection and its stored credential are removed. The files in the bucket are not
          touched. A connection that agents still grant cannot be deleted.
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
            Cancel
          </button>
          <button
            type="button"
            className={`${BUTTON} border-danger bg-danger text-white`}
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onConfirm();
            }}
          >
            Delete connection
          </button>
        </div>
      </div>
    </div>
  );
}

export function EditConnectionScreen({ id }: Readonly<{ id: string }>) {
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
            setLoadProblem(
              storageProblemMessage(error, 'The storage connection could not be loaded.'),
            );
          }
        },
      );
    return () => {
      active = false;
    };
  }, [id]);

  const heading = (
    <div className="mb-[22px]">
      <h1 className="text-[21px]">Edit storage connection</h1>
      {connection === null ? null : (
        <p className="mt-[3px] text-[13px] text-muted">
          {connection.name} · {connection.provider}
        </p>
      )}
    </div>
  );

  if (connection === null || values === null) {
    return (
      <main className="w-full max-w-[760px] px-8 pt-[26px] pb-[90px]">
        {heading}
        {loadProblem === null ? (
          <p className="text-[13px] text-muted">Loading the storage connection…</p>
        ) : (
          <>
            <Problem message={loadProblem} />
            <p className="mt-4 text-[13px]">
              <Link href="/admin/storage">Back to storage</Link>
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
    const refused = credentialProblem(connection.provider, credentials);
    if (refused !== null) {
      setCredentialProblemText(refused);
      setCredentials(EMPTY_CREDENTIALS);
      return;
    }
    const patch = updatePatch(connection, values, credentialFor(connection.provider, credentials));
    if (Object.keys(patch).length === 0) {
      setSettingsProblem('Nothing has changed.');
      return;
    }
    setBusy(true);
    try {
      const updated = await browserClient().storage.connections.update(connection.id, patch);
      setConnection(updated);
      setValues(editFormValues(updated));
      setNotice('Changes saved.');
    } catch (error) {
      setSettingsProblem(storageProblemMessage(error, 'The changes could not be saved.'));
    } finally {
      // A credential is write-only: it leaves the page state whatever the outcome.
      setCredentials(EMPTY_CREDENTIALS);
      setBusy(false);
    }
  }

  async function rotate() {
    if (busy || connection === null) return;
    reset();
    const refused = credentialProblem(connection.provider, credentials);
    const credential = credentialFor(connection.provider, credentials);
    if (refused !== null || credential === undefined) {
      setCredentialProblemText(refused ?? 'Enter the new credential.');
      setCredentials(EMPTY_CREDENTIALS);
      return;
    }
    setBusy(true);
    try {
      setConnection(
        await browserClient().storage.connections.rotateCredential(connection.id, credential),
      );
      setNotice('Credential rotated. It is stored encrypted and not shown again.');
    } catch (error) {
      setCredentialProblemText(
        storageProblemMessage(error, 'The credential could not be rotated.'),
      );
    } finally {
      setCredentials(EMPTY_CREDENTIALS);
      setBusy(false);
    }
  }

  function closeDialog() {
    setConfirmingDelete(false);
    deleteTriggerRef.current?.focus();
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
      setDeleteProblem(storageProblemMessage(error, 'The connection could not be deleted.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="w-full max-w-[760px] px-8 pt-[26px] pb-[90px]">
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
              URL
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
              For example {URL_HINTS[connection.provider]}. Moving to another endpoint, bucket or
              account needs a new credential.
            </p>
          </div>
          <div>
            <label className={LABEL} htmlFor="storage-folders">
              Allowed folders
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
              One folder per line, such as reports. Agents see only these.
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
            Allow writing
          </label>
          <p className="-mt-2 text-[11.5px] text-muted">
            Off by default. Grants stay read-only until write-back ships.
          </p>
        </div>

        {connection.provider === 'file' ? null : (
          <section
            className={`${CARD} mt-4 space-y-4 p-4`}
            aria-labelledby="storage-credential-heading"
          >
            <h2 id="storage-credential-heading" className="text-[15px] font-semibold">
              Credential
            </h2>
            <p className="text-[12.5px] text-muted">
              {connection.hasCredential
                ? 'A credential is stored encrypted and never shown again.'
                : 'No credential is stored; the deployment’s own identity is used.'}{' '}
              Enter a new one to replace it.
            </p>
            <CredentialInputs
              provider={connection.provider}
              credentials={credentials}
              onChange={setCredential}
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
                Rotate credential
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
            Back to storage
          </Link>
          <button
            type="submit"
            disabled={busy}
            className={`${BUTTON} border-accent bg-accent text-white`}
          >
            Save changes
          </button>
        </div>
      </form>

      <section className={`${CARD} mt-8 p-4`} aria-labelledby="storage-delete-heading">
        <h2 id="storage-delete-heading" className="text-[15px] font-semibold">
          Delete
        </h2>
        <p className="mt-1 text-[12.5px] text-muted">
          Removes the connection and its stored credential. Agents that still grant it must have
          their grants removed first.
        </p>
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
          Delete this connection
        </button>
        {deleteProblem === null ? null : <Problem message={deleteProblem} />}
      </section>

      {confirmingDelete ? (
        <DeleteDialog
          name={connection.name}
          busy={busy}
          onCancel={closeDialog}
          onConfirm={() => {
            void remove();
          }}
        />
      ) : null}
    </main>
  );
}
