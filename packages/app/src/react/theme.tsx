'use client';
/**
 * `AppTheme`: the root an app's pages are themed on (ADR-0108 rungs ① and ②, issue #1508). The
 * style is the hosted surface's own `surfaceThemeStyle`, imported, so an app and its chat share
 * one theme and one set of defaults; `styles.css` reads the custom properties it sets. Its
 * language is the language of every part inside it that is given no `locale` of its own
 * (`locale-context.ts`).
 */
import type { SurfaceTheme } from '@indx-workspace/contracts/surfaces';
import { surfaceThemeStyle } from '@indx-workspace/react/theme';
import type { ReactNode } from 'react';

import { AppLocaleContext } from './locale-context.js';
import type { AppLocale } from './locale.js';

/** The props of {@link AppTheme}. */
export interface AppThemeProps {
  /** The app's theme: colour, radius, mode and density; every unset key at the surface default. */
  readonly theme?: SurfaceTheme | undefined;
  /**
   * The language of the pages inside: set as `lang` so a reader pronounces them right, and the
   * language of every part inside that is given no `locale`. `theme.locale` when not given.
   */
  readonly locale?: AppLocale | undefined;
  readonly children?: ReactNode;
}

/** The `.aw-app` root, styled by the theme. Import `@indx-workspace/app/react/styles.css` once. */
export function AppTheme({ theme, locale, children }: AppThemeProps): ReactNode {
  const language = locale ?? theme?.locale;
  return (
    <div className="aw-app" lang={language} style={surfaceThemeStyle(theme)}>
      <AppLocaleContext value={language}>{children}</AppLocaleContext>
    </div>
  );
}
