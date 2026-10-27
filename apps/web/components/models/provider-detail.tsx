'use client';

/**
 * `#128`'s provider detail/edit panel — expands inline under a row of `ModelsScreen`'s list. No new
 * route: the card's Minimum implementation is explicit that this lives on the existing
 * `/admin/models` route, not a new page.
 *
 * Three independent actions live here, each hitting the one `#126` route built for it:
 *
 *   - Save     → `PATCH  /api/model-connections/:id`            (name, non-secret config)
 *   - Rotate   → `POST   /api/model-connections/:id/credential` (write-only; never pre-filled,
 *                 never redisplayed — the input's initial value is always `''`, never derived
 *                 from `connection`, which carries no credential field to derive it from)
 *   - Remove   → `GET    /api/agents` (read, to preview who is affected) then
 *                `DELETE /api/model-connections/:id` (only after the caller types the connection's
 *                 name — `confirmationMatches` — so cancelling never issues the delete request at all)
 */
import { useState, type FormEvent } from 'react';

import { browserClient } from '../../lib/browser-client';
import { CREDENTIAL_INPUT_PROPS } from '../shell/credential-input';

import {
  referencingAgents,
  removeConnection,
  rotateCredential,
  testAfterRotation,
  updateConnection,
} from './connections-model';
import {
  confirmationMatches,
  connectionStatus,
  editableConfigFields,
  isEditFormValid,
  providerLabel,
  type EditFormValues,
  type ModelConnectionView,
  type ReferencingAgent,
} from './model';

const FIELD_LABEL: Record<'baseUrl' | 'deployment' | 'apiVersion', string> = {
  baseUrl: 'Base URL',
  deployment: 'Deployment',
  apiVersion: 'API version',
};

const CARD = 'rounded-(--radius-sm) border border-border-strong bg-surface-2 p-4';
const CONTROL =
  'w-full rounded-(--radius-sm) border border-border-strong bg-surface px-2.5 py-[7px] text-[13.5px] text-text focus:border-accent focus:outline-2 focus:-outline-offset-1 focus:outline-accent';
const BUTTON =
  'inline-flex h-8 items-center justify-center rounded-(--radius-sm) border border-border-strong px-[13px] text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50';
const ALERT =
  'rounded-(--radius-sm) border border-danger bg-danger-soft p-2.5 text-[12.5px] text-danger';
const NOTICE =
  'rounded-(--radius-sm) border border-border bg-surface p-2.5 text-[12.5px] text-muted';

function editValuesFrom(connection: ModelConnectionView): EditFormValues {
  return {
    name: connection.name,
    baseUrl: connection.config.baseUrl ?? '',
    deployment: connection.config.deployment ?? '',
    apiVersion: connection.config.apiVersion ?? '',
  };
}

