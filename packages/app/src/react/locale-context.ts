'use client';
/**
 * The page language {@link AppTheme} sets, for the parts inside it. A part's own `locale` prop
 * wins; without one a part speaks the language of the `AppTheme` around it, and `en` when there
 * is none. So an app's pages name their language once, in `app/theme.ts`, and a generated page
 * passes no locale of its own.
 */
import { createContext, useContext } from 'react';

import type { AppLocale } from './locale.js';

/** The language of the nearest `AppTheme`; `undefined` outside one. */
export const AppLocaleContext = createContext<AppLocale | undefined>(undefined);

/** The language a part speaks: `given` when set, else the nearest `AppTheme`'s, else `en`. */
export function useAppLocale(given: AppLocale | undefined): AppLocale {
  const fromTheme = useContext(AppLocaleContext);
  return given ?? fromTheme ?? 'en';
}
