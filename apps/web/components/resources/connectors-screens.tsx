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
import type { VersionsLocale } from '../agents/versions-messages';
import { connectorsStrings, type ConnectorsStrings } from './connectors-messages';

export function ConnectorsScreen({ locale = 'en' }: { readonly locale?: VersionsLocale }) {
  const strings = connectorsStrings(locale);
  const state = useJson(loadConnectors);
  const [probe, setProbe] = useState<string | null>(null);
  return (
    <div lang={locale}>
      {title(
        strings.title,
        strings.intro,
        <Link className={BUTTON} href="/connectors/new">
          {strings.addConnector}
        </Link>,
      )}
      <Status problem={state.problem} />
      {state.loading ? (
        <p className="mb-4 text-sm text-muted" role="status">
          {strings.loading}
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
                void testConnector(
                  browserClient(),
                  String(connector.id),
                  String(connector.name),
                  strings,
                )
                  .then(setProbe)
                  .catch((error: unknown) => state.setProblem(errorText(error)))
              }
              type="button"
            >
              {strings.test}
            </button>
            <button
              className={BUTTON}
              onClick={() => {
                if (window.confirm(strings.confirmDelete(String(connector.name))))
                  deleteThenReload(state, (client) =>
                    deleteConnector(client, String(connector.id)),
                  );
              }}
              type="button"
            >
              {strings.delete}
            </button>
          </div>
        ))}
        {state.value !== null && rows(state.value, 'connectors').length === 0 ? (
          <p className="text-sm text-muted">{strings.empty}</p>
        ) : null}
      </div>
    </div>
  );
}

export function ConnectorNewScreen({ locale = 'en' }: { readonly locale?: VersionsLocale }) {
  const strings = connectorsStrings(locale);
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
      strings,
    );
    if (result === null) window.location.assign('/connectors');
    else setMessage(result);
  };
  return (
    <div lang={locale}>
      {title(
        strings.addConnector,
        strings.newIntro,
        <Link className={BUTTON} href="/connectors">
          {strings.cancel}
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
        <ConnectorConnectionFields strings={strings} />
        <ConnectorAuthFields authType={authType} onChange={setAuthType} strings={strings} />
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
            {strings.testConnection}
          </button>
          <button className={BUTTON} type="submit">
            {strings.save}
          </button>
        </div>
      </form>
    </div>
  );
}

function ConnectorConnectionFields({ strings }: { readonly strings: ConnectorsStrings }) {
  return (
    <>
      {' '}
      <input
        aria-label={strings.connectorName}
        className={INPUT}
        name="name"
        placeholder={strings.connectorName}
        required
      />
      <select aria-label={strings.transport} className={INPUT} name="transport">
        <option value="http">HTTP</option>
        <option value="sse">SSE</option>
        <option value="stdio">stdio</option>
      </select>
      <input
        aria-label={strings.endpoint}
        className={INPUT}
        name="endpoint"
        placeholder={strings.endpointPlaceholder}
        required
      />
      <input
        aria-label={strings.stdioArguments}
        className={INPUT}
        name="args"
        placeholder={strings.stdioArgumentsPlaceholder}
      />
    </>
  );
}
function ConnectorAuthFields({
  authType,
  onChange,
  strings,
}: {
  readonly authType: ConnectorAuthType;
  readonly onChange: (value: ConnectorAuthType) => void;
  readonly strings: ConnectorsStrings;
}) {
  return (
    <>
      {' '}
      <select
        aria-label={strings.authentication}
        className={INPUT}
        name="authType"
        value={authType}
        onChange={(event) => onChange(event.target.value as ConnectorAuthType)}
      >
        <option value="none">{strings.authType.none}</option>
        <option value="api-key">{strings.authType['api-key']}</option>
        <option value="bearer">{strings.authType.bearer}</option>
        <option value="oauth">{strings.authType.oauth}</option>
      </select>
      {authType === 'none' ? null : (
        <input
          {...CREDENTIAL_INPUT_PROPS}
          className={INPUT}
          aria-label={strings.credential}
          name="credential"
          placeholder={strings.credentialPlaceholder}
          required
          type="password"
        />
      )}
    </>
  );
}