export function ProviderDetailPanel({
  connection,
  onUpdated,
  onRemoved,
  onClose,
}: Readonly<{
  connection: ModelConnectionView;
  onUpdated: (next: ModelConnectionView) => void;
  onRemoved: (id: string) => void;
  onClose: () => void;
}>) {
  const [values, setValues] = useState<EditFormValues>(() => editValuesFrom(connection));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [rotateKey, setRotateKey] = useState('');
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotateMessage, setRotateMessage] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [preview, setPreview] = useState<
    | { kind: 'loading' }
    | { kind: 'loaded'; referencing: readonly ReferencingAgent[] }
    | { kind: 'error' }
  >({ kind: 'loading' });
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function set(field: keyof EditFormValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isEditFormValid(values, connection.provider)) return;
    setSaving(true);
    setSaveError(null);
    void updateConnection(browserClient(), connection, values)
      .then((updated) => {
        if (updated !== undefined) onUpdated(updated);
      })
      .catch((error: unknown) =>
        setSaveError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setSaving(false));
  }

  function rotate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (rotateKey === '') return;
    setRotating(true);
    setRotateError(null);
    setRotateMessage(null);
    const client = browserClient();
    void rotateCredential(client, connection.id, rotateKey)
      .then(() => {
        // Never pre-filled, never redisplayed: the value that was just typed is discarded the
        // moment the request that consumes it succeeds, not kept around for a retry to reuse.
        setRotateKey('');
        setRotateMessage('Credential rotated. Testing the connection…');
        return testAfterRotation(client, connection.id);
      })
      .then(setRotateMessage)
      .catch((error: unknown) =>
        setRotateError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setRotating(false));
  }

  function openRemoveConfirm() {
    setConfirmOpen(true);
    setConfirmText('');
    setDeleteError(null);
    setPreview({ kind: 'loading' });
    void referencingAgents(browserClient(), connection.id)
      .then((referencing) => setPreview({ kind: 'loaded', referencing }))
      .catch(() => setPreview({ kind: 'error' }));
  }

  function confirmRemove() {
    if (!confirmationMatches(confirmText, connection.name)) return;
    setDeleting(true);
    setDeleteError(null);
    void removeConnection(browserClient(), connection.id)
      .then(() => onRemoved(connection.id))
      .catch((error: unknown) =>
        setDeleteError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setDeleting(false));
  }

  const status = connectionStatus(connection);
  const fields = editableConfigFields(connection.provider);
  const removeReady = confirmationMatches(confirmText, connection.name);

  return (
    <div className="space-y-4 border-t border-border bg-surface-2 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">
          {connection.name}{' '}
          <span className="font-normal text-muted">· {providerLabel(connection.provider)}</span>
        </h2>
        <button type="button" className={BUTTON} onClick={onClose}>
          Close
        </button>
      </div>

      <form onSubmit={save} className={`${CARD} space-y-3`}>
        <h3 className="text-[13px] font-semibold">Connection settings</h3>
        <label htmlFor={`name-${connection.id}`} className="block text-[13px] font-semibold">
          Display name
          <input
            id={`name-${connection.id}`}
            className={`${CONTROL} mt-1`}
            value={values.name}
            onChange={(event) => set('name', event.target.value)}
          />
        </label>
        {fields.map((field) => (
          <label
            key={field}
            htmlFor={`${field}-${connection.id}`}
            className="block text-[13px] font-semibold"
          >
            {FIELD_LABEL[field]}
            <input
              id={`${field}-${connection.id}`}
              className={`${CONTROL} mt-1 font-mono`}
              value={values[field]}
              onChange={(event) => set(field, event.target.value)}
            />
          </label>
        ))}
        {saveError === null ? null : (
          <p role="alert" className={ALERT}>
            {saveError}
          </p>
        )}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving || !isEditFormValid(values, connection.provider)}
            className={`${BUTTON} border-accent bg-accent text-white`}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>

      <form onSubmit={rotate} className={`${CARD} space-y-3`}>
        <h3 className="text-[13px] font-semibold">
          Rotate credential{' '}
          <span
            className={`ml-1 rounded-full px-2 py-0.5 text-[10px] ${status.tone === 'ok' ? 'bg-ok-soft text-ok' : status.tone === 'warn' ? 'bg-warn-soft text-warn' : 'bg-danger-soft text-danger'}`}
          >
            {status.text}
          </span>
        </h3>
        <label htmlFor={`rotate-${connection.id}`} className="block text-[13px] font-semibold">
          New API key
          <input
            id={`rotate-${connection.id}`}
            type="password"
            {...CREDENTIAL_INPUT_PROPS}
            className={`${CONTROL} mt-1 font-mono`}
            value={rotateKey}
            onChange={(event) => setRotateKey(event.target.value)}
          />
          <span className="mt-1 block text-[11.5px] font-normal text-muted">
            The current key is never shown. Saving replaces it and retests the connection
            immediately.
          </span>
        </label>
        {rotateError === null ? null : (
          <p role="alert" className={ALERT}>
            {rotateError}
          </p>
        )}
        {rotateMessage === null ? null : (
          <p role="status" className={NOTICE}>
            {rotateMessage}
          </p>
        )}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={rotating || rotateKey === ''}
            className={`${BUTTON} border-accent bg-accent text-white`}
          >
            {rotating ? 'Rotating…' : 'Rotate credential'}
          </button>
        </div>
      </form>

      <div className={`${CARD} space-y-3`}>
        <h3 className="text-[13px] font-semibold text-danger">Remove connection</h3>
        {!confirmOpen ? (
          <div className="flex justify-end">
            <button
              type="button"
              className={`${BUTTON} border-danger text-danger`}
              onClick={openRemoveConfirm}
            >
              Remove connection…
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {preview.kind === 'loading' ? (
              <p className={NOTICE}>Checking which agents use this connection…</p>
            ) : preview.kind === 'error' ? (
              <p role="alert" className={ALERT}>
                Could not check which agents use this connection. The removal will still report it.
              </p>
            ) : preview.referencing.length === 0 ? (
              <p className={NOTICE}>No agent currently uses this connection.</p>
            ) : (
              <div role="alert" className={ALERT}>
                This connection is used by {preview.referencing.length} agent
                {preview.referencing.length === 1 ? '' : 's'}:{' '}
                {preview.referencing.map((agent) => agent.agentName).join(', ')}. Removing it falls
                those agents back to the workspace default model.
              </div>
            )}
            <label htmlFor={`confirm-${connection.id}`} className="block text-[13px] font-semibold">
              Type <span className="font-mono">{connection.name}</span> to confirm
              <input
                id={`confirm-${connection.id}`}
                className={`${CONTROL} mt-1`}
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
              />
            </label>
            {deleteError === null ? null : (
              <p role="alert" className={ALERT}>
                {deleteError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={BUTTON}
                onClick={() => {
                  setConfirmOpen(false);
                  setConfirmText('');
                  setDeleteError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!removeReady || deleting}
                className={`${BUTTON} border-danger bg-danger text-white`}
                onClick={confirmRemove}
              >
                {deleting ? 'Removing…' : 'Remove connection'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
