'use client';
import { AppTheme, Dashboard, type AppLocale } from '@indx-workspace/app/react';
import type { ReactNode } from 'react';

import { deskWords } from './words';

/** The desk's dashboard: J5's four lists, live while the page is visible. */
export function DashboardPage(props: {
  readonly locale: AppLocale;
  readonly platformUrl: string;
}): ReactNode {
  return (
    <AppTheme locale={props.locale}>
      <main>
        <h1>{deskWords(props.locale).dashboardHeading}</h1>
        <Dashboard platformUrl={props.platformUrl} locale={props.locale} />
      </main>
    </AppTheme>
  );
}
