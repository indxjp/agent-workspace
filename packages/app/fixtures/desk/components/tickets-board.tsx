'use client';
import ticket from '../resources/ticket';
import { AppTheme, ResourceBoard, type AppLocale } from '@indx-workspace/app/react';
import type { ReactNode } from 'react';

import { deskWords } from './words';

/** The tickets as a board by status, each card a link to its detail. */
export function TicketsBoard({ locale }: { readonly locale: AppLocale }): ReactNode {
  const query = locale === 'ja' ? '?lang=ja' : '';
  return (
    <AppTheme locale={locale}>
      <main>
        <h1>{deskWords(locale).boardHeading}</h1>
        <ResourceBoard
          resource={ticket}
          locale={locale}
          detailHref={(record) => `/tickets/${encodeURIComponent(record.id)}${query}`}
        />
      </main>
    </AppTheme>
  );
}
