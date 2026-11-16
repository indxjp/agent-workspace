'use client';
/**
 * The body of the store's visitor pages (spec "The store app"), read in the visitor's browser with
 * their own demo session, which the store's server never sees. Each page is a list of rows, or the
 * reason there is none.
 */
import { useEffect, useState } from 'react';

import { RUN_STATUSES } from '@indx-workspace/contracts/runs';
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import type { Lang } from './lang';
import { tr } from './text';
import { readAsVisitor, visitorNotice, type VisitorRead } from './visitor';

interface Row {
  readonly text: string;
  readonly href?: string;
}
export type View =
  | { readonly kind: 'runs' }
  | { readonly kind: 'run'; readonly id: string }
  | { readonly kind: 'chat'; readonly entries: readonly (Row & { readonly agent: string })[] };

/** How long a run page follows a run before it shows the status it has. */
const FOLLOW_MS = 120_000;

/** A run's status in each language, in the order of `RUN_STATUSES`. */
const JA = ['待機中', '実行中', '承認待ち', '完了', '失敗', 'キャンセル'];
const EN = ['Queued', 'Running', 'Awaiting approval', 'Completed', 'Failed', 'Cancelled'];

async function rows(client: AgentWorkspaceClient, view: View, t: ReturnType<typeof tr>) {
  if (view.kind === 'runs') {
    const { runs } = await client.runs.list({ limit: 50 });
    return runs.map((run) => ({
      text: t(`実行 ${run.id}`, `Run ${run.id}`),
      href: `/runs/${run.id}`,
    }));
  }
  if (view.kind === 'chat') {
    const agents = await client.agents.list();
    return view.entries.filter((entry) => agents.some((a) => a.name === entry.agent));
  }
  const run = await client.runs
    .waitForOutcome(view.id, { signal: AbortSignal.timeout(FOLLOW_MS) })
    .catch(() => client.runs.get(view.id));
  const i = RUN_STATUSES.indexOf(run.status);
  return [{ text: t(JA[i] ?? run.status, EN[i] ?? run.status) }];
}

export function VisitorPage({
  view,
  lang,
  platformUrl,
}: {
  readonly view: View;
  readonly lang: Lang;
  readonly platformUrl: string;
}) {
  const t = tr(lang);
  const [state, setState] = useState<VisitorRead<readonly Row[]> | null>(null);
  useEffect(() => {
    let current = true;
    void readAsVisitor(platformUrl, (client) => rows(client, view, t)).then(
      (a) => current && setState(a),
    );
    return () => {
      current = false;
    };
    // The view and language are the page's own props, which do not change for a mounted page.
  }, [platformUrl]);
  const title = view.kind === 'run' ? t(`実行 ${view.id}`, `Run ${view.id}`) : t('実行', 'Runs');
  return (
    <main>
      <h1>{view.kind === 'chat' ? t('チャット', 'Chat') : title}</h1>
      {state === null ? (
        <p role="status">{t('読み込み中…', 'Loading…')}</p>
      ) : state.kind !== 'ok' ? (
        <p role={state.kind === 'failed' ? 'alert' : 'status'}>
          {visitorNotice(state.kind, lang)} <a href="/">{t('一覧へ', 'Browse the agents')}</a>
        </p>
      ) : state.value.length === 0 ? (
        <p>{t('まだありません。', 'Nothing here yet.')}</p>
      ) : (
        <ul>
          {state.value.map((row: Row) => (
            <li key={row.text}>
              {row.href === undefined ? row.text : <a href={row.href}>{row.text}</a>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
