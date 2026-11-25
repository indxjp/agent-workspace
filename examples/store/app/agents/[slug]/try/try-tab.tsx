'use client';
/**
 * The Try it section of a live entry (spec "How Try it works"): the sign-up gate for a visitor with no
 * session, a real chat in their demo workspace for one with a session. A guest of a demo workspace
 * counts as signed in. The visitor's session is the platform's cookie, so the probe is `GET
 * /api/me` and a `401` (or no answer) means the gate.
 */
import { useEffect, useMemo, useState } from 'react';

import { createClient } from '@indx-workspace/sdk';

import type { LiveEntry } from '../../../../catalog/define';
import { pick, type Lang } from '../../../lang';
import { DemoChat } from './demo-chat';
import { TryGate } from './gate';
import { WORDS } from './words';

type Session = 'probing' | 'signed-out' | 'signed-in';

export function TryTab({
  entry,
  lang,
  platformUrl,
}: {
  readonly entry: LiveEntry;
  readonly lang: Lang;
  readonly platformUrl: string;
}) {
  const client = useMemo(
    () => createClient({ baseUrl: platformUrl, auth: { kind: 'session' } }),
    [platformUrl],
  );
  const [session, setSession] = useState<Session>('probing');

  useEffect(() => {
    let current = true;
    client
      .me()
      .then(() => current && setSession('signed-in'))
      .catch(() => current && setSession('signed-out'));
    return () => {
      current = false;
    };
  }, [client]);

  if (session === 'probing') return <p role="status">{pick(WORDS.checking, lang)}</p>;
  return session === 'signed-in' ? (
    <DemoChat entry={entry} lang={lang} platformUrl={platformUrl} client={client} />
  ) : (
    <TryGate entry={entry} lang={lang} platformUrl={platformUrl} />
  );
}
