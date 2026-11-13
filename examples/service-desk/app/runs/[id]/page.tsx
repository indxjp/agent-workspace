import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { SignInRequired, Unanswered } from '../../notices';
import { answer, personClient } from '../../portal';
import { strings } from '../../strings';

export const dynamic = 'force-dynamic';

/** A run id as the platform issues them: a UUID. Anything else is no run. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** How long the page follows a run before it shows the status it has. */
const FOLLOW_MS = 120_000;

/** The run's status once it ends, streamed in when the run ends or the follow times out. */
async function Outcome({ client, id }: { readonly client: AgentWorkspaceClient; readonly id: string }) {
  const settled = await answer(() =>
    client.runs.waitForOutcome(id, { signal: AbortSignal.timeout(FOLLOW_MS) }),
  );
  if (settled.kind !== 'ok') return <Unanswered kind={settled.kind} />;
  return (
    <p role="status">
      {strings.runStatus}: {strings.status[settled.value.status]}
    </p>
  );
}

export default async function RunPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!RUN_ID.test(id)) notFound();
  const client = await personClient();
  if (client === null) return <SignInRequired next={`/runs/${id}`} />;
  const run = await answer(() => client.runs.get(id));
  return (
    <main>
      <h1>{strings.runTitle(id)}</h1>
      {run.kind !== 'ok' ? (
        <Unanswered kind={run.kind} />
      ) : (
        <Suspense
          fallback={
            <p role="status">
              {strings.status[run.value.status]}. {strings.following}
            </p>
          }
        >
          <Outcome client={client} id={id} />
        </Suspense>
      )}
    </main>
  );
}
