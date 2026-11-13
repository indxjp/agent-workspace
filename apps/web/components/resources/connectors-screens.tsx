'use client';

import Link from 'next/link';
import { useState } from 'react';
import { browserClient } from '../../lib/browser-client';
import { CREDENTIAL_INPUT_PROPS } from '../shell/credential-input';
import {
  deleteConnector,
  errorText,
  loadConnectors,
  submitConnector,
  testConnector,
} from './resources-model';
import type { ConnectorAuthType } from '@indx-workspace/contracts/connectors';
import {
  deleteThenReload,
  formString,
  rows,
  rowsWithStrings,
  Status,
  title,
  useJson,
} from './resource-screen-state';
import { BUTTON, CARD, INPUT } from './resource-styles';

export function ConnectorsScreen() {
  const state = useJson(loadConnectors);
  const [probe, setProbe] = useState<string | null>(null);
  return (
    <>
      {title(
        'Connectors',
        'MCP servers available to workspace agents.',
        <Link className={BUTTON} href="/connectors/new">
          Add connector
        </Link>,
      )}
      <Status problem={state.problem} />
      {state.loading ? (
        <p className="mb-4 text-sm text-muted" role="status">
          Loading connectors…
        </p>
      ) : null}
      {probe ? (
        <p className="mb-4 text-sm text-muted" role="status">
          {probe}
        </p>
      ) : null}
      <div className={CARD}>
        {rowsWithStrings(state.value, 'connectors', 'id', 'name', 'transport').map((connector) => (
          <div
            className="flex items-center gap-3 border-b border-border py-3 last:border-0"
            key={String(connector.id)}
          >
            <span className="flex-1 text-sm">
              <b>{String(connector.name)}</b>
              <span className="ml-2 text-muted">{String(connector.transport)}</span>
            </span>
            <button
              className={BUTTON}
              onClick={() =>
                void testConnector(browserClient(), String(connector.id), String(connector.name))
                  .then(setProbe)
                  .catch((error: unknown) => state.setProblem(errorText(error)))
              }
              type="button"
            >
              Test
            </button>
            <button
              className={BUTTON}
              onClick={() => {
                if (window.confirm(`Delete connector ${String(connector.name)}?`))
                  deleteThenReload(state, (client) =>
                    deleteConnector(client, String(connector.id)),
                  );
              }}
              type="button"
            >
              Delete
            </button>
          </div>
        ))}
        {state.value !== null && rows(state.value, 'connectors').length === 0 ? (
          <p className="text-sm text-muted">No connectors yet.</p>
        ) : null}
      </div>
    </>
  );
}

export function ConnectorNewScreen() {
  const [message, setMessage] = useState<string | null>(null);
  const [authType, setAuthType] = useState<ConnectorAuthType>('none');
  const submit = async (element: HTMLFormElement, dryRun: boolean) => {
    const form = new FormData(element);
    const result = await submitConnector(
      browserClient(),
      {
        name: formString(form, 'name').trim(),
        transport: formString(form, 'transport'),
        endpoint: formString(form, 'endpoint').trim(),
        args: formString(form, 'args'),
        authType,
        credential: formString(form, 'credential'),
      },
      dryRun,
    );
    if (result === null) window.location.assign('/connectors');
    else setMessage(result);
  };
  return (
    <>
      {title(
        'Add connector',
        'Test the connection before saving it.',
        <Link className={BUTTON} href="/connectors">
          Cancel
        </Link>,
      )}
      <Status problem={message} />
      <form
        className={`${CARD} grid gap-3`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit(event.currentTarget, false).catch((error: unknown) =>
            setMessage(error instanceof Error ? error.message : String(error)),
          );
        }}
      >
        <ConnectorConnectionFields />
        <ConnectorAuthFields authType={authType} onChange={setAuthType} />
        <div className="flex gap-3">
          <button
            className={BUTTON}
            onClick={(event) => {
              const form = event.currentTarget.form;
              if (form)
                void submit(form, true).catch((error: unknown) =>
                  setMessage(error instanceof Error ? error.message : String(error)),
                );
            }}
            type="button"
          >
            Test connection
          </button>
          <button className={BUTTON} type="submit">
            Save
          </button>
        </div>
      </form>
    </>
  );
}

function ConnectorConnectionFields() {
  return (
    <>
      {' '}
      <input
        aria-label="Connector name"
        className={INPUT}
        name="name"
        placeholder="Connector name"
        required
      />
      <select aria-label="Transport" className={INPUT} name="transport">
        <option value="http">HTTP</option>
        <option value="sse">SSE</option>
        <option value="stdio">stdio</option>
      </select>
      <input
        aria-label="Endpoint"
        className={INPUT}
        name="endpoint"
        placeholder="URL or command"
        required
      />
      <input
        aria-label="stdio arguments"
        className={INPUT}
        name="args"
        placeholder="stdio arguments (optional)"
      />
    </>
  );
}
function ConnectorAuthFields({
  authType,
  onChange,
}: {
  readonly authType: ConnectorAuthType;
  readonly onChange: (value: ConnectorAuthType) => void;
}) {
  return (
    <>
      {' '}
      <select
        aria-label="Authentication"
        className={INPUT}
        name="authType"
        value={authType}
        onChange={(event) => onChange(event.target.value as ConnectorAuthType)}
      >
        <option value="none">No authentication</option>
        <option value="api-key">API key</option>
        <option value="bearer">Bearer token</option>
        <option value="oauth">OAuth token</option>
      </select>
      {authType === 'none' ? null : (
        <input
          {...CREDENTIAL_INPUT_PROPS}
          className={INPUT}
          aria-label="Credential"
          name="credential"
          placeholder="Credential (stored encrypted)"
          required
          type="password"
        />
      )}
    </>
  );
}
