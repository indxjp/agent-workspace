'use client';
import { AppTheme, RecipeGraph, RecipeRunList, type AppLocale } from '@indx-workspace/app/react';
import type { ReactNode } from 'react';

import { deskWords } from './words';

/** The desk's recipe runs, newest first, each a link to its graph in the same language. */
export function RecipeRunsPage({ locale }: { readonly locale: AppLocale }): ReactNode {
  const query = locale === 'ja' ? '?lang=ja' : '';
  return (
    <AppTheme locale={locale}>
      <main>
        <h1>{deskWords(locale).recipesHeading}</h1>
        <RecipeRunList
          locale={locale}
          runHref={(run) => `/recipes/${encodeURIComponent(run.id)}${query}`}
        />
      </main>
    </AppTheme>
  );
}

/** One recipe run's graph, live until it stops. */
export function RecipeRunPage(props: {
  readonly locale: AppLocale;
  readonly recipeRunId: string;
}): ReactNode {
  return (
    <AppTheme locale={props.locale}>
      <main>
        <h1>{deskWords(props.locale).recipeRunHeading}</h1>
        <RecipeGraph recipeRunId={props.recipeRunId} locale={props.locale} />
      </main>
    </AppTheme>
  );
}
