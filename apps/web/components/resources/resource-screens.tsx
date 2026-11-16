'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { browserClient } from '../../lib/browser-client';
import {
  createApiKey,
  errorText,
  loadApiKeys,
  loadMe,
  probeSettings,
  revokeApiKey,
  SETTINGS_ENDPOINTS,
} from './resources-model';
import {
  deleteThenReload,
  display,
  formString,
  rowsWithStrings,
  Status,
  title,
  useJson,
} from './resource-screen-state';
import { BUTTON, CARD, INPUT } from './resource-styles';
import type { VersionsLocale } from '../agents/versions-messages';
import { japaneseRole } from '../shell/shell-messages';
import { adminStrings, type AdminStrings } from './admin-messages';

const ROLE_LABELS = {
  viewer: 'Viewer',
  builder: 'Builder',
  admin: 'Admin',
  owner: 'Owner',
} as const;

/** A role's name in the reader's language, as the sidebar's account line says it. */
function roleLabel(role: keyof typeof ROLE_LABELS, locale: VersionsLocale): string {
  return (locale === 'ja' ? japaneseRole(role) : undefined) ?? ROLE_LABELS[role];
}

/**
 * The role dropdown of the API Keys form. A key's role is capped at the caller's role
 * (`conferRole`: an admin may confer every role but owner, an owner every role), so `owner`
 * is offered only to a signed-in owner; anyone else would be refused with a 403.
 */
export function ApiKeyRoleSelect({
  callerRole,
  locale = 'en',
}: {
  callerRole: unknown;
  locale?: VersionsLocale;
}) {
  return (
    <select className={INPUT} name="role" aria-label={adminStrings(locale).keyRole}>
      <option value="viewer">{roleLabel('viewer', locale)}</option>
      <option value="builder">{roleLabel('builder', locale)}</option>
      <option value="admin">{roleLabel('admin', locale)}</option>
      {callerRole === 'owner' ? <option value="owner">{roleLabel('owner', locale)}</option> : null}
    </select>
  );
}

/**
 * One API key. A revoked key says so in place of the Revoke button (BH061-035): a disabled button
 * looked the same as a live one, so every `aw dev` start's revoked key read as still active.
 */
export function ApiKeyRow(props: {
  name: string;
  prefix: unknown;
  revoked: boolean;
  onRevoke: () => void;
  strings?: AdminStrings;
}) {
  const strings = props.strings ?? adminStrings('en');
  return (
    <div className="flex items-center gap-3 border-b border-border py-3 text-sm last:border-0">
      <span className={`flex-1 ${props.revoked ? 'text-muted' : ''}`}>
        <b>{props.name}</b> <span className="text-muted">{display(props.prefix)}</span>
      </span>
      {props.revoked ? (
        <span className="text-muted">{strings.revoked}</span>
      ) : (
        <button className={BUTTON} onClick={props.onRevoke} type="button">
          {strings.revoke}
        </button>
      )}
    </div>
  );
}

export function ApiKeysScreen({ locale = 'en' }: { readonly locale?: VersionsLocale }) {
  const strings = adminStrings(locale);
  const state = useJson(loadApiKeys);
  const me = useJson(loadMe);
  const [presented, setPresented] = useState<string | null>(null);
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const key = await createApiKey(
      browserClient(),
      formString(form, 'name'),
      formString(form, 'role'),
    );
    setPresented(key);
    element.reset();
    await state.reload();
  };
  return (
    <div lang={locale}>
      {title(strings.apiKeysTitle, strings.apiKeysIntro)}
      <Status problem={state.problem} />
      {presented ? (
        <div className={`${CARD} mb-5 border-warning`} role="status">
          <b>{strings.copyKeyNow}</b>
          <code className="mt-2 block break-all">{presented}</code>
        </div>
      ) : null}
      <form
        className={`${CARD} mb-5 flex flex-wrap gap-3`}
        onSubmit={(event) =>
          void create(event).catch((error: unknown) => state.setProblem(errorText(error)))
        }
      >
        <input
          className={INPUT}
          name="name"
          placeholder={strings.keyName}
          aria-label={strings.keyName}
          required
        />
        <ApiKeyRoleSelect callerRole={me.value?.['role']} locale={locale} />
        <button className={BUTTON}>{strings.createKey}</button>
      </form>
      <div className={CARD}>
        {rowsWithStrings(state.value, 'apiKeys', 'id', 'name').map((key) => (
          <ApiKeyRow
            key={key.id}
            name={key.name}
            prefix={key['keyPrefix']}
            revoked={key['revokedAt'] != null}
            onRevoke={() => deleteThenReload(state, (client) => revokeApiKey(client, key.id))}
            strings={strings}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The Settings heading and, for an Owner or Admin, the subsystem status card. The card probes
 * manager-only routes, so a Builder or Viewer saw raw `403`s there (UX-12 in #2086); they still
 * get the page for its Features card.
 */
export function SettingsScreen({
  managers,
  locale = 'en',
}: {
  readonly managers: boolean;
  readonly locale?: VersionsLocale;
}) {
  const strings = adminStrings(locale);
  return (
    <>
      <div lang={locale}>
        {title(
          strings.settingsTitle,
          managers ? strings.settingsManagersIntro : strings.settingsMembersIntro,
        )}
      </div>
      {managers ? <SubsystemStatus /> : null}
    </>
  );
}

function SubsystemStatus() {
  const endpoints = SETTINGS_ENDPOINTS;
  const [statuses, setStatuses] = useState<Record<string, number>>({});
  useEffect(() => {
    void probeSettings(browserClient()).then(setStatuses);
  }, []);
  return (
    <>
      <div className={CARD}>
        {endpoints.map((endpoint) => (
          <div className="flex border-b border-border py-3 text-sm last:border-0" key={endpoint}>
            <code className="flex-1">{endpoint}</code>
            <span className={statuses[endpoint] === 200 ? 'text-ok' : 'text-danger'}>
              {statuses[endpoint] ?? '…'}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

export { ConnectorNewScreen, ConnectorsScreen } from './connectors-screens';
export {
  breadcrumbSegments,
  canonicalizeFolderPath,
  emptyFolderText,
  formatModified,
  formatSize,
  moveFolderChoices,
  sortedRows,
  toFileRows,
} from './file-browser-model';
export type { FileRow } from './file-browser-model';
export { Breadcrumbs, FileTable } from './file-table';
export { FilePicker, FilesScreen } from './files-screen';
export type { FilePickerSelection } from './files-screen';
export { SkillDetailScreen, SkillsScreen, updateSkillSource } from './skills-screens';
