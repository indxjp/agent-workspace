'use client';
/**
 * One ticket with the agent panel beside it (J3). The record is fetched again each time a run of
 * the panel completes, so a change the agent made shows without a reload. The panel stays mounted
 * while the record is fetched again, so its conversation and status stay on screen.
 */
import ticket from '../resources/ticket';
import type { RecordOf } from '@indx-workspace/app';
import {
  AgentPanel,
  AppTheme,
  appStrings,
  problemMessage,
  resourceClient,
  ResourceDetail,
  ResourceProblemError,
  type AppLocale,
} from '@indx-workspace/app/react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { ApprovalStandIn } from './approval-stand-in';
import { deskWords } from './words';

type Ticket = RecordOf<typeof ticket.fields>;

export function TicketDetail({
  id,
  locale,
}: {
  readonly id: string;
  readonly locale: AppLocale;
}): ReactNode {
  const client = useMemo(() => resourceClient(ticket), []);
  const [record, setRecord] = useState<Ticket | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const words = deskWords(locale);

  const load = useCallback(() => {
    client.get(id).then(
      (found) => {
        setRecord(found);
        setProblem(null);
      },
      (error: unknown) => {
        const code = error instanceof ResourceProblemError ? error.code : 'other';
        setProblem(problemMessage(appStrings(locale), code));
      },
    );
  }, [client, id, locale]);
  useEffect(load, [load]);

  const agents = useMemo(
    () => [
      { name: 'summarise', label: words.agents.summarise },
      { name: 'triage', label: words.agents.triage },
    ],
    [words],
  );

  return (
    <AppTheme locale={locale}>
      <main>
        {record === null ? (
          <>
            <h1>{words.boardHeading}</h1>
            <p className="aw-app-status" role="status">
              {problem ?? appStrings(locale).loading}
            </p>
          </>
        ) : (
          <ResourceDetail
            resource={ticket}
            record={record}
            locale={locale}
            aside={
              <AgentPanel
                resource={ticket}
                recordId={record.id}
                agents={agents}
                locale={locale}
                onCompleted={load}
                renderApproval={(props) => <ApprovalStandIn {...props} words={words.approval} />}
              />
            }
          />
        )}
      </main>
    </AppTheme>
  );
}
