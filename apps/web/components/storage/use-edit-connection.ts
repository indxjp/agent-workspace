'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { browserClient } from '../../lib/browser-client';

import type { StorageStrings } from './storage-messages';
import {
  credentialFor,
  credentialProblem,
  editFormValues,
  EMPTY_CREDENTIALS,
  storageProblemMessage,
  updatePatch,
  type CredentialFields,
  type EditFormValues,
  type StorageConnectionResource,
} from './storage-model';

/** The state and actions behind the edit-connection screen. */
export function useEditConnection(id: string, strings: StorageStrings) {
  const router = useRouter();
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

  function startDelete() {
    reset();
    setConfirmingDelete(true);
  }

  return {
    connection,
    values,
    credentials,
    loadProblem,
    settingsProblem,
    credentialProblemText,
    deleteProblem,
    notice,
    busy,
    confirmingDelete,
    setValue,
    setCredential,
    save,
    rotate,
    remove,
    startDelete,
    cancelDelete: () => setConfirmingDelete(false),
  };
}
