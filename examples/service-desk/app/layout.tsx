import '@indx-workspace/app/react/styles.css';
import { AppTheme } from '@indx-workspace/app/react';
import { PERSON_TOKEN_COOKIE } from '@indx-workspace/app/server';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { account, nav } from './nav';
import { strings } from './strings';
import { theme } from './theme';

export const metadata = { title: 'service-desk' };

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  // The cookie says only that a sign-in happened; each page asks Agent Workspace who it is.
  const signedIn = (await cookies()).has(PERSON_TOKEN_COOKIE);
  return (
    <html lang={theme.locale}>
      <body>
        <AppTheme theme={theme} locale={theme.locale}>
          <nav aria-label={strings.navLabel}>
            <ul>
              {nav.map((item) => (
                <li key={item.id}>
                  <a href={item.href}>{strings.nav[item.id]}</a>
                </li>
              ))}
              <li>
                {signedIn ? (
                  <form method="post" action={account.signOut}>
                    <button type="submit">{strings.signOut}</button>
                  </form>
                ) : (
                  <a href={account.signIn}>{strings.signIn}</a>
                )}
              </li>
            </ul>
          </nav>
          {children}
        </AppTheme>
      </body>
    </html>
  );
}
