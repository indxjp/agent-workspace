import '@indx-workspace/app/react/styles.css';
import './store.css';

import { AppTheme } from '@indx-workspace/app/react';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { LangSwitch } from './lang-switch';
import { LANG_COOKIE, langOf } from './lang';
import { theme } from './theme';
import { tr } from './text';

export const metadata = { title: 'Agent Store' };

/** The store's header on every page: logo, search, "Talk to us" and the language switch. */
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const lang = langOf((await cookies()).get(LANG_COOKIE)?.value);
  const t = tr(lang);
  return (
    <html lang={lang}>
      <body>
        <AppTheme theme={theme} locale={lang}>
          <header className="store-header">
            <a href="/" className="store-logo">
              {t('エージェントストア', 'Agent Store')}
            </a>
            <form
              role="search"
              action="/"
              method="get"
              aria-label={t('エージェントを探す', 'Find an agent')}
            >
              <input
                type="search"
                name="q"
                aria-label={t('エージェントを検索', 'Search agents')}
                placeholder={t('検索', 'Search')}
              />
            </form>
            <nav aria-label={t('サイト', 'Site')}>
              <a href="/platform">{t('安全性と仕組み', 'Safety and platform')}</a>
              <a className="aw-app-button" href="/contact">
                {t('相談する', 'Talk to us')}
              </a>
            </nav>
            <LangSwitch lang={lang} label={t('言語', 'Language')} />
          </header>
          {children}
          <footer className="store-footer">
            <a href="/privacy">{t('プライバシー通知', 'Privacy notice')}</a>
          </footer>
        </AppTheme>
      </body>
    </html>
  );
}
